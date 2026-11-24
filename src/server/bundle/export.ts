/**
 * The bundle export (CB-380): reads a snapshot of the source's database
 * (never the live file: `bundle-cli export` takes a `VACUUM INTO` copy or
 * opens a backup) and writes a bundle (format.ts) of the selected issues,
 * Spaces and pages.
 *
 * The deny-list is checked before anything is read: a selected Space on
 * it, or a selected page in such a Space, refuses the whole export. Page
 * images are opened by the caller (`readFile`, with the source's data
 * keys) and written unsealed, a file at a time, within a `ByteBudget`.
 * Attachments are read a row at a time.
 */
import type { DatabaseSync } from 'node:sqlite';

import { embedToken } from '@socio/shared/embed-card';
import { pageImageToken } from '@socio/shared/page-image';

import { BLOB_MAX_BYTES, BundleError, BundleWriter, ByteBudget } from './files.js';
import {
    BUNDLE_FORMAT,
    BUNDLE_FORMAT_VERSION,
    BUNDLE_SCHEMA_MODULES,
    type BundleManifest,
    type ImageRecord,
    type IssueRecord,
    type PageRecord,
    type SpaceRecord,
    type UserRecord,
    issueRecordSchema,
    pageRecordSchema,
    spaceRecordSchema,
} from './format.js';
import type { BundleSelection } from './selection.js';
import { embedIdsIn } from './text.js';

/** A data file's row, as the caller opens it. */
export interface SourceFile {
    id: string;
    ownerUserId: string;
    storage: string;
    size: number;
    mediaType: string;
}

export interface ExportOptions {
    /** The snapshot, opened read-only. */
    db: DatabaseSync;
    /** The bundle directory to make (it must not exist). */
    out: string;
    selection: BundleSelection;
    /** Space ids never to read. */
    deny: ReadonlySet<string>;
    source: BundleManifest['source'];
    appVersion: string;
    /** A data file's unsealed bytes; undefined when they are gone. */
    readFile(file: SourceFile): Promise<Uint8Array | undefined>;
    budget?: ByteBudget;
    now?: number;
}

export interface ExportResult {
    manifest: BundleManifest;
    warnings: string[];
}

type Row = Record<string, unknown>;

/** A record as the importer will read it: an export never writes one the import refuses. */
function checked<T>(
    schema: {
        safeParse(
            value: unknown,
        ):
            | { success: true; data: T }
            | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
    },
    record: T,
    what: string,
): T {
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new BundleError(
            `${what} can’t go in a bundle: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
        );
    }
    return parsed.data;
}
const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

/** Refuses a selection that reaches a denied Space, before anything else is read. */
export function checkDeny(db: DatabaseSync, selection: BundleSelection, deny: ReadonlySet<string>) {
    const refused: string[] = [];
    for (const id of selection.spaces) {
        if (deny.has(id)) {
            refused.push(`Space ${id} is on the deny-list.`);
        }
    }
    const spaceOf = db.prepare('SELECT spaceId FROM pages WHERE id=?');
    for (const id of selection.pages) {
        const row = spaceOf.get(id) as { spaceId: string } | undefined;
        if (row && deny.has(row.spaceId)) {
            refused.push(`Page ${id} is in Space ${row.spaceId}, which is on the deny-list.`);
        }
    }
    if (refused.length) {
        throw new BundleError(`Refused: the selection reaches a denied Space.\n  ${refused.join('\n  ')}`);
    }
}

/** The selection, resolved and checked: every id must name a live record. */
function resolve(db: DatabaseSync, selection: BundleSelection) {
    const problems: string[] = [];
    const spaces = new Map<string, Row>();
    const spaceRow = db.prepare('SELECT id, name, description, createdAt FROM spaces WHERE id=? AND deletedAt IS NULL');
    for (const id of selection.spaces) {
        const row = spaceRow.get(id) as Row | undefined;
        if (!row) {
            problems.push(`Space ${id} isn’t there (or is deleted).`);
        } else {
            spaces.set(id, row);
        }
    }
    const whole = new Set(spaces.keys());
    const pageIds = new Set<string>();
    const livePages = db.prepare('SELECT id FROM pages WHERE spaceId=? AND deletedAt IS NULL ORDER BY createdAt, id');
    for (const id of whole) {
        for (const row of livePages.all(id) as { id: string }[]) {
            pageIds.add(row.id);
        }
    }
    const pageRow = db.prepare('SELECT spaceId FROM pages WHERE id=? AND deletedAt IS NULL');
    for (const id of selection.pages) {
        const row = pageRow.get(id) as { spaceId: string } | undefined;
        if (!row) {
            problems.push(`Page ${id} isn’t there (or is deleted).`);
            continue;
        }
        pageIds.add(id);
        if (!spaces.has(row.spaceId)) {
            const space = spaceRow.get(row.spaceId) as Row | undefined;
            if (!space) {
                problems.push(`Page ${id} is in a deleted Space.`);
            } else {
                spaces.set(row.spaceId, space);
            }
        }
    }
    let numbers: number[];
    if (selection.issues === 'all') {
        numbers = (
            db.prepare('SELECT number FROM issues WHERE deletedAt IS NULL ORDER BY number').all() as {
                number: number;
            }[]
        ).map((row) => Number(row.number));
    } else {
        const live = db.prepare('SELECT 1 FROM issues WHERE number=? AND deletedAt IS NULL');
        numbers = [];
        for (const n of selection.issues) {
            if (live.get(n)) {
                numbers.push(n);
            } else {
                problems.push(`Issue ${n} isn’t there (or is deleted).`);
            }
        }
    }
    if (problems.length) {
        throw new BundleError(`The selection names records that aren’t there:\n  ${problems.join('\n  ')}`);
    }
    return { spaces, whole, pageIds, numbers };
}

/** The source's schema versions of the modules a bundle reads and writes. */
export function schemaVersions(db: DatabaseSync): Record<string, number> {
    const rows = db
        .prepare(
            `SELECT module, MAX(version) AS version FROM schema_migrations WHERE module IN (${placeholders(BUNDLE_SCHEMA_MODULES.length)}) GROUP BY module`,
        )
        .all(...BUNDLE_SCHEMA_MODULES) as { module: string; version: number }[];
    return Object.fromEntries(rows.map((row) => [row.module, Number(row.version)]));
}

/** The pages in tree order: parents (when in the bundle) before children. */
function treeOrder(db: DatabaseSync, ids: ReadonlySet<string>) {
    const parentOf = db.prepare('SELECT parentId FROM pages WHERE id=?');
    const parent = new Map<string, string | null>();
    for (const id of ids) {
        const p = (parentOf.get(id) as { parentId: string | null } | undefined)?.parentId ?? null;
        parent.set(id, p && ids.has(p) ? p : null);
    }
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen = new Set<string>()): number => {
        const known = depth.get(id);
        if (known !== undefined) {
            return known;
        }
        const p = parent.get(id);
        // A loop in the tree (never expected): the page becomes a root.
        const d = !p || seen.has(p) ? 0 : depthOf(p, seen.add(id)) + 1;
        depth.set(id, d);
        return d;
    };
    return { order: [...ids].sort((a, b) => depthOf(a) - depthOf(b)), parent };
}

/** Writes a bundle of `selection` from the snapshot `db`. */
export async function exportBundle(options: ExportOptions): Promise<ExportResult> {
    const { db, selection, deny } = options;
    const budget = options.budget ?? new ByteBudget();
    const now = options.now ?? Date.now();
    checkDeny(db, selection, deny);
    const { spaces, whole, pageIds, numbers } = resolve(db, selection);
    // The checks again, over what the selection resolved to (a Space the
    // pages pull in, too): nothing of a denied Space is read.
    for (const id of spaces.keys()) {
        if (deny.has(id)) {
            throw new BundleError(`Refused: Space ${id} is on the deny-list.`);
        }
    }
    // The images the pages show, before any is read: one of a denied Space refuses.
    const embedSpace = db.prepare('SELECT spaceId FROM media_embeds WHERE id=?');
    const pageText = db.prepare('SELECT content, coverId FROM pages WHERE id=?');
    for (const id of pageIds) {
        const row = pageText.get(id) as { content: string; coverId: string | null };
        const ids = embedIdsIn(String(row.content ?? ''), { image: pageImageToken, card: embedToken });
        for (const embedId of row.coverId ? [...ids, row.coverId] : ids) {
            const space = (embedSpace.get(embedId) as { spaceId: string } | undefined)?.spaceId;
            if (space && deny.has(space)) {
                throw new BundleError(
                    `Refused: page ${id} shows image ${embedId}, which belongs to Space ${space}, on the deny-list.`,
                );
            }
        }
    }
    const warnings: string[] = [];
    const people = new Set<string>();
    const note = (id: unknown) => {
        if (typeof id === 'string' && id) {
            people.add(id);
        }
    };
    const writer = new BundleWriter(options.out);
    const counts: Record<string, number> = {
        spaces: 0,
        pages: 0,
        images: 0,
        issues: 0,
        comments: 0,
        attachments: 0,
        votes: 0,
        events: 0,
        links: 0,
    };
    try {
        // Spaces.
        const settings = db.prepare('SELECT membersOnly FROM space_settings WHERE spaceId=?');
        const members = db.prepare('SELECT userId, role, addedAt FROM space_members WHERE spaceId=? ORDER BY userId');
        for (const [id, row] of spaces) {
            const record: SpaceRecord = {
                id,
                name: String(row.name),
                description: String(row.description ?? ''),
                createdAt: Number(row.createdAt),
                membersOnly: Number((settings.get(id) as Row | undefined)?.membersOnly ?? 0) === 1,
                members: (members.all(id) as Row[]).map((m) => {
                    note(m.userId);
                    return {
                        userId: String(m.userId),
                        role: m.role === 'editor' ? 'editor' : 'member',
                        addedAt: Number(m.addedAt),
                    };
                }),
                whole: whole.has(id),
            };
            writer.line('spaces.jsonl', checked(spaceRecordSchema, record, `Space ${id}`));
            counts.spaces!++;
        }

        // Pages, parents first, each with its images.
        const { order, parent } = treeOrder(db, pageIds);
        const pageRow = db.prepare(
            'SELECT id, spaceId, title, content, createdAt, updatedAt, createdBy, coverId, sourceUrl, sourceTitle FROM pages WHERE id=?',
        );
        const tags = db.prepare('SELECT tag, createdBy, createdAt FROM page_tags WHERE pageId=? ORDER BY tag');
        const links = db.prepare(
            'SELECT id, toPageId, kind, createdBy, createdAt FROM page_links WHERE fromPageId=? AND removedAt IS NULL ORDER BY createdAt, id',
        );
        const embed = db.prepare(
            'SELECT id, fileId, ownerUserId, spaceId, sourceUrl, createdAt FROM media_embeds WHERE id=?',
        );
        const file = db.prepare(
            'SELECT id, ownerUserId, storage, size, mediaType, name, path FROM data_files WHERE id=? AND ownerUserId=? AND deletedAt IS NULL',
        );
        const images = new Map<string, ImageRecord>();
        for (const id of order) {
            const row = pageRow.get(id) as Row;
            note(row.createdBy);
            const content = String(row.content ?? '');
            const wanted = embedIdsIn(content, { image: pageImageToken, card: embedToken });
            const coverId = str(row.coverId);
            if (coverId && !wanted.includes(coverId)) {
                wanted.push(coverId);
            }
            const pageImages: ImageRecord[] = [];
            for (const embedId of wanted) {
                const e = embed.get(embedId) as Row | undefined;
                // An image of a denied Space, named from an allowed page: refused, never read.
                if (e && deny.has(String(e.spaceId))) {
                    throw new BundleError(
                        `Refused: page ${id} shows image ${embedId}, which belongs to Space ${String(e.spaceId)}, on the deny-list.`,
                    );
                }
                // Only the page's own Space's images: one of another Space keeps
                // that Space's readers, which the target couldn't hold to.
                if (e && String(e.spaceId) !== String(row.spaceId)) {
                    warnings.push(`Page ${id}: image ${embedId} belongs to another Space; left out.`);
                    continue;
                }
                const known = images.get(embedId);
                if (known) {
                    pageImages.push(known);
                    continue;
                }
                const f = e && (file.get(String(e.fileId), String(e.ownerUserId)) as Row | undefined);
                if (!e || !f) {
                    warnings.push(`Page ${id}: image ${embedId} isn’t there; left out.`);
                    continue;
                }
                const size = Number(f.size);
                if (size > BLOB_MAX_BYTES) {
                    warnings.push(`Page ${id}: image ${embedId} is over ${BLOB_MAX_BYTES} bytes; left out.`);
                    continue;
                }
                const source: SourceFile = {
                    id: String(f.id),
                    ownerUserId: String(f.ownerUserId),
                    storage: String(f.storage),
                    size,
                    mediaType: String(f.mediaType),
                };
                // The sealed copy and the opened one, one file at a time.
                const record = await budget.hold(size * 2 + 64, async () => {
                    const bytes = await options.readFile(source);
                    if (!bytes) {
                        return undefined;
                    }
                    const sha = writer.blob(bytes);
                    return {
                        embedId,
                        sha256: sha,
                        size: bytes.length,
                        mediaType: source.mediaType,
                        name: String(f.name ?? String(f.path).split('/').pop() ?? 'image'),
                        sourceUrl: String(e.sourceUrl ?? ''),
                        createdAt: Number(e.createdAt),
                    } satisfies ImageRecord;
                });
                if (!record) {
                    warnings.push(`Page ${id}: image ${embedId}’s bytes are gone; left out.`);
                    continue;
                }
                images.set(embedId, record);
                pageImages.push(record);
                counts.images!++;
            }
            const record: PageRecord = {
                id,
                spaceId: String(row.spaceId),
                parentId: parent.get(id) ?? null,
                title: String(row.title),
                content,
                createdAt: Number(row.createdAt),
                updatedAt: Number(row.updatedAt),
                createdBy: str(row.createdBy),
                coverId: coverId && images.has(coverId) ? coverId : null,
                sourceUrl: str(row.sourceUrl),
                sourceTitle: str(row.sourceTitle),
                tags: (tags.all(id) as Row[]).map((t) => {
                    note(t.createdBy);
                    return { tag: String(t.tag), createdBy: str(t.createdBy), createdAt: Number(t.createdAt) };
                }),
                links: (links.all(id) as Row[])
                    .filter((l) => pageIds.has(String(l.toPageId)))
                    .map((l) => {
                        note(l.createdBy);
                        return {
                            id: String(l.id),
                            toPageId: String(l.toPageId),
                            kind: l.kind as PageRecord['links'][number]['kind'],
                            createdBy: str(l.createdBy),
                            createdAt: Number(l.createdAt),
                        };
                    }),
                images: pageImages,
            };
            writer.line('pages.jsonl', checked(pageRecordSchema, record, `Page ${id}`), `Page ${id}`);
            counts.pages!++;
        }

        // Issues, in number order, one at a time.
        const issueRow = db.prepare('SELECT * FROM issues WHERE number=?');
        const labels = db.prepare('SELECT label FROM issue_labels WHERE issueId=? ORDER BY label');
        const comments = db.prepare(
            'SELECT id, authorKind, authorId, body, createdAt, editedAt FROM issue_comments WHERE issueId=? AND deletedAt IS NULL ORDER BY createdAt, id',
        );
        const attachments = db.prepare(
            'SELECT id, commentId, name, mediaType, size, sha256, uploaderId, createdAt FROM issue_attachments WHERE issueId=? AND deletedAt IS NULL ORDER BY createdAt, id',
        );
        const attachmentData = db.prepare('SELECT data FROM issue_attachments WHERE id=?');
        const votes = db.prepare(
            'SELECT id, userId, createdAt FROM issue_votes WHERE issueId=? AND withdrawnAt IS NULL ORDER BY createdAt, id',
        );
        const events = db.prepare(
            'SELECT id, actorId, kind, fromValue, toValue, createdAt FROM issue_events WHERE issueId=? ORDER BY seq, createdAt, id',
        );
        const linkRows = db.prepare(
            `SELECT l.id, 'blocked_by' AS kind, l.fromId, f.number AS fromNumber, l.toId, t.number AS toNumber, l.createdBy, l.createdAt
             FROM issue_links l JOIN issues f ON f.id=l.fromId JOIN issues t ON t.id=l.toId
             WHERE (l.fromId=?1 OR l.toId=?1) AND l.removedAt IS NULL AND f.deletedAt IS NULL AND t.deletedAt IS NULL
             UNION ALL
             SELECT r.id, 'related' AS kind, r.fromId, f.number, r.toId, t.number, r.createdBy, r.createdAt
             FROM issue_relations r JOIN issues f ON f.id=r.fromId JOIN issues t ON t.id=r.toId
             WHERE (r.fromId=?1 OR r.toId=?1) AND r.removedAt IS NULL AND f.deletedAt IS NULL AND t.deletedAt IS NULL
             ORDER BY 8, 1`,
        );
        for (const n of numbers) {
            const row = issueRow.get(n) as Row;
            const id = String(row.id);
            note(row.reporterId);
            note(row.assigneeId);
            const record: IssueRecord = {
                id,
                number: Number(row.number),
                title: String(row.title),
                body: String(row.body ?? ''),
                status: row.status as IssueRecord['status'],
                priority: row.priority as IssueRecord['priority'],
                kind: row.kind as IssueRecord['kind'],
                area: str(row.area),
                reporterId: String(row.reporterId),
                assigneeId: str(row.assigneeId),
                resolution: str(row.resolution),
                createdAt: Number(row.createdAt),
                updatedAt: Number(row.updatedAt),
                closedAt: num(row.closedAt),
                labels: (labels.all(id) as Row[]).map((l) => String(l.label)),
                comments: (comments.all(id) as Row[]).map((c) => {
                    note(c.authorId);
                    return {
                        id: String(c.id),
                        authorKind: c.authorKind as IssueRecord['comments'][number]['authorKind'],
                        authorId: str(c.authorId),
                        body: String(c.body ?? ''),
                        createdAt: Number(c.createdAt),
                        editedAt: num(c.editedAt),
                    };
                }),
                attachments: [],
                votes: (votes.all(id) as Row[]).map((v) => {
                    note(v.userId);
                    return { id: String(v.id), userId: String(v.userId), createdAt: Number(v.createdAt) };
                }),
                events: (events.all(id) as Row[]).map((e) => {
                    note(e.actorId);
                    return {
                        id: String(e.id),
                        actorId: str(e.actorId),
                        kind: String(e.kind),
                        fromValue: str(e.fromValue),
                        toValue: str(e.toValue),
                        createdAt: Number(e.createdAt),
                    };
                }),
                links: (linkRows.all(id) as Row[]).map((l) => {
                    note(l.createdBy);
                    return {
                        id: String(l.id),
                        kind: l.kind as 'blocked_by' | 'related',
                        fromId: String(l.fromId),
                        fromNumber: Number(l.fromNumber),
                        toId: String(l.toId),
                        toNumber: Number(l.toNumber),
                        createdBy: String(l.createdBy),
                        createdAt: Number(l.createdAt),
                    };
                }),
            };
            // A comment's attachment whose comment is gone goes with it.
            const liveComments = new Set(record.comments.map((c) => c.id));
            for (const a of attachments.all(id) as Row[]) {
                const commentId = str(a.commentId);
                if (commentId && !liveComments.has(commentId)) {
                    continue;
                }
                const size = Number(a.size);
                if (size > BLOB_MAX_BYTES) {
                    warnings.push(`CB-${n}: attachment ${String(a.name)} is too large; left out.`);
                    continue;
                }
                note(a.uploaderId);
                // One attachment's bytes at a time.
                const sha = await budget.hold(size + 64, () => {
                    const data = (attachmentData.get(String(a.id)) as { data: Uint8Array }).data;
                    return writer.blob(data, String(a.sha256));
                });
                record.attachments.push({
                    id: String(a.id),
                    commentId,
                    name: String(a.name),
                    mediaType: String(a.mediaType),
                    size,
                    sha256: sha,
                    uploaderId: String(a.uploaderId),
                    createdAt: Number(a.createdAt),
                });
            }
            writer.line('issues.jsonl', checked(issueRecordSchema, record, `CB-${n}`), `CB-${n}, with its comments,`);
            counts.issues!++;
            counts.comments! += record.comments.length;
            counts.attachments! += record.attachments.length;
            counts.votes! += record.votes.length;
            counts.events! += record.events.length;
            counts.links! += record.links.length;
        }

        writer.users(usersOf(db, people));
        const manifest = writer.finish({
            format: BUNDLE_FORMAT,
            formatVersion: BUNDLE_FORMAT_VERSION,
            createdAt: now,
            appVersion: options.appVersion,
            source: options.source,
            schema: schemaVersions(db),
            selection: {
                issues: numbers,
                spaces: [...whole],
                pages: [...selection.pages],
            },
            counts,
        });
        return { manifest, warnings };
    } catch (error) {
        writer.abort();
        throw error;
    }
}

/**
 * The people and socios the records name, for author mapping on the
 * target: a person's display name and email, a socio's name. Ids that
 * name neither (`import`, `triage`, `cli`) are left out.
 */
function usersOf(db: DatabaseSync, ids: ReadonlySet<string>): UserRecord[] {
    const person = db.prepare(
        'SELECT u.id, u.name, (SELECT a.email FROM auth_user a WHERE a.appUserId=u.id LIMIT 1) AS email FROM users u WHERE u.id=?',
    );
    const socio = db.prepare('SELECT id, name FROM dots WHERE id=?');
    const out: UserRecord[] = [];
    for (const id of [...ids].sort()) {
        const p = person.get(id) as Row | undefined;
        if (p) {
            out.push({ id, name: String(p.name), email: str(p.email), kind: 'person' });
            continue;
        }
        const dotId = id.startsWith('dot:') ? id.slice(4) : id;
        const s = socio.get(dotId) as Row | undefined;
        if (s) {
            out.push({ id, name: String(s.name), email: null, kind: 'socio' });
        }
    }
    return out;
}
