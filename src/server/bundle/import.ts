/**
 * The bundle import (CB-380): writes a bundle (format.ts) into this
 * workspace, or, by default, only says what it would do (the dry run).
 *
 * - Ids, issue numbers and timestamps are kept; a new issue whose number a
 *   live issue filed here holds takes the next free number instead (unless
 *   `keepNumbersStrict`), and text names it by that number. Issues are written with
 *   `source='import'`, straight into their tables: no board event fires,
 *   so nothing notifies anyone, auto-triage skips them, and no model is
 *   asked anything. It writes only the tables in `IMPORT_TABLES`, and
 *   removes only an issue deleted here that blocks a bundle issue's number
 *   (replace.ts), with that issue's own rows.
 * - People are mapped by email. Anyone unmapped (and every socio) is
 *   written as the `import` pseudo-actor, with a byline in the text:
 *   "Originally by <name> on <source>, <date>."
 * - Text is rewritten (text.ts): mentions of issues that weren't copied
 *   point at the source; code is left alone.
 * - Page images are sealed again with this server's keys (file-sink.ts).
 * - Applying writes in chunks, one transaction each, and yields between
 *   them, so a running server keeps answering. It refuses without a
 *   backup newer than 15 minutes and takes its own copy of the database
 *   first.
 * - It is idempotent: `import_map` records what each record was when the
 *   import wrote it. A record nobody here touched since is updated from a
 *   newer bundle; one edited or deleted here is left alone (edits here
 *   win) and reported as a conflict.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { pageText } from '@socio/shared/pages/page-text';

import type { FileSink } from './file-sink.js';
import { BundleError, ByteBudget, type BundleReader } from './files.js';
import {
    BUNDLE_SCHEMA_MODULES,
    issueRecordSchema,
    pageRecordSchema,
    spaceRecordSchema,
    type SpaceRecord,
    type UserRecord,
} from './format.js';
import { removeIssue, replaceableAt, type Replaceable } from './replace.js';
import { rewriteText, sensitiveHits, type RewriteContext, type SensitiveHit, type TextChange } from './text.js';

/** Every table an import writes. Nothing else changes (tests hold it to this). */
export const IMPORT_TABLES = [
    'import_runs',
    'import_map',
    'spaces',
    'space_settings',
    'space_members',
    'pages',
    'page_revisions',
    'page_search',
    'page_tags',
    'page_links',
    'media_embeds',
    'data_files',
    'issues',
    'issue_counter',
    'issue_labels',
    'issue_comments',
    'issue_attachments',
    'issue_votes',
    'issue_events',
    'issue_links',
    'issue_relations',
    'issue_watch_members',
] as const;

/** How old the newest backup may be when an import is applied. */
export const BACKUP_MAX_AGE_MS = 15 * 60_000;
/** The pseudo-actor imported records name when their author isn't here. */
export const IMPORT_ACTOR = 'import';
/** Authors kept as they are: pseudo-actors every workspace has. */
const PSEUDO_ACTORS = new Set(['import', 'triage', 'cli']);

export type Action = 'create' | 'update' | 'unchanged' | 'conflict' | 'skip';

export interface ImportSafety {
    /** When the newest full backup finished (BACKUP_DIR/backup-status.json). */
    lastBackupAt(): number | undefined;
    /** Copies the database before the first write; resolves the copy's path. */
    snapshot(): Promise<string>;
    maxAgeMs?: number;
}

export interface ImportOptions {
    db: DatabaseSync;
    bundle: BundleReader;
    /** Write it; the default is a dry run that writes nothing. */
    apply?: boolean;
    /** Who runs it: recorded on the run, and the owner of imported image files. */
    operatorId: string;
    files: FileSink;
    /** Pages of a source Space go into an existing Space here (`source=target`). */
    spaceMap?: Readonly<Record<string, string>>;
    /** More words to list in the review of sensitive details. */
    terms?: readonly string[];
    /** Required to apply. */
    safety?: ImportSafety;
    /** Records per transaction; 25. */
    chunkSize?: number;
    /** File bytes per transaction; 32 MB. */
    chunkBytes?: number;
    budget?: ByteBudget;
    now?: () => number;
    /** Between transactions: lets a running server answer (setImmediate by default). */
    pause?: () => Promise<void>;
    /**
     * The old rule for a number another issue holds here: a conflict, never
     * a renumbering (`--keep-numbers-strict`). Off by default: such an issue
     * takes the next free number here.
     */
    keepNumbersStrict?: boolean;
    /** How it was started, for `import_runs.via`: the web, the live CLI channel, or offline. */
    via?: 'web' | 'cli' | 'offline';
}

export interface Conflict {
    kind: string;
    id: string;
    reason: string;
}

export interface ImportReport {
    apply: boolean;
    runId?: string;
    backupPath?: string;
    bundle: { sha256: string; origin: string; label: string; createdAt: number; appVersion: string };
    /** Per kind of record, per action. */
    counts: Record<string, Partial<Record<Action, number>>>;
    numbers: { kept: number; taken: number[] };
    /**
     * Issues deleted here, filed here (not imported), whose numbers bundle
     * issues take: removed for good, with all their rows, as the import starts.
     */
    replaced: Array<{ issue: string; deletedAt: number }>;
    /**
     * New bundle issues whose number a live, unrelated issue holds here:
     * created under the next free number instead (`to`). In a dry run, the
     * numbers they would take now; an issue filed here before applying
     * moves them on.
     */
    renumbered: Array<{ issue: string; to: string }>;
    authors: {
        mapped: Array<{ name: string; records: number }>;
        unmapped: Array<{ name: string; kind: string; records: number }>;
        /**
         * Source people whose email matches an account here that hasn't
         * verified it: not mapped (a byline, no membership, no vote).
         */
        unverified: Array<{ name: string; records: number }>;
    };
    notCopied: { issues: number[]; pages: string[] };
    rewrites: { total: number; samples: Array<TextChange & { where: string }> };
    bytes: { attachments: number; images: number };
    conflicts: Conflict[];
    sensitive: { total: number; hits: Array<SensitiveHit & { where: string }> };
    warnings: string[];
}

const SAMPLE_LIMIT = 50;
const HIT_LIMIT = 2000;
const CONFLICT_LIMIT = 2000;

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
type Row = Record<string, unknown>;

/** The target's schema versions of the modules a bundle reads and writes. */
function targetSchema(db: DatabaseSync) {
    const rows = db
        .prepare(
            `SELECT module, MAX(version) AS version FROM schema_migrations WHERE module IN (${BUNDLE_SCHEMA_MODULES.map(() => '?').join(',')}) GROUP BY module`,
        )
        .all(...BUNDLE_SCHEMA_MODULES) as { module: string; version: number }[];
    return Object.fromEntries(rows.map((row) => [row.module, Number(row.version)]));
}

/** Imports (or plans) a bundle. Resolves the report either way. */
export async function importBundle(options: ImportOptions): Promise<ImportReport> {
    const { db, bundle } = options;
    const apply = options.apply ?? false;
    const now = options.now ?? Date.now;
    const budget = options.budget ?? new ByteBudget();
    const chunkSize = options.chunkSize ?? 25;
    const chunkBytes = options.chunkBytes ?? 32 * 1024 * 1024;
    const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    const { manifest } = bundle;
    const { origin, label, issuePrefix: prefix } = manifest.source;
    const startedAt = now();

    // The schema must match: the bundle's columns and values are the source's.
    const here = targetSchema(db);
    const differs = BUNDLE_SCHEMA_MODULES.filter((module) => (manifest.schema[module] ?? -1) !== (here[module] ?? -1));
    if (differs.length) {
        throw new BundleError(
            `The bundle comes from another schema (${differs.map((m) => `${m} ${manifest.schema[m] ?? 'none'} there, ${here[m] ?? 'none'} here`).join('; ')}). Export and import with the same Socio release.`,
        );
    }
    const spaceMap = options.spaceMap ?? {};
    for (const [from, to] of Object.entries(spaceMap)) {
        if (!db.prepare('SELECT 1 FROM spaces WHERE id=? AND deletedAt IS NULL').get(to)) {
            throw new BundleError(`--space-map ${from}=${to}: there is no live Space ${to} here.`);
        }
    }

    const report: ImportReport = {
        apply,
        bundle: {
            sha256: bundle.sha256,
            origin,
            label,
            createdAt: manifest.createdAt,
            appVersion: manifest.appVersion,
        },
        counts: {},
        numbers: { kept: 0, taken: [] },
        replaced: [],
        renumbered: [],
        authors: { mapped: [], unmapped: [], unverified: [] },
        notCopied: { issues: [], pages: [] },
        rewrites: { total: 0, samples: [] },
        bytes: { attachments: 0, images: 0 },
        conflicts: [],
        sensitive: { total: 0, hits: [] },
        warnings: [],
    };
    const count = (kind: string, action: Action) => {
        const entry = (report.counts[kind] ??= {});
        entry[action] = (entry[action] ?? 0) + 1;
    };
    const conflict = (kind: string, id: string, reason: string) => {
        if (report.conflicts.length < CONFLICT_LIMIT) {
            report.conflicts.push({ kind, id, reason });
        }
    };

    // ── People ────────────────────────────────────────────────────────
    const users = new Map<string, UserRecord>(bundle.users().map((user) => [user.id, user]));
    // People are matched only to accounts whose email is verified, the
    // trust sign-in gives an email (`emailVerified`: an admin made the
    // account, or the sign-in provider vouched for the address; rules.ts).
    // Anyone could sign up with someone else's address and leave it
    // unverified: matching it would hand them memberships and votes.
    const byEmail = new Map<string, string>();
    const unverifiedEmails = new Set<string>();
    for (const row of db
        .prepare(
            'SELECT a.email, a.appUserId, a.emailVerified FROM auth_user a JOIN users u ON u.id = a.appUserId WHERE a.email IS NOT NULL',
        )
        .all() as { email: string; appUserId: string; emailVerified: number }[]) {
        const email = row.email.trim().toLowerCase();
        if (Number(row.emailVerified) === 1) {
            byEmail.set(email, row.appUserId);
        } else {
            unverifiedEmails.add(email);
        }
    }
    const mapped = new Map<string, string>();
    const unverified = new Set<string>();
    for (const user of users.values()) {
        const email = user.kind === 'person' && user.email ? user.email.trim().toLowerCase() : undefined;
        const target = email && byEmail.get(email);
        if (target) {
            mapped.set(user.id, target);
        } else if (email && unverifiedEmails.has(email)) {
            unverified.add(user.id);
        }
    }
    const authorUse = new Map<string, number>();
    /** A source person the records name (author, member, voter), for the report. */
    const noteUse = (id: string) => authorUse.set(id, (authorUse.get(id) ?? 0) + 1);
    /** A source author as this workspace names it, and the byline its text needs. */
    const author = (id: string | null | undefined): { id: string | null; byline: string | null; mapped: boolean } => {
        if (!id) {
            return { id: null, byline: null, mapped: false };
        }
        noteUse(id);
        const target = mapped.get(id);
        if (target) {
            return { id: target, byline: null, mapped: true };
        }
        if (PSEUDO_ACTORS.has(id)) {
            return { id, byline: null, mapped: false };
        }
        const user = users.get(id);
        return {
            id: IMPORT_ACTOR,
            byline: !user ? `a ${label} member` : user.kind === 'socio' ? `socio ${user.name}` : user.name,
            mapped: false,
        };
    };
    const bylined = (who: string | null, at: number, text: string, verb = 'Originally by') =>
        who ? `_${verb} ${who} on ${label}, ${day(at)}._\n\n${text}` : text;

    // ── Pass 1: what the bundle holds, and where it goes ──────────────────
    const spaces: SpaceRecord[] = [];
    for await (const space of bundle.records('spaces.jsonl', spaceRecordSchema)) {
        spaces.push(space);
    }
    const mapRow = db.prepare('SELECT targetId, hash FROM import_map WHERE sourceOrigin=? AND kind=? AND sourceId=?');
    const mapOf = (kind: string, id: string) =>
        mapRow.get(origin, kind, id) as { targetId: string; hash: string } | undefined;

    /** The Space here that each source Space's pages go to; none: they are skipped. */
    const spaceTarget = new Map<string, string>();
    const spaceRow = db.prepare('SELECT name, description, deletedAt FROM spaces WHERE id=?');
    const settingsRow = db.prepare('SELECT membersOnly FROM space_settings WHERE spaceId=?');
    /** Whether a Space here is read by its members only. */
    const privateHere = (id: string) => Number((settingsRow.get(id) as Row | undefined)?.membersOnly ?? 0) === 1;
    const spaceHash = (name: unknown, description: unknown, membersOnly: boolean) =>
        hashOf({ name, description, membersOnly });
    /** Source Spaces read by their members only: their pages never go into a Space here that isn't. */
    const sourcePrivate = new Set(spaces.filter((space) => space.membersOnly).map((space) => space.id));
    for (const space of spaces) {
        const mappedTo = spaceMap[space.id];
        const row = spaceRow.get(space.id) as Row | undefined;
        const ours = mapOf('space', space.id);
        let target: string | undefined;
        let privateAfter = false;
        if (mappedTo) {
            target = mappedTo;
            privateAfter = privateHere(mappedTo);
        } else if (!row && !ours) {
            // New here. (Remembered but gone: removed here for good, never recreated.)
            target = space.id;
            privateAfter = space.membersOnly;
        } else if (row && ours && row.deletedAt === null) {
            target = space.id;
            // Unedited here: the import sets the source's setting; edited: it stays as it is here.
            const unedited = spaceHash(row.name, row.description, privateHere(space.id)) === ours.hash;
            privateAfter = unedited ? space.membersOnly : privateHere(space.id);
        }
        if (target && space.membersOnly && !privateAfter) {
            conflict('space', space.id, 'members-only at the source, open to everyone here: its pages are skipped');
            report.warnings.push(
                `Space ${space.name} is members-only at the source but not here: its pages are skipped. Make the Space here members-only (or map it to one that is), then import again.`,
            );
            continue;
        }
        if (target) {
            spaceTarget.set(space.id, target);
        }
    }
    /** Pages that will be here after the import: their Space here. */
    const placed = new Map<string, string>();
    const pageAt = db.prepare('SELECT spaceId, deletedAt FROM pages WHERE id=?');
    const pageSpaces = new Map<string, string>();
    const embedAt = db.prepare('SELECT 1 FROM media_embeds WHERE id=?');
    /** An image's file here, while that file is live (deleting it from Files removes the image). */
    const embedFile = db.prepare(
        'SELECT e.fileId, e.spaceId, f.createdAt, f.updatedAt FROM media_embeds e JOIN data_files f ON f.id = e.fileId AND f.ownerUserId = e.ownerUserId WHERE e.id=? AND f.deletedAt IS NULL',
    );
    /** Pages left out: an image of theirs has an id another image has here. */
    const imageClash = new Map<string, string>();
    for await (const page of bundle.records('pages.jsonl', pageRecordSchema)) {
        pageSpaces.set(page.id, page.spaceId);
        const target = spaceTarget.get(page.spaceId);
        if (!target) {
            continue;
        }
        const row = pageAt.get(page.id) as Row | undefined;
        const ours = mapOf('page', page.id);
        // An image id that is someone else's here: the page would show that image instead.
        const clash = page.images.find((image) => !mapOf('embed', image.embedId) && embedAt.get(image.embedId));
        if (clash) {
            imageClash.set(page.id, clash.embedId);
            continue;
        }
        if ((!row && !ours) || (row && ours && row.deletedAt === null && row.spaceId === target)) {
            placed.set(page.id, target);
        }
    }
    /** Issues the bundle holds that are (or will be) here under their own number. */
    const copiedNumbers = new Set<number>();
    const copiedIds = new Set<string>();
    const byNumber = db.prepare('SELECT id FROM issues WHERE number=?');
    const byId = db.prepare('SELECT number, deletedAt FROM issues WHERE id=?');
    const bundleIssueIds = new Set<string>();
    for await (const issue of bundle.records('issues.jsonl', issueRecordSchema)) {
        bundleIssueIds.add(issue.id);
    }
    /** Deleted issues here (filed here) that bundle issues replace, by number. */
    const replacing = new Map<number, Replaceable>();
    /**
     * Bundle issues here (or to be) under another number than the source's:
     * source number to number here. Renumbered by an earlier import, or now
     * (`renumbering`; their numbers are set as the import starts).
     */
    const renumbered = new Map<number, number>();
    /** Bundle issues renumbered by this run, in bundle order. */
    const renumbering: Array<{ number: number; id: string }> = [];
    /** An earlier import's renumbering of a source issue: its number here. */
    const numberHere = (id: string) => {
        const row = mapOf('issue_number', id);
        return row ? Number(row.targetId) : undefined;
    };
    const holderRow = db.prepare('SELECT id, source, deletedAt FROM issues WHERE number=?');
    const importedCopy = db.prepare("SELECT 1 FROM import_map WHERE kind='issue' AND targetId=? LIMIT 1");
    const renumberedTo = db.prepare(
        "SELECT sourceId FROM import_map WHERE sourceOrigin=? AND kind='issue_number' AND targetId=?",
    );
    /**
     * Whether a bundle issue new here may take another number because the
     * issue holding its number here is certainly another one: a live issue
     * filed here (never an import's copy, from any source), or this
     * source's own issue that an earlier import renumbered to it. Any other
     * holder (a copy another import brought, or this source's copy kept
     * under that number) may be the same issue: it stays a conflict.
     */
    const renumberable = (number: number) => {
        const row = holderRow.get(number) as { id: string; source: string; deletedAt: number | null } | undefined;
        if (!row) {
            return false;
        }
        const ours = renumberedTo.get(origin, String(number)) as { sourceId: string } | undefined;
        if (ours?.sourceId === row.id) {
            return true;
        }
        return (
            row.deletedAt === null &&
            row.source !== 'import' &&
            !bundleIssueIds.has(row.id) &&
            !importedCopy.get(row.id)
        );
    };
    /** Whether the issue at `number` is still the deleted one planned to be replaced. */
    const stillReplaceable = (number: number) => {
        const planned = replacing.get(number);
        return !!planned && replaceableAt(db, number, bundleIssueIds)?.id === planned.id;
    };
    for await (const issue of bundle.records('issues.jsonl', issueRecordSchema)) {
        const atNumber = byNumber.get(issue.number) as { id: string } | undefined;
        const atId = byId.get(issue.id) as { number: number; deletedAt: number | null } | undefined;
        const earlier = atId && mapOf('issue', issue.id) ? numberHere(issue.id) : undefined;
        if (earlier !== undefined && earlier === Number(atId!.number) && earlier !== issue.number) {
            // Renumbered by an earlier import: the same issue, under its number here.
            if (atId!.deletedAt !== null) {
                count('issue', 'skip');
                continue;
            }
            renumbered.set(issue.number, earlier);
            copiedIds.add(issue.id);
            continue;
        }
        // The number is held by an issue deleted here that was filed here: replaced.
        const replace =
            atNumber && atNumber.id !== issue.id && !atId && !mapOf('issue', issue.id)
                ? replaceableAt(db, issue.number, bundleIssueIds)
                : undefined;
        // The number is another issue's here: this one takes the next free number.
        if (
            !options.keepNumbersStrict &&
            atNumber &&
            atNumber.id !== issue.id &&
            !replace &&
            !atId &&
            !mapOf('issue', issue.id) &&
            renumberable(issue.number)
        ) {
            renumbering.push({ number: issue.number, id: issue.id });
            copiedIds.add(issue.id);
            continue;
        }
        if ((atNumber && atNumber.id !== issue.id && !replace) || (atId && Number(atId.number) !== issue.number)) {
            report.numbers.taken.push(issue.number);
            conflict('issue', `${prefix}-${issue.number}`, 'its number or id is another issue’s here');
            count('issue', 'conflict');
            continue;
        }
        if (atId && !mapOf('issue', issue.id)) {
            // The same issue, but not brought here by an import from this
            // source (a workspace restored from the same database): it is
            // left as it is, and nothing is added to it.
            report.numbers.taken.push(issue.number);
            conflict('issue', `${prefix}-${issue.number}`, 'already here, not from this source');
            count('issue', 'conflict');
            continue;
        }
        if ((atId && atId.deletedAt !== null) || (!atId && mapOf('issue', issue.id))) {
            // Imported, then deleted here (or removed for good): it stays
            // gone, and mentions of it point at the source.
            count('issue', 'skip');
            continue;
        }
        if (replace) {
            replacing.set(issue.number, replace);
            report.replaced.push({ issue: `${prefix}-${issue.number}`, deletedAt: replace.deletedAt });
        }
        copiedNumbers.add(issue.number);
        copiedIds.add(issue.id);
    }
    report.numbers.kept = copiedNumbers.size;
    const counterRow = db.prepare('SELECT last FROM issue_counter WHERE id = 1');
    const highestRow = db.prepare('SELECT MAX(number) AS number FROM issues');
    /**
     * The numbers this run's renumbered issues take: the next free ones, past
     * the counter, every number here and every number the bundle keeps (as
     * filing an issue here picks it). Run in the transaction that starts the
     * import, which also moves the counter past them, so an issue filed here
     * meanwhile takes a later number; in a dry run, what they would be now.
     */
    const numberRenumbered = () => {
        let next = Math.max(
            Number((counterRow.get() as { last: number } | undefined)?.last ?? 0),
            Number((highestRow.get() as { number: number | null }).number ?? 0),
            0,
            ...copiedNumbers,
        );
        report.renumbered = [];
        for (const planned of renumbering) {
            next++;
            renumbered.set(planned.number, next);
            report.renumbered.push({ issue: `${prefix}-${planned.number}`, to: `${prefix}-${next}` });
        }
        return next;
    };
    numberRenumbered();

    const missingIssues = new Set<number>();
    const missingPages = new Set<string>();
    const context: RewriteContext = {
        origin,
        label,
        prefix,
        issue: (n) => {
            if (copiedNumbers.has(n)) {
                return n;
            }
            const here = renumbered.get(n);
            if (here === undefined) {
                missingIssues.add(n);
            }
            return here;
        },
        page: (spaceId, pageId) => {
            const target = placed.get(pageId);
            if (!target || pageSpaces.get(pageId) !== spaceId) {
                missingPages.add(pageId);
                return undefined;
            }
            return { spaceId: target, pageId };
        },
        space: (spaceId) => {
            const space = spaces.find((s) => s.id === spaceId);
            return space?.whole ? spaceTarget.get(spaceId) : undefined;
        },
    };
    const rewrite = (where: string, text: string) => {
        const result = rewriteText(text, context);
        report.rewrites.total += result.changes.length;
        for (const change of result.changes) {
            if (report.rewrites.samples.length < SAMPLE_LIMIT) {
                report.rewrites.samples.push({ ...change, where });
            }
        }
        return result.text;
    };
    const scan = (where: string, text: string) => {
        for (const hit of sensitiveHits(text, options.terms)) {
            report.sensitive.total++;
            if (report.sensitive.hits.length < HIT_LIMIT) {
                report.sensitive.hits.push({ ...hit, where });
            }
        }
    };

    // ── The run: chunks of writes, applied or thrown away ──────────────────
    let runId: string | undefined;
    if (apply) {
        const safety = options.safety;
        if (!safety) {
            throw new BundleError('Applying an import needs the backup check.');
        }
        const last = safety.lastBackupAt();
        const maxAge = safety.maxAgeMs ?? BACKUP_MAX_AGE_MS;
        if (!last || startedAt - last > maxAge) {
            throw new BundleError(
                `Refused: no full backup in the last ${Math.round(maxAge / 60_000)} minutes. Run the backup (backup-cli) first, then apply.`,
            );
        }
        report.backupPath = await safety.snapshot();
        runId = randomUUID();
        report.runId = runId;
        await transaction(db, 'start bundle import', () => {
            // The numbers the plan keeps must still be free (or this bundle's):
            // an issue filed here meanwhile would make its mentions point at it.
            const taken = [...copiedNumbers].filter((n) => {
                const row = byNumber.get(n) as { id: string } | undefined;
                return row && !copiedIds.has(row.id) && !stillReplaceable(n);
            });
            if (taken.length) {
                throw new BundleError(
                    `Issues ${taken.map((n) => `${prefix}-${n}`).join(', ')} were filed here while the import prepared. Nothing was written: run it again.`,
                );
            }
            // Deleted issues (filed here) whose numbers bundle issues take go now,
            // for good, before any record is written: text that names those
            // numbers can then only ever mean the bundle's issues.
            for (const planned of replacing.values()) {
                removeIssue(db, planned.id, now());
            }
            // Reserved: issues filed here from now on take numbers after the
            // bundle's, and after the renumbered issues' (set now, before any
            // text that names them is written).
            const highest = Math.max(0, ...copiedNumbers, numberRenumbered());
            db.prepare('UPDATE issue_counter SET last = CASE WHEN last < ? THEN ? ELSE last END WHERE id = 1').run(
                highest,
                highest,
            );
            db.prepare(
                'INSERT INTO import_runs(id, bundleSha256, sourceOrigin, startedBy, startedAt, backupPath, via) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(
                runId!,
                bundle.sha256,
                origin,
                options.operatorId,
                startedAt,
                report.backupPath ?? null,
                options.via ?? null,
            );
        });
    }
    const ops: Array<() => void> = [];
    let records = 0;
    let bytes = 0;
    const flush = async () => {
        if (apply && ops.length) {
            await transaction(db, 'import bundle', () => {
                for (const op of ops) {
                    op();
                }
            });
            await pause();
        }
        ops.length = 0;
        records = 0;
        bytes = 0;
    };
    const record = async (extraBytes = 0) => {
        records++;
        bytes += extraBytes;
        if (records >= chunkSize || bytes >= chunkBytes) {
            await flush();
        }
    };
    // Write statements are prepared inside the import's own transactions
    // (on first use): the connection's guard checks a write when it is
    // prepared, and another unit of work may be open outside them.
    const lazy = (sql: string) => {
        let statement: ReturnType<DatabaseSync['prepare']> | undefined;
        return { run: (...values: SQLInputValue[]) => (statement ??= db.prepare(sql)).run(...values) };
    };
    const putMap = lazy(
        `INSERT INTO import_map(sourceOrigin, kind, sourceId, targetId, hash, runId, importedAt) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sourceOrigin, kind, sourceId) DO UPDATE SET targetId=excluded.targetId, hash=excluded.hash, runId=excluded.runId, importedAt=excluded.importedAt`,
    );
    const remember = (kind: string, sourceId: string, targetId: string, hash = '') =>
        ops.push(() => putMap.run(origin, kind, sourceId, targetId, hash, runId!, now()));

    /**
     * What to do with an editable record: create it, update it from the
     * bundle, or leave it (unchanged, edited or deleted here, or someone
     * else's record under the same id).
     */
    const decide = (
        kind: string,
        id: string,
        current: { hash: string; deleted: boolean } | undefined,
        desired: string,
    ): Action => {
        const known = mapOf(kind, id);
        let action: Action;
        if (!known) {
            action = current ? 'conflict' : 'create';
            if (current) {
                conflict(kind, id, 'already here, not from this source');
            }
        } else if (!current || current.deleted) {
            action = 'skip';
        } else if (current.hash !== known.hash) {
            action = 'conflict';
            conflict(kind, id, 'edited here since it was imported');
        } else {
            action = desired === known.hash ? 'unchanged' : 'update';
        }
        count(kind, action);
        return action;
    };
    /** For records that are never edited: add once, never again. */
    const additive = (kind: string, id: string, exists: boolean): boolean => {
        if (mapOf(kind, id)) {
            count(kind, 'unchanged');
            return false;
        }
        if (exists) {
            count(kind, 'unchanged');
            return false;
        }
        count(kind, 'create');
        return true;
    };
    /**
     * A planned write of an editable record, run in its chunk's
     * transaction only if the record is still as it was when planned
     * (`planned`: its hash then, or undefined when it wasn't there), and
     * `also` holds. Else nothing of it is written and it is a conflict:
     * someone here changed it while the import ran, and edits here win.
     */
    const guarded = (
        kind: string,
        id: string,
        action: 'create' | 'update',
        current: () => string | undefined,
        planned: string | undefined,
        hash: string,
        write: () => void,
        also?: () => string | undefined,
    ) =>
        ops.push(() => {
            const refusal = current() !== planned ? 'changed here while the import ran' : (also?.() ?? undefined);
            if (refusal) {
                refuse(kind, id, action, refusal);
                return;
            }
            write();
            putMap.run(origin, kind, id, id, hash, runId!, now());
        });
    /** A planned write that didn't happen as it committed: a conflict, not what was planned. */
    const refuse = (kind: string, id: string, action: Action, reason: string) => {
        const entry = report.counts[kind]!;
        entry[action] = (entry[action] ?? 1) - 1;
        if (!entry[action]) {
            delete entry[action];
        }
        count(kind, 'conflict');
        conflict(kind, id, reason);
    };
    const issueLiveNow = db.prepare('SELECT 1 FROM issues WHERE id=? AND deletedAt IS NULL');
    /** The issue a record belongs to must be live here as the record is written. */
    const issueGone = (issueId: string) => (issueLiveNow.get(issueId) ? undefined : 'its issue is deleted here');
    /** An additive record of an issue, written only while its issue is live. */
    const onIssue = (kind: string, id: string, issueId: string, write: () => void) =>
        ops.push(() => {
            const reason = issueGone(issueId);
            if (reason) {
                refuse(kind, id, 'create', reason);
                return;
            }
            write();
            putMap.run(origin, kind, id, id, '', runId!, now());
        });
    const DELETED = 'deleted';

    // ── Spaces ────────────────────────────────────────────────────────
    const spaceHashNow = (id: string) => {
        const row = spaceRow.get(id) as Row | undefined;
        return !row
            ? undefined
            : row.deletedAt !== null
              ? DELETED
              : spaceHash(row.name, row.description, privateHere(id));
    };
    const memberRow = db.prepare('SELECT 1 FROM space_members WHERE spaceId=? AND userId=?');
    for (const space of spaces) {
        if (spaceMap[space.id]) {
            count('space', 'skip');
            continue;
        }
        scan(`Space ${space.name}`, `${space.name}\n${space.description}`);
        const row = spaceRow.get(space.id) as Row | undefined;
        const desired = spaceHash(space.name, space.description, space.membersOnly);
        const planned = spaceHashNow(space.id);
        const action = decide('space', space.id, row && { hash: planned!, deleted: row.deletedAt !== null }, desired);
        if (action === 'create') {
            guarded(
                'space',
                space.id,
                'create',
                () => spaceHashNow(space.id),
                undefined,
                desired,
                () => {
                    db.prepare('INSERT INTO spaces(id, name, description, createdAt) VALUES (?, ?, ?, ?)').run(
                        space.id,
                        space.name,
                        space.description,
                        space.createdAt,
                    );
                    if (space.membersOnly) {
                        db.prepare(
                            'INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES (?, 1, ?, ?)',
                        ).run(space.id, IMPORT_ACTOR, now());
                    }
                },
            );
        } else if (action === 'update') {
            guarded(
                'space',
                space.id,
                'update',
                () => spaceHashNow(space.id),
                planned,
                desired,
                () => {
                    db.prepare('UPDATE spaces SET name=?, description=? WHERE id=?').run(
                        space.name,
                        space.description,
                        space.id,
                    );
                    db.prepare(
                        `INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES (?, ?, ?, ?)
                     ON CONFLICT(spaceId) DO UPDATE SET membersOnly=excluded.membersOnly, updatedBy=excluded.updatedBy, updatedAt=excluded.updatedAt`,
                    ).run(space.id, space.membersOnly ? 1 : 0, IMPORT_ACTOR, now());
                },
            );
        }
        if (spaceTarget.get(space.id) === space.id) {
            for (const member of space.members) {
                // Counted for the report's people, mapped or not, like authors.
                noteUse(member.userId);
                const userId = mapped.get(member.userId);
                if (!userId) {
                    continue;
                }
                const key = `${space.id}:${member.userId}`;
                if (additive('space_member', key, action !== 'create' && !!memberRow.get(space.id, userId))) {
                    ops.push(() =>
                        db
                            .prepare(
                                'INSERT OR IGNORE INTO space_members(spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
                            )
                            .run(space.id, userId, member.role, IMPORT_ACTOR, member.addedAt, now()),
                    );
                    remember('space_member', key, `${space.id}:${userId}`);
                }
            }
        }
        await record();
    }
    for (const space of spaces) {
        if (!spaceTarget.has(space.id)) {
            report.warnings.push(
                `Space ${space.name}: its pages are skipped (the Space is deleted here, or another one has its id).`,
            );
        }
    }

    // ── Pages ─────────────────────────────────────────────────────────
    const pageRow = db.prepare(
        'SELECT spaceId, title, content, parentId, coverId, revision, updatedAt, deletedAt FROM pages WHERE id=?',
    );
    const embedRow = db.prepare('SELECT 1 FROM media_embeds WHERE id=?');
    const tagRow = db.prepare('SELECT 1 FROM page_tags WHERE pageId=? AND tag=?');
    const linkRow = db.prepare(
        'SELECT 1 FROM page_links WHERE id=? OR (fromPageId=? AND toPageId=? AND kind=? AND removedAt IS NULL)',
    );
    const putSearch = lazy(
        'INSERT INTO page_search(pageId, spaceId, title, body) VALUES (?, ?, ?, ?) ON CONFLICT(pageId) DO UPDATE SET spaceId=excluded.spaceId, title=excluded.title, body=excluded.body',
    );
    const pageHash = (spaceId: unknown, title: unknown, content: unknown, parentId: unknown, coverId: unknown) =>
        hashOf({ spaceId, title, content, parentId, coverId });
    const pageHashNow = (id: string) => {
        const row = pageRow.get(id) as Row | undefined;
        return !row
            ? undefined
            : row.deletedAt !== null
              ? DELETED
              : pageHash(row.spaceId, row.title, row.content, row.parentId, row.coverId);
    };
    const spaceLiveNow = db.prepare('SELECT 1 FROM spaces WHERE id=? AND deletedAt IS NULL');
    const pageLive = db.prepare('SELECT 1 FROM pages WHERE id=? AND spaceId=? AND deletedAt IS NULL');
    const seenEmbeds = new Set<string>();
    const embedsHere = new Set<string>();
    const slug =
        label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'source';
    for await (const page of bundle.records('pages.jsonl', pageRecordSchema)) {
        const target = spaceTarget.get(page.spaceId);
        if (!target) {
            count('page', 'skip');
            continue;
        }
        const where = `page ${page.id} (${page.title.slice(0, 60)})`;
        const clash = imageClash.get(page.id);
        if (clash) {
            count('page', 'conflict');
            conflict('page', page.id, `its image ${clash} has an id another image has here; the page is left out`);
            await record();
            continue;
        }
        // A members-only Space's pages, and their images, tags and links, go
        // only into a Space here that is members-only when they are written.
        const stillPrivate = () =>
            !spaceLiveNow.get(target)
                ? 'the Space here is gone'
                : sourcePrivate.has(page.spaceId) && !privateHere(target)
                  ? 'the Space here isn’t members-only'
                  : undefined;
        /** A write that needs the page here (its tags, its links): skipped when the page wasn't written. */
        const onPage = (write: () => void) =>
            ops.push(() => {
                if (!stillPrivate() && pageLive.get(page.id, target)) {
                    write();
                }
            });
        /** A dependent write of the page: skipped with it when the Space here isn't private enough. */
        const withPage = (write: () => void) =>
            ops.push(() => {
                if (!stillPrivate()) {
                    write();
                }
            });
        // Images first: their files are stored before the page's chunk commits.
        let pageBytes = 0;
        for (const image of placed.has(page.id) ? page.images : []) {
            if (seenEmbeds.has(image.embedId)) {
                continue;
            }
            seenEmbeds.add(image.embedId);
            const knownImage = mapOf('embed', image.embedId);
            if (knownImage) {
                embedsHere.add(image.embedId);
                const current = embedFile.get(image.embedId) as
                    | { fileId: string; spaceId: string; createdAt: number; updatedAt: number }
                    | undefined;
                if (current && current.spaceId !== target) {
                    // Its readers here are another Space's: it is never shared with this one.
                    embedsHere.delete(image.embedId);
                    count('image', 'conflict');
                    conflict('image', image.embedId, 'it belongs to another Space here');
                    continue;
                }
                if (current && knownImage.hash !== image.sha256 && current.updatedAt !== current.createdAt) {
                    // Its file was replaced here (an import's files are written once): edits here win.
                    count('image', 'conflict');
                    conflict('image', image.embedId, 'its file was replaced here since it was imported');
                    continue;
                }
                if (!knownImage.hash || knownImage.hash === image.sha256 || !current) {
                    // The same bytes, or the image is gone here (deleted here wins).
                    count('image', current || knownImage.hash === image.sha256 ? 'unchanged' : 'skip');
                    continue;
                }
                // New bytes at the source: a new file here, and the image points at it.
                if (!bundle.hasBlob(image.sha256) || bundle.blobSize(image.sha256) !== image.size) {
                    throw new BundleError(`${where}: image ${image.embedId} has no matching file in the bundle.`);
                }
                count('image', 'update');
                report.bytes.images += image.size;
                const extension = /^image\/(png|jpeg|gif|webp|avif)$/
                    .exec(image.mediaType)?.[1]
                    ?.replace('jpeg', 'jpg');
                const fileId = await budget.hold(image.size * 2 + 64, async () => {
                    const bytes = bundle.blob(image.sha256);
                    return apply
                        ? options.files.put({
                              ownerUserId: options.operatorId,
                              path: `imported/${slug}/${image.embedId}-${image.sha256.slice(0, 12)}${extension ? `.${extension}` : ''}`,
                              name: image.name,
                              mediaType: image.mediaType,
                              bytes,
                          })
                        : '';
                });
                pageBytes += image.size;
                ops.push(() => {
                    const nowFile = embedFile.get(image.embedId) as { fileId: string; updatedAt: number } | undefined;
                    const reason =
                        nowFile?.fileId !== current.fileId || nowFile.updatedAt !== current.updatedAt
                            ? 'changed here while the import ran'
                            : stillPrivate();
                    if (reason) {
                        refuse('image', image.embedId, 'update', reason);
                        return;
                    }
                    db.prepare('UPDATE media_embeds SET fileId=?, ownerUserId=? WHERE id=?').run(
                        fileId,
                        options.operatorId,
                        image.embedId,
                    );
                    putMap.run(origin, 'embed', image.embedId, image.embedId, image.sha256, runId!, now());
                });
                continue;
            }
            if (embedRow.get(image.embedId)) {
                // Someone else's image here under the same id: never made a cover.
                count('image', 'conflict');
                conflict('image', image.embedId, 'already here, not from this source');
                continue;
            }
            // The size the budget counts is the one the bundle's file has.
            if (!bundle.hasBlob(image.sha256) || bundle.blobSize(image.sha256) !== image.size) {
                throw new BundleError(`${where}: image ${image.embedId} has no matching file in the bundle.`);
            }
            count('image', 'create');
            report.bytes.images += image.size;
            embedsHere.add(image.embedId);
            const extension = /^image\/(png|jpeg|gif|webp|avif)$/.exec(image.mediaType)?.[1]?.replace('jpeg', 'jpg');
            const fileId = await budget.hold(image.size * 2 + 64, async () => {
                // Checked against its sha256 in a dry run too.
                const bytes = bundle.blob(image.sha256);
                if (!apply) {
                    return '';
                }
                return options.files.put({
                    ownerUserId: options.operatorId,
                    path: `imported/${slug}/${image.embedId}${extension ? `.${extension}` : ''}`,
                    name: image.name,
                    mediaType: image.mediaType,
                    bytes,
                });
            });
            pageBytes += image.size;
            withPage(() => {
                db.prepare(
                    'INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES (?, ?, ?, NULL, ?, ?, ?)',
                ).run(image.embedId, fileId, options.operatorId, target, image.sourceUrl, image.createdAt);
                putMap.run(origin, 'embed', image.embedId, image.embedId, image.sha256, runId!, now());
            });
        }
        const creator = author(page.createdBy);
        const content = bylined(creator.byline, page.createdAt, rewrite(where, page.content));
        scan(
            where,
            [
                page.title,
                content,
                page.sourceUrl ?? '',
                page.sourceTitle ?? '',
                ...page.tags.map((t) => t.tag),
                ...page.images.flatMap((i) => [i.name, i.sourceUrl]),
            ].join('\n'),
        );
        const parentId = page.parentId && placed.get(page.parentId) === target ? page.parentId : null;
        const coverId = page.coverId && embedsHere.has(page.coverId) ? page.coverId : null;
        const desired = pageHash(target, page.title, content, parentId, coverId);
        const row = pageRow.get(page.id) as Row | undefined;
        if (row && row.spaceId !== target && !row.deletedAt) {
            count('page', 'conflict');
            conflict('page', page.id, 'it is in another Space here');
            continue;
        }
        const planned = pageHashNow(page.id);
        const action = decide('page', page.id, row && { hash: planned!, deleted: row.deletedAt !== null }, desired);
        if (action === 'create') {
            guarded(
                'page',
                page.id,
                'create',
                () => pageHashNow(page.id),
                undefined,
                desired,
                () => {
                    db.prepare(
                        `INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy, coverId, sourceUrl, sourceTitle)
                     VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?)`,
                    ).run(
                        page.id,
                        target,
                        parentId,
                        page.title,
                        content,
                        page.createdAt,
                        page.updatedAt,
                        creator.mapped ? creator.id : null,
                        coverId,
                        page.sourceUrl,
                        page.sourceTitle,
                    );
                    putSearch.run(page.id, target, page.title, pageText(content));
                },
                stillPrivate,
            );
        } else if (action === 'update') {
            guarded(
                'page',
                page.id,
                'update',
                () => pageHashNow(page.id),
                planned,
                desired,
                () => {
                    const before = pageRow.get(page.id) as Row;
                    // The text it replaces stays a revision, as any edit's does.
                    db.prepare(
                        `INSERT INTO page_revisions(pageId, spaceId, revision, title, body, encoding, authorId, createdAt, replacedAt)
                     VALUES (?, ?, ?, ?, ?, 'utf8', ?, ?, ?)`,
                    ).run(
                        page.id,
                        target,
                        Number(before.revision),
                        String(before.title),
                        Buffer.from(String(before.content), 'utf8'),
                        IMPORT_ACTOR,
                        Number(before.updatedAt),
                        now(),
                    );
                    db.prepare(
                        'UPDATE pages SET title=?, content=?, parentId=?, coverId=?, updatedAt=?, revision=revision+1 WHERE id=?',
                    ).run(
                        page.title,
                        content,
                        parentId,
                        coverId,
                        Math.max(page.updatedAt, Number(before.updatedAt)),
                        page.id,
                    );
                    putSearch.run(page.id, target, page.title, pageText(content));
                },
                stillPrivate,
            );
        }
        if (placed.has(page.id)) {
            for (const tag of page.tags) {
                const key = `${page.id}:${tag.tag}`;
                if (additive('page_tag', key, !!tagRow.get(page.id, tag.tag))) {
                    const by = author(tag.createdBy);
                    onPage(() => {
                        db.prepare(
                            'INSERT OR IGNORE INTO page_tags(pageId, spaceId, tag, createdBy, createdAt) VALUES (?, ?, ?, ?, ?)',
                        ).run(page.id, target, tag.tag, by.mapped ? by.id : null, tag.createdAt);
                        putMap.run(origin, 'page_tag', key, key, '', runId!, now());
                    });
                }
            }
            for (const link of page.links) {
                const to = placed.get(link.toPageId);
                if (!to) {
                    continue;
                }
                if (additive('page_link', link.id, !!linkRow.get(link.id, page.id, link.toPageId, link.kind))) {
                    const by = author(link.createdBy);
                    onPage(() => {
                        db.prepare(
                            'INSERT INTO page_links(id, fromPageId, toPageId, fromSpaceId, toSpaceId, kind, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        ).run(
                            link.id,
                            page.id,
                            link.toPageId,
                            target,
                            to,
                            link.kind,
                            by.mapped ? by.id : null,
                            link.createdAt,
                        );
                        putMap.run(origin, 'page_link', link.id, link.id, '', runId!, now());
                    });
                }
            }
        }
        await record(pageBytes);
    }
    await flush();

    // ── Issues ────────────────────────────────────────────────────────
    const issueRow = db.prepare(
        'SELECT title, body, status, priority, kind, area, assigneeId, resolution, closedAt, deletedAt FROM issues WHERE id=?',
    );
    const labelRows = db.prepare('SELECT label FROM issue_labels WHERE issueId=? ORDER BY label');
    const commentRow = db.prepare('SELECT authorKind, authorId, body, deletedAt FROM issue_comments WHERE id=?');
    const attachmentRow = db.prepare('SELECT 1 FROM issue_attachments WHERE id=?');
    const voteRow = db.prepare(
        'SELECT 1 FROM issue_votes WHERE id=? OR (issueId=? AND userId=? AND withdrawnAt IS NULL)',
    );
    const eventRow = db.prepare('SELECT 1 FROM issue_events WHERE id=?');
    const issueLinkRow = db.prepare(
        "SELECT 1 FROM issue_links WHERE id=? OR (fromId=? AND toId=? AND kind='blocked_by' AND removedAt IS NULL)",
    );
    const relationRow = db.prepare(
        'SELECT 1 FROM issue_relations WHERE id=? OR (fromId=? AND toId=? AND removedAt IS NULL)',
    );
    const watched = db.prepare(
        "SELECT 1 FROM issue_watch_members m JOIN issue_watches w ON w.id=m.watchId WHERE m.issueId=? AND w.state IN ('watching','ready') LIMIT 1",
    );
    const fieldsHash = (fields: {
        title: unknown;
        body: unknown;
        status: unknown;
        priority: unknown;
        kind: unknown;
        area: unknown;
        assigneeId: unknown;
        resolution: unknown;
        closedAt: unknown;
        labels: readonly string[];
    }) =>
        hashOf({
            title: fields.title,
            body: fields.body,
            status: fields.status,
            priority: fields.priority,
            kind: fields.kind,
            area: fields.area ?? null,
            assigneeId: fields.assigneeId ?? null,
            resolution: fields.resolution ?? null,
            closedAt: fields.closedAt === null || fields.closedAt === undefined ? null : Number(fields.closedAt),
            labels: [...fields.labels].sort(),
        });
    const issueHashNow = (id: string) => {
        const row = issueRow.get(id) as Row | undefined;
        if (!row) {
            return undefined;
        }
        if (row.deletedAt !== null) {
            return DELETED;
        }
        return fieldsHash({
            ...(row as unknown as Parameters<typeof fieldsHash>[0]),
            labels: (labelRows.all(id) as { label: string }[]).map((l) => l.label),
        });
    };
    const commentHashNow = (id: string) => {
        const row = commentRow.get(id) as Row | undefined;
        return !row
            ? undefined
            : row.deletedAt !== null
              ? DELETED
              : hashOf({ authorKind: row.authorKind, authorId: row.authorId, body: row.body });
    };
    const seenLinks = new Set<string>();
    /** Issues whose copied status history a watch here kept out. */
    const leftOut = new Set<string>();
    for await (const issue of bundle.records('issues.jsonl', issueRecordSchema)) {
        if (!copiedIds.has(issue.id)) {
            continue;
        }
        const key = `${prefix}-${issue.number}`;
        /** Its number here: the source's, or the one it was renumbered to. */
        const number = renumbered.get(issue.number) ?? issue.number;
        const reporter = author(issue.reporterId);
        const assignee = issue.assigneeId ? (mapped.get(issue.assigneeId) ?? null) : null;
        if (issue.assigneeId) {
            author(issue.assigneeId);
        }
        const rewritten = rewrite(key, issue.body);
        // Under another number here: its text says which issue it was there.
        const body = number === issue.number ? rewritten : `_Originally ${key} on ${label}._\n\n${rewritten}`;
        const resolution = issue.resolution === null ? null : rewrite(key, issue.resolution);
        scan(
            key,
            [
                issue.title,
                body,
                resolution ?? '',
                issue.area ?? '',
                ...issue.labels,
                ...issue.attachments.map((a) => a.name),
            ].join('\n'),
        );
        // History keeps old values (a description before an edit): copied as they are, so reviewed too.
        scan(`${key} history`, issue.events.flatMap((e) => [e.fromValue ?? '', e.toValue ?? '']).join('\n'));
        const labels = [...new Set(issue.labels)].sort();
        const fields = {
            title: issue.title,
            body,
            status: issue.status,
            priority: issue.priority,
            kind: issue.kind,
            area: issue.area,
            assigneeId: assignee,
            resolution,
            closedAt: issue.closedAt,
            labels,
        };
        const row = issueRow.get(issue.id) as Row | undefined;
        const desired = fieldsHash(fields);
        const planned = issueHashNow(issue.id);
        const action = decide('issue', issue.id, row && { hash: planned!, deleted: row.deletedAt !== null }, desired);
        if (action === 'skip') {
            await record();
            continue;
        }
        const writeLabels = () => {
            db.prepare('DELETE FROM issue_labels WHERE issueId=?').run(issue.id);
            for (const labelName of labels) {
                db.prepare('INSERT INTO issue_labels(issueId, label) VALUES (?, ?)').run(issue.id, labelName);
            }
        };
        // Links whose other end isn't here become lines of the import note.
        const noteLines: string[] = [];
        for (const link of issue.links) {
            const otherId = link.fromId === issue.id ? link.toId : link.fromId;
            const otherNumber = link.fromId === issue.id ? link.toNumber : link.fromNumber;
            if (copiedIds.has(otherId)) {
                continue;
            }
            const other = `${prefix}-${otherNumber}`;
            missingIssues.add(otherNumber);
            noteLines.push(
                link.kind === 'related'
                    ? `Was related to ${other} on ${label}.`
                    : link.fromId === issue.id
                      ? `Was blocked by ${other} on ${label}.`
                      : `Was blocking ${other} on ${label}.`,
            );
        }
        const unmappedVotes = issue.votes.filter((vote) => !mapped.has(vote.userId)).length;
        if (action === 'create') {
            const note = [
                `Imported from ${label} ${key} (${origin}/issues/${key}) on ${day(startedAt)}.`,
                ...(number === issue.number
                    ? []
                    : [`${key} here is another issue, so it is ${prefix}-${number} here.`]),
                ...(reporter.byline
                    ? [`Originally filed by ${reporter.byline} on ${label}, ${day(issue.createdAt)}.`]
                    : []),
                ...(unmappedVotes
                    ? [
                          `${unmappedVotes} vote${unmappedVotes === 1 ? '' : 's'} on ${label} from people who aren’t here.`,
                      ]
                    : []),
                ...noteLines,
            ].join('\n\n');
            const noteId = randomUUID();
            guarded(
                'issue',
                issue.id,
                'create',
                () => issueHashNow(issue.id),
                undefined,
                desired,
                () => {
                    db.prepare(
                        `INSERT INTO issues(id, number, title, body, status, priority, kind, area, reporterId, assigneeId, resolution, source, createdAt, updatedAt, closedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`,
                    ).run(
                        issue.id,
                        number,
                        issue.title,
                        body,
                        issue.status,
                        issue.priority,
                        issue.kind,
                        issue.area,
                        reporter.id ?? IMPORT_ACTOR,
                        assignee,
                        resolution,
                        issue.createdAt,
                        issue.updatedAt,
                        issue.closedAt,
                    );
                    db.prepare(
                        'UPDATE issue_counter SET last = CASE WHEN last < ? THEN ? ELSE last END WHERE id = 1',
                    ).run(number, number);
                    writeLabels();
                    if (number !== issue.number) {
                        // Kept, so a later import updates this issue and never renumbers it again.
                        putMap.run(
                            origin,
                            'issue_number',
                            issue.id,
                            String(number),
                            String(issue.number),
                            runId!,
                            now(),
                        );
                    }
                    // The import's own note, first in the thread.
                    db.prepare(
                        "INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt, editedAt) VALUES (?, ?, 'system', NULL, ?, ?, NULL)",
                    ).run(noteId, issue.id, note, issue.createdAt);
                    putMap.run(origin, 'issue_note', issue.id, noteId, '', runId!, now());
                },
                () => {
                    const row = byNumber.get(number) as { id: string } | undefined;
                    return row && row.id !== issue.id ? 'its number is another issue’s here' : undefined;
                },
            );
        } else if (action === 'update') {
            guarded(
                'issue',
                issue.id,
                'update',
                () => issueHashNow(issue.id),
                planned,
                desired,
                () => {
                    db.prepare(
                        'UPDATE issues SET title=?, body=?, status=?, priority=?, kind=?, area=?, assigneeId=?, resolution=?, updatedAt=MAX(updatedAt, ?), closedAt=? WHERE id=?',
                    ).run(
                        issue.title,
                        body,
                        issue.status,
                        issue.priority,
                        issue.kind,
                        issue.area,
                        assignee,
                        resolution,
                        issue.updatedAt,
                        issue.closedAt,
                        issue.id,
                    );
                    writeLabels();
                    // Watches here see the new status as already known: an import never triggers one.
                    db.prepare('UPDATE issue_watch_members SET status=? WHERE issueId=?').run(issue.status, issue.id);
                },
            );
        }
        // History: with a new issue, and with an update nobody here watches
        // (a copied status change must not fire a watch).
        // History: with a new issue, and with one nobody here edited. A
        // copied status change is left out when someone here watches the
        // issue as the chunk commits: it must never fire a watch.
        const history = action === 'create' || action === 'update' || action === 'unchanged';
        let attachmentBytes = 0;
        for (const comment of issue.comments) {
            const by = author(comment.authorId);
            let authorKind: string = comment.authorKind;
            let authorId: string | null = comment.authorId;
            let text = rewrite(`${key} comment`, comment.body);
            if (comment.authorKind === 'user') {
                authorId = by.id;
                text = bylined(by.byline, comment.createdAt, text);
            } else if (comment.authorKind === 'agent') {
                // A socio's comment: its socio isn't here.
                authorKind = 'system';
                authorId = null;
                text = bylined(by.byline ?? `a socio`, comment.createdAt, text);
            }
            scan(`${key} comment`, text);
            const desired = hashOf({ authorKind, authorId, body: text });
            const current = commentRow.get(comment.id) as Row | undefined;
            const plannedComment = commentHashNow(comment.id);
            const commentAction = decide(
                'comment',
                comment.id,
                current && { hash: plannedComment!, deleted: current.deletedAt !== null },
                desired,
            );
            const commentNow = () => commentHashNow(comment.id);
            if (commentAction === 'create') {
                guarded(
                    'comment',
                    comment.id,
                    'create',
                    commentNow,
                    undefined,
                    desired,
                    () =>
                        db
                            .prepare(
                                'INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt, editedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
                            )
                            .run(comment.id, issue.id, authorKind, authorId, text, comment.createdAt, comment.editedAt),
                    () => issueGone(issue.id),
                );
            } else if (commentAction === 'update') {
                guarded(
                    'comment',
                    comment.id,
                    'update',
                    commentNow,
                    plannedComment,
                    desired,
                    () =>
                        db
                            .prepare(
                                'UPDATE issue_comments SET authorKind=?, authorId=?, body=?, editedAt=? WHERE id=?',
                            )
                            .run(authorKind, authorId, text, comment.editedAt, comment.id),
                    () => issueGone(issue.id),
                );
            }
        }
        const commentIds = new Set(issue.comments.map((c) => c.id));
        for (const attachment of issue.attachments) {
            if (!additive('attachment', attachment.id, !!attachmentRow.get(attachment.id))) {
                continue;
            }
            if (!bundle.hasBlob(attachment.sha256) || bundle.blobSize(attachment.sha256) !== attachment.size) {
                throw new BundleError(`${key}: attachment ${attachment.name} has no matching file in the bundle.`);
            }
            report.bytes.attachments += attachment.size;
            attachmentBytes += attachment.size;
            const uploader = author(attachment.uploaderId);
            if (!apply) {
                // Checked against its sha256, one at a time.
                budget.holdSync(attachment.size + 64, () => bundle.blob(attachment.sha256));
                continue;
            }
            const commentId =
                attachment.commentId && commentIds.has(attachment.commentId) ? attachment.commentId : null;
            ops.push(() => {
                // Its issue, and its comment if it has one, must be live here as it commits.
                const parent = commentId
                    ? db
                          .prepare('SELECT 1 FROM issue_comments WHERE id=? AND issueId=? AND deletedAt IS NULL')
                          .get(commentId, issue.id)
                    : db.prepare('SELECT 1 FROM issues WHERE id=? AND deletedAt IS NULL').get(issue.id);
                if (!parent || issueGone(issue.id)) {
                    refuse(
                        'attachment',
                        attachment.id,
                        'create',
                        `its ${parent ? 'issue' : commentId ? 'comment' : 'issue'} is deleted here`,
                    );
                    return;
                }
                // One attachment's bytes at a time, inside the transaction.
                budget.holdSync(attachment.size + 64, () =>
                    db
                        .prepare(
                            'INSERT INTO issue_attachments(id, issueId, commentId, name, mediaType, size, sha256, data, uploaderId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        )
                        .run(
                            attachment.id,
                            issue.id,
                            commentId,
                            attachment.name,
                            attachment.mediaType,
                            attachment.size,
                            attachment.sha256,
                            bundle.blob(attachment.sha256),
                            uploader.id ?? IMPORT_ACTOR,
                            attachment.createdAt,
                        ),
                );
                putMap.run(origin, 'attachment', attachment.id, attachment.id, '', runId!, now());
            });
        }
        for (const vote of issue.votes) {
            noteUse(vote.userId);
            const userId = mapped.get(vote.userId);
            if (!userId) {
                continue;
            }
            if (additive('vote', vote.id, !!voteRow.get(vote.id, issue.id, userId))) {
                onIssue('vote', vote.id, issue.id, () =>
                    db
                        .prepare(
                            'INSERT INTO issue_votes(id, issueId, userId, dotId, createdAt) VALUES (?, ?, ?, NULL, ?)',
                        )
                        .run(vote.id, issue.id, userId, vote.createdAt),
                );
            }
        }
        if (history) {
            for (const event of issue.events) {
                if (!additive('event', event.id, !!eventRow.get(event.id))) {
                    continue;
                }
                const actor = author(event.actorId);
                ops.push(() => {
                    const gone = issueGone(issue.id);
                    if (gone) {
                        refuse('event', event.id, 'create', gone);
                        return;
                    }
                    if (event.kind === 'status' && watched.get(issue.id)) {
                        if (!leftOut.has(issue.id)) {
                            leftOut.add(issue.id);
                            report.warnings.push(`${key}: newer status history left out (someone here watches it).`);
                        }
                        return;
                    }
                    db.prepare(
                        'INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    ).run(event.id, issue.id, actor.id, event.kind, event.fromValue, event.toValue, event.createdAt);
                    putMap.run(origin, 'event', event.id, event.id, '', runId!, now());
                });
            }
        } else if (issue.events.some((event) => !mapOf('event', event.id))) {
            report.warnings.push(`${key}: newer history left out (it was edited here).`);
        }
        if (action === 'create') {
            const importedId = randomUUID();
            ops.push(() => {
                if (!issueGone(issue.id)) {
                    db.prepare(
                        "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES (?, ?, ?, 'imported', NULL, ?, ?)",
                    ).run(importedId, issue.id, IMPORT_ACTOR, issue.status, startedAt);
                }
            });
        }
        for (const link of issue.links) {
            if (!copiedIds.has(link.fromId) || !copiedIds.has(link.toId) || seenLinks.has(link.id)) {
                continue;
            }
            seenLinks.add(link.id);
            const exists =
                link.kind === 'related'
                    ? !!relationRow.get(link.id, link.fromId, link.toId)
                    : !!issueLinkRow.get(link.id, link.fromId, link.toId);
            if (!additive('issue_link', link.id, exists)) {
                continue;
            }
            const by = author(link.createdBy);
            onIssue('issue_link', link.id, issue.id, () =>
                db
                    .prepare(
                        link.kind === 'related'
                            ? "INSERT INTO issue_relations(id, fromId, toId, kind, createdBy, createdAt) VALUES (?, ?, ?, 'related', ?, ?)"
                            : "INSERT INTO issue_links(id, fromId, toId, kind, createdBy, createdAt) VALUES (?, ?, ?, 'blocked_by', ?, ?)",
                    )
                    .run(link.id, link.fromId, link.toId, by.id ?? IMPORT_ACTOR, link.createdAt),
            );
        }
        await record(attachmentBytes);
    }
    await flush();

    // ── The report ────────────────────────────────────────────────────
    for (const [id, records] of [...authorUse].sort((a, b) => b[1] - a[1])) {
        const user = users.get(id);
        if (!user) {
            continue;
        }
        if (mapped.has(id)) {
            report.authors.mapped.push({ name: user.name, records });
        } else {
            report.authors.unmapped.push({ name: user.name, kind: user.kind, records });
            if (unverified.has(id)) {
                report.authors.unverified.push({ name: user.name, records });
            }
        }
    }
    report.notCopied.issues = [...missingIssues].sort((a, b) => a - b);
    report.notCopied.pages = [...missingPages].sort();
    if (apply) {
        await transaction(db, 'finish bundle import', () => {
            db.prepare('UPDATE import_runs SET finishedAt=?, counts=? WHERE id=?').run(
                now(),
                JSON.stringify(report.counts),
                runId!,
            );
        });
    }
    return report;
}

/** The report as lines for a terminal. */
export function reportLines(report: ImportReport): string[] {
    const lines: string[] = [];
    lines.push(
        `${report.apply ? 'Imported' : 'Dry run (nothing written; --apply writes it)'}: bundle ${report.bundle.sha256.slice(0, 12)} from ${report.bundle.label} (${report.bundle.origin}), made ${new Date(report.bundle.createdAt).toISOString()} by ${report.bundle.appVersion}.`,
    );
    if (report.backupPath) {
        lines.push(`Database copied first to ${report.backupPath}.`);
    }
    lines.push('Records:');
    for (const [kind, actions] of Object.entries(report.counts)) {
        lines.push(
            `  ${kind}\t${Object.entries(actions)
                .map(([action, n]) => `${action} ${n}`)
                .join(', ')}`,
        );
    }
    lines.push(
        `Issue numbers kept: ${report.numbers.kept}${report.numbers.taken.length ? `; taken here by other issues: ${report.numbers.taken.join(', ')}` : ''}.`,
    );
    if (report.replaced.length) {
        lines.push(
            `Issues deleted here whose numbers bundle issues take (removed for good, with their comments, history, attachments and other records): ${report.replaced.length}.`,
        );
        for (const r of report.replaced) {
            lines.push(
                `  ${report.apply ? 'replaced' : 'replace'} deleted ${r.issue} here (deleted ${day(r.deletedAt)})`,
            );
        }
    }
    if (report.renumbered.length) {
        lines.push(
            `Issues renumbered (their numbers are other issues here; each takes the next free number${report.apply ? '' : ', as of now'}): ${report.renumbered.length}.`,
        );
        for (const r of report.renumbered) {
            lines.push(
                `  ${report.apply ? 'renumbered' : 'renumber'} ${r.issue} → ${r.to} (${r.issue} here is another issue)`,
            );
        }
    }
    lines.push(`Bytes: attachments ${report.bytes.attachments}, images ${report.bytes.images}.`);
    lines.push(
        `Authors mapped by email: ${report.authors.mapped.map((a) => `${a.name} (${a.records})`).join(', ') || 'none'}.`,
    );
    lines.push(
        `Authors not here (bylines): ${report.authors.unmapped.map((a) => `${a.name}${a.kind === 'socio' ? ' (socio)' : ''} (${a.records})`).join(', ') || 'none'}.`,
    );
    if (report.authors.unverified.length) {
        lines.push(
            `Not matched, because the account here hasn’t verified that email (bylines; no memberships or votes): ${report.authors.unverified.map((a) => `${a.name} (${a.records})`).join(', ')}.`,
        );
    }
    if (report.notCopied.issues.length) {
        lines.push(
            `Issues named but not copied (linked to the source): ${report.notCopied.issues.map((n) => `#${n}`).join(', ')}.`,
        );
    }
    if (report.notCopied.pages.length) {
        lines.push(`Pages linked but not copied (linked to the source): ${report.notCopied.pages.join(', ')}.`);
    }
    lines.push(`Text rewrites: ${report.rewrites.total}.`);
    for (const sample of report.rewrites.samples) {
        lines.push(`  ${sample.where}: ${sample.before} -> ${sample.after}`);
    }
    if (report.conflicts.length) {
        lines.push(`Conflicts (left as they are here): ${report.conflicts.length}.`);
        for (const c of report.conflicts) {
            lines.push(`  ${c.kind} ${c.id}: ${c.reason}`);
        }
    }
    lines.push(`Sensitive details to review (not redacted): ${report.sensitive.total}.`);
    for (const hit of report.sensitive.hits) {
        lines.push(`  ${hit.where}\t${hit.kind}\t${hit.match}`);
    }
    for (const warning of report.warnings) {
        lines.push(`Warning: ${warning}`);
    }
    return lines;
}
