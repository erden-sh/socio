import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sqliteData } from '@socio/data/open';
import { objectKey } from '@socio/data/storage/keys';
import { SecretBox } from '@socio/foundation/keys/secret-box';

import { exportBundle, type ExportOptions } from '../src/server/bundle/export.js';
import { sealedFileSink } from '../src/server/bundle/file-sink.js';
import { boundedLines, BundleReader, BundleWriter, ByteBudget, hashFile } from '../src/server/bundle/files.js';
import { IMPORT_TABLES, importBundle, reportLines, type ImportOptions } from '../src/server/bundle/import.js';
import { ISSUE_ROWS } from '../src/server/bundle/replace.js';
import { sqliteBoard } from '../src/server/issues/services.js';
import { LocalObjectStore } from '../src/server/storage/local-store.js';

import { testDatabase } from './helpers/test-database.js';

const ORIGIN = 'https://source.example.test';
const SOURCE_KEYS = { current: randomBytes(32), legacy: 'bundle-test-source-secret-0123456' };
const TARGET_KEYS = { current: randomBytes(32), legacy: 'bundle-test-target-secret-0123456' };
const EMBED = 'cbemb_picture_0123456789';
const T0 = Date.UTC(2026, 9, 1);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(2048)]);

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
    vi.unstubAllGlobals();
});
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-bundle-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

function person(db: DatabaseSync, id: string, name: string, email: string | null, role = 'member') {
    db.prepare('INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)').run(
        id,
        name,
        role,
        T0,
        T0,
    );
    if (email) {
        db.prepare(
            'INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ).run(`auth-${id}`, name, email, T0, T0, id);
    }
}

/** A source workspace: people, a socio, three Spaces (one denied), pages with an image, and issues. */
async function seedSource(dir: string) {
    const db = testDatabase();
    person(db, 'alice', 'Alice Example', 'alice@example.test', 'admin');
    person(db, 'bob', 'Bob Example', 'bob@example.test');
    db.prepare(
        'INSERT INTO dots(id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt) VALUES (?, ?, ?, ?, 0, 0, ?)',
    ).run('scout', 'sp-research', 'Scout', '', T0);
    const space = db.prepare('INSERT INTO spaces(id, name, description, createdAt) VALUES (?, ?, ?, ?)');
    space.run('sp-research', 'Research', 'R&D', T0);
    space.run('sp-everyday', 'Everyday', 'Inbox', T0);
    space.run('sp-secret', 'Private', 'Never copied', T0);
    db.prepare(
        "INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES ('sp-research', 1, 'alice', ?)",
    ).run(T0);
    const member = db.prepare(
        'INSERT INTO space_members(spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    );
    member.run('sp-research', 'alice', 'editor', 'alice', T0, T0);
    member.run('sp-research', 'bob', 'member', 'alice', T0, T0);

    // The image: a file in Alice's Files, sealed with the source's keys.
    const store = new LocalObjectStore(join(dir, 'source-userdata'));
    const sink = sealedFileSink({ db, keys: SOURCE_KEYS, store, tenantId: 'main' });
    const fileId = await sink.put({
        ownerUserId: 'alice',
        path: 'pics/a.png',
        name: 'a.png',
        mediaType: 'image/png',
        bytes: PNG,
    });
    db.prepare(
        "INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES (?, ?, 'alice', NULL, 'sp-research', '', ?)",
    ).run(EMBED, fileId, T0);

    const page = db.prepare(
        'INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt, createdBy, coverId) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
    );
    page.run(
        'pg-root',
        'sp-research',
        null,
        'Ontology',
        [
            'Tracks CB-1 and CB-3. Child: [child](/spaces/sp-research/pages/pg-child).',
            '',
            '```image',
            JSON.stringify({ id: EMBED, alt: 'diagram' }),
            '```',
        ].join('\n'),
        T0,
        T0 + 1000,
        'alice',
        EMBED,
    );
    page.run(
        'pg-child',
        'sp-research',
        'pg-root',
        'Child',
        `Notes by Bob.\n\n\`\`\`sh\necho CB-3\n\`\`\`\n\nSecret: ${ORIGIN}/spaces/sp-secret/pages/pg-secret`,
        T0 + 10,
        T0 + 20,
        'bob',
        null,
    );
    page.run('pg-parent', 'sp-everyday', null, 'Inbox', 'Not picked.', T0, T0, 'alice', null);
    page.run('pg-picked', 'sp-everyday', 'pg-parent', 'Socio idea', 'See /issues/CB-2.', T0, T0, null, null);
    page.run('pg-secret', 'sp-secret', null, 'Private', 'Never read.', T0, T0, 'alice', null);
    db.prepare(
        "INSERT INTO page_tags(pageId, spaceId, tag, createdBy, createdAt) VALUES ('pg-root', 'sp-research', 'erden', 'alice', ?)",
    ).run(T0);
    db.prepare(
        "INSERT INTO page_links(id, fromPageId, toPageId, fromSpaceId, toSpaceId, kind, createdBy, createdAt) VALUES ('pl-1', 'pg-root', 'pg-child', 'sp-research', 'sp-research', 'index', 'alice', ?)",
    ).run(T0);

    const issue = db.prepare(
        'INSERT INTO issues(id, number, title, body, status, priority, kind, area, reporterId, assigneeId, resolution, source, createdAt, updatedAt, closedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?)',
    );
    issue.run(
        'is-1',
        1,
        'Ontology layer',
        'Needs CB-2 and CB-3.\n\n```\nCB-3 stays\n```',
        'open',
        'high',
        'feature',
        'alice',
        'alice',
        'web',
        T0,
        T0 + 500,
        null,
        null,
    );
    issue.run(
        'is-2',
        2,
        'Export',
        'Done after CB-1.',
        'done',
        'medium',
        'improvement',
        'bob',
        null,
        'web',
        T0 + 1,
        T0 + 2,
        T0 + 2,
        null,
    );
    issue.run(
        'is-3',
        3,
        'Homelab',
        'Not copied.',
        'open',
        'low',
        'chore',
        'alice',
        null,
        'web',
        T0 + 3,
        T0 + 3,
        null,
        null,
    );
    issue.run('is-4', 4, 'Gone', 'Deleted.', 'open', 'low', 'bug', 'alice', null, 'web', T0 + 4, T0 + 4, null, T0 + 5);
    db.prepare('UPDATE issue_counter SET last = 4').run();
    const label = db.prepare('INSERT INTO issue_labels(issueId, label) VALUES (?, ?)');
    label.run('is-1', 'erden');
    label.run('is-1', 'ontology');
    const comment = db.prepare(
        'INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt, editedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    comment.run('c-1', 'is-1', 'user', 'alice', 'Agree, see CB-3.', T0 + 10, null, null);
    comment.run('c-2', 'is-1', 'user', 'bob', 'Me too.', T0 + 20, T0 + 25, null);
    comment.run('c-3', 'is-1', 'agent', 'dot:scout', 'Filed from a chat.', T0 + 30, null, null);
    comment.run('c-4', 'is-1', 'user', 'bob', 'Deleted.', T0 + 40, null, T0 + 41);
    const data = randomBytes(4096);
    db.prepare(
        'INSERT INTO issue_attachments(id, issueId, commentId, name, mediaType, size, sha256, data, uploaderId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        'at-1',
        'is-1',
        'c-2',
        'log.txt',
        'text/plain',
        data.length,
        createHash('sha256').update(data).digest('hex'),
        data,
        'bob',
        T0 + 21,
    );
    const vote = db.prepare('INSERT INTO issue_votes(id, issueId, userId, dotId, createdAt) VALUES (?, ?, ?, NULL, ?)');
    vote.run('v-1', 'is-1', 'alice', T0 + 50);
    vote.run('v-2', 'is-1', 'bob', T0 + 51);
    const event = db.prepare(
        'INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    event.run('e-1', 'is-1', 'alice', 'created', null, 'triage', T0);
    event.run('e-2', 'is-1', 'bob', 'status', 'triage', 'open', T0 + 60);
    event.run('e-3', 'is-2', 'bob', 'created', null, 'done', T0 + 1);
    db.prepare(
        "INSERT INTO issue_links(id, fromId, toId, kind, createdBy, createdAt) VALUES ('l-1', 'is-1', 'is-3', 'blocked_by', 'alice', ?)",
    ).run(T0);
    db.prepare(
        "INSERT INTO issue_relations(id, fromId, toId, kind, createdBy, createdAt) VALUES ('r-1', 'is-1', 'is-2', 'related', 'bob', ?)",
    ).run(T0);
    return { db, store };
}

function seedTarget() {
    const db = testDatabase();
    // Alice has an account here under another id; her email differs in case.
    person(db, 'alice-here', 'Alice E.', 'ALICE@example.test');
    person(db, 'op', 'Operator', 'op@target.example.test', 'admin');
    return db;
}

async function makeBundle(
    dir: string,
    source: Awaited<ReturnType<typeof seedSource>>,
    overrides: Partial<ExportOptions> = {},
    name = 'bundle',
) {
    const box = new SecretBox(SOURCE_KEYS, 'data-files');
    const out = join(dir, name);
    const result = await exportBundle({
        db: source.db,
        out,
        selection: { issues: [1, 2], spaces: ['sp-research'], pages: ['pg-picked'] },
        deny: new Set(['sp-secret']),
        source: { origin: ORIGIN, label: 'SRC', issuePrefix: 'CB' },
        appVersion: '0.40.0',
        readFile: async (file) => {
            const sealed = await source.store.get(objectKey('local', 'main', file.ownerUserId, file.id));
            return sealed && box.openBytes(sealed, `${file.ownerUserId}/${file.id}`);
        },
        now: T0 + 100_000,
        ...overrides,
    });
    return { out, ...result };
}

/** Every table's rows, hashed: what changed, table by table. */
function fingerprint(db: DatabaseSync) {
    const tables = (
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'page_search_fts%' AND name NOT LIKE 'page_search_tri%' AND name NOT LIKE 'page_search_vocab%'",
            )
            .all() as { name: string }[]
    ).map((row) => row.name);
    return Object.fromEntries(
        tables.map((table) => {
            const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY 1`).all();
            const text = JSON.stringify(rows, (_key, value) =>
                value instanceof Uint8Array
                    ? Buffer.from(value).toString('hex')
                    : typeof value === 'bigint'
                      ? String(value)
                      : value,
            );
            return [table, createHash('sha256').update(text).digest('hex')];
        }),
    );
}
const changedTables = (before: Record<string, string>, after: Record<string, string>) =>
    Object.keys(after)
        .filter((table) => before[table] !== after[table])
        .sort();

function importer(db: DatabaseSync, bundle: BundleReader, dir: string, extra: Partial<ImportOptions> = {}) {
    const store = new LocalObjectStore(join(dir, 'target-userdata'));
    const snapshot = vi.fn(async () => join(dir, 'pre-import.sqlite'));
    const options: ImportOptions = {
        db,
        bundle,
        operatorId: 'op',
        files: sealedFileSink({ db, keys: TARGET_KEYS, store, tenantId: 'main' }),
        safety: { lastBackupAt: () => Date.now() - 60_000, snapshot },
        now: () => T0 + 200_000,
        pause: async () => undefined,
        ...extra,
    };
    return { store, snapshot, run: (more: Partial<ImportOptions> = {}) => importBundle({ ...options, ...more }) };
}

let dir: string;
beforeEach(() => {
    dir = scratch();
});

describe('export', () => {
    it('writes a private bundle with hashes, users for mapping, and nothing denied', async () => {
        const source = await seedSource(dir);
        const { out, manifest, warnings } = await makeBundle(dir, source);
        expect(warnings).toEqual([]);
        expect(statSync(out).mode & 0o777).toBe(0o700);
        for (const name of ['manifest.json', 'issues.jsonl', 'pages.jsonl', 'spaces.jsonl', 'users.json']) {
            expect(statSync(join(out, name)).mode & 0o777).toBe(0o600);
        }
        expect(manifest.counts).toMatchObject({
            spaces: 2,
            pages: 3,
            images: 1,
            issues: 2,
            comments: 3,
            attachments: 1,
            votes: 2,
        });
        expect(manifest.selection.issues).toEqual([1, 2]);
        // Parents before children; the unpicked parent is not there, so the picked page is a root.
        const pages = readFileSync(join(out, 'pages.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(pages.map((p) => p.id)).toEqual(['pg-root', 'pg-picked', 'pg-child']);
        expect(pages.find((p) => p.id === 'pg-picked').parentId).toBeNull();
        // The image is unsealed in the bundle, named by its hash.
        const sha = createHash('sha256').update(PNG).digest('hex');
        expect(readFileSync(join(out, 'files', sha)).equals(PNG)).toBe(true);
        // Only the people the records name, and nothing of the denied Space.
        const users = JSON.parse(readFileSync(join(out, 'users.json'), 'utf8'));
        expect(users.map((u: { id: string }) => u.id).sort()).toEqual(['alice', 'bob', 'dot:scout']);
        const all = readdirSync(out)
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => readFileSync(join(out, name), 'utf8'))
            .join('\n');
        expect(all).not.toContain('Never read.');
        expect(all).not.toContain('"sp-secret"');
    });

    it('refuses a selection that reaches a denied Space, before writing anything', async () => {
        const source = await seedSource(dir);
        const readFile = vi.fn();
        await expect(
            makeBundle(dir, source, { selection: { issues: [], spaces: ['sp-secret'], pages: [] }, readFile }),
        ).rejects.toThrow('deny-list');
        await expect(
            makeBundle(dir, source, { selection: { issues: [], spaces: [], pages: ['pg-secret'] }, readFile }, 'b2'),
        ).rejects.toThrow('deny-list');
        expect(readFile).not.toHaveBeenCalled();
        expect(existsSync(join(dir, 'bundle'))).toBe(false);
        expect(existsSync(join(dir, 'bundle.partial'))).toBe(false);
    });

    it('refuses ids that are not there, and an existing directory', async () => {
        const source = await seedSource(dir);
        await expect(makeBundle(dir, source, { selection: { issues: [4], spaces: [], pages: [] } })).rejects.toThrow(
            'Issue 4',
        );
        await makeBundle(dir, source);
        await expect(makeBundle(dir, source)).rejects.toThrow('exists already');
    });
});

describe('import', () => {
    it('plans without writing anything (the dry run)', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const before = fingerprint(db);
        const { run, snapshot, store } = importer(db, await BundleReader.open(out), dir);
        const report = await run();
        expect(fingerprint(db)).toEqual(before);
        expect(snapshot).not.toHaveBeenCalled();
        expect(existsSync(store.root)).toBe(false);
        expect(report.apply).toBe(false);
        expect(report.counts.issue).toEqual({ create: 2 });
        expect(report.counts.page).toEqual({ create: 3 });
        expect(report.numbers).toEqual({ kept: 2, taken: [] });
        expect(report.authors.unmapped.map((a) => a.name).sort()).toEqual(['Bob Example', 'Scout']);
        expect(report.authors.mapped.map((a) => a.name)).toEqual(['Alice Example']);
        expect(report.notCopied.issues).toEqual([3]);
        expect(report.notCopied.pages).toEqual(['pg-secret']);
        expect(report.bytes).toEqual({ attachments: 4096, images: PNG.length });
        expect(report.rewrites.samples.some((s) => s.after.includes(`${ORIGIN}/issues/CB-3`))).toBe(true);
        expect(reportLines(report).join('\n')).toContain('Dry run');
    });

    it('refuses to apply without a recent backup, and copies the database first', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const before = fingerprint(db);
        const bundle = await BundleReader.open(out);
        const { run, snapshot } = importer(db, bundle, dir);
        await expect(
            run({ apply: true, safety: { lastBackupAt: () => T0 + 200_000 - 16 * 60_000, snapshot } }),
        ).rejects.toThrow('no full backup');
        await expect(run({ apply: true, safety: { lastBackupAt: () => undefined, snapshot } })).rejects.toThrow(
            'no full backup',
        );
        await expect(run({ apply: true, safety: undefined })).rejects.toThrow('backup check');
        expect(snapshot).not.toHaveBeenCalled();
        expect(fingerprint(db)).toEqual(before);
        const report = await run({ apply: true, safety: { lastBackupAt: () => T0 + 200_000 - 60_000, snapshot } });
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(report.backupPath).toBe(join(dir, 'pre-import.sqlite'));
    });

    it('keeps ids, numbers and times, maps people by email and writes bylines for the rest', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const { run } = importer(db, await BundleReader.open(out), dir);
        await run({ apply: true });

        const one = db.prepare('SELECT * FROM issues WHERE number = 1').get() as Record<string, unknown>;
        expect(one).toMatchObject({
            id: 'is-1',
            source: 'import',
            reporterId: 'alice-here',
            assigneeId: 'alice-here',
            createdAt: T0,
            updatedAt: T0 + 500,
            status: 'open',
        });
        // The mention of an issue that wasn't copied points at the source; code is unchanged.
        expect(one.body).toBe(`Needs CB-2 and [CB-3 (SRC)](${ORIGIN}/issues/CB-3).\n\n\`\`\`\nCB-3 stays\n\`\`\``);
        const two = db.prepare('SELECT reporterId, closedAt FROM issues WHERE number = 2').get();
        expect(two).toEqual({ reporterId: 'import', closedAt: T0 + 2 });
        expect(db.prepare('SELECT last FROM issue_counter').get()).toEqual({ last: 2 });
        expect(db.prepare("SELECT label FROM issue_labels WHERE issueId='is-1' ORDER BY label").all()).toEqual([
            { label: 'erden' },
            { label: 'ontology' },
        ]);

        const comments = db
            .prepare(
                "SELECT id, authorKind, authorId, body, createdAt, editedAt FROM issue_comments WHERE issueId='is-1' ORDER BY createdAt, id",
            )
            .all() as Array<Record<string, unknown>>;
        // The import's note first, then the comments that weren't deleted.
        expect(comments.map((c) => c.id).slice(1)).toEqual(['c-1', 'c-2', 'c-3']);
        const note = comments[0]!;
        expect(note).toMatchObject({ authorKind: 'system', authorId: null, createdAt: T0 });
        expect(note.body).toContain(`Imported from SRC CB-1 (${ORIGIN}/issues/CB-1)`);
        expect(note.body).toContain('1 vote on SRC from people who aren’t here.');
        expect(note.body).toContain('Was blocked by CB-3 on SRC.');
        expect(comments[1]).toMatchObject({
            authorKind: 'user',
            authorId: 'alice-here',
            body: `Agree, see [CB-3 (SRC)](${ORIGIN}/issues/CB-3).`,
        });
        expect(comments[2]).toMatchObject({
            authorKind: 'user',
            authorId: 'import',
            editedAt: T0 + 25,
            body: '_Originally by Bob Example on SRC, 2026-10-01._\n\nMe too.',
        });
        expect(comments[3]).toMatchObject({
            authorKind: 'system',
            authorId: null,
            body: '_Originally by socio Scout on SRC, 2026-10-01._\n\nFiled from a chat.',
        });
        const noteTwo = db.prepare("SELECT body FROM issue_comments WHERE issueId='is-2'").get() as { body: string };
        expect(noteTwo.body).toContain('Originally filed by Bob Example on SRC, 2026-10-01.');

        // Votes for mapped people only; history kept with mapped actors, plus the import's event.
        expect(db.prepare("SELECT id, userId FROM issue_votes WHERE issueId='is-1'").all()).toEqual([
            { id: 'v-1', userId: 'alice-here' },
        ]);
        expect(
            db
                .prepare(
                    "SELECT id, actorId, kind, toValue, createdAt FROM issue_events WHERE issueId='is-1' ORDER BY seq",
                )
                .all(),
        ).toEqual([
            { id: 'e-1', actorId: 'alice-here', kind: 'created', toValue: 'triage', createdAt: T0 },
            { id: 'e-2', actorId: 'import', kind: 'status', toValue: 'open', createdAt: T0 + 60 },
            expect.objectContaining({ actorId: 'import', kind: 'imported', toValue: 'open', createdAt: T0 + 200_000 }),
        ]);
        // Links where both ends came; the attachment with its bytes and comment.
        expect(db.prepare('SELECT id FROM issue_links').all()).toEqual([]);
        expect(db.prepare('SELECT id, fromId, toId FROM issue_relations').all()).toEqual([
            { id: 'r-1', fromId: 'is-1', toId: 'is-2' },
        ]);
        const attachment = db
            .prepare("SELECT commentId, uploaderId, data FROM issue_attachments WHERE id='at-1'")
            .get() as {
            commentId: string;
            uploaderId: string;
            data: Uint8Array;
        };
        expect(attachment.commentId).toBe('c-2');
        expect(attachment.uploaderId).toBe('import');
        expect(attachment.data.length).toBe(4096);

        // Spaces and pages: tree, tags, links, cover, members, search.
        expect(db.prepare("SELECT name FROM spaces WHERE id='sp-research'").get()).toEqual({ name: 'Research' });
        expect(db.prepare("SELECT membersOnly FROM space_settings WHERE spaceId='sp-research'").get()).toEqual({
            membersOnly: 1,
        });
        expect(db.prepare("SELECT userId, role FROM space_members WHERE spaceId='sp-research'").all()).toEqual([
            { userId: 'alice-here', role: 'editor' },
        ]);
        const pages = db
            .prepare('SELECT id, spaceId, parentId, createdBy, coverId, content, createdAt FROM pages ORDER BY id')
            .all() as Array<Record<string, unknown>>;
        expect(pages.map((p) => [p.id, p.spaceId, p.parentId])).toEqual([
            ['pg-child', 'sp-research', 'pg-root'],
            ['pg-picked', 'sp-everyday', null],
            ['pg-root', 'sp-research', null],
        ]);
        const root = pages.find((p) => p.id === 'pg-root')!;
        expect(root).toMatchObject({ createdBy: 'alice-here', coverId: EMBED, createdAt: T0 });
        expect(root.content).toContain('Tracks CB-1 and [CB-3 (SRC)]');
        expect(root.content).toContain('[child](/spaces/sp-research/pages/pg-child)');
        const child = pages.find((p) => p.id === 'pg-child')!;
        expect(child.createdBy).toBeNull();
        expect(child.content).toMatch(/^_Originally by Bob Example on SRC, 2026-10-01\._/);
        expect(child.content).toContain('echo CB-3');
        expect(child.content).toContain(`${ORIGIN}/spaces/sp-secret/pages/pg-secret`);
        expect(db.prepare("SELECT tag FROM page_tags WHERE pageId='pg-root'").all()).toEqual([{ tag: 'erden' }]);
        expect(db.prepare('SELECT id FROM page_links').all()).toEqual([{ id: 'pl-1' }]);
        expect(
            db
                .prepare(
                    "SELECT p.pageId FROM page_search_fts f JOIN page_search p ON p.id = f.rowid WHERE page_search_fts MATCH 'ontology'",
                )
                .all(),
        ).toEqual([{ pageId: 'pg-root' }]);
    });

    it('seals page images again with the target’s keys', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const { run, store } = importer(db, await BundleReader.open(out), dir);
        await run({ apply: true });
        const embed = db.prepare('SELECT fileId, ownerUserId, spaceId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
            spaceId: string;
        };
        expect(embed).toMatchObject({ ownerUserId: 'op', spaceId: 'sp-research' });
        const file = db.prepare('SELECT path, size, sealKey, storage FROM data_files WHERE id=?').get(embed.fileId) as {
            path: string;
            size: number;
            sealKey: string;
            storage: string;
        };
        expect(file).toMatchObject({ path: `imported/src/${EMBED}.png`, size: PNG.length, storage: 'local' });
        const targetBox = new SecretBox(TARGET_KEYS, 'data-files');
        expect(file.sealKey).toBe(targetBox.currentKey);
        const sealed = (await store.get(objectKey('local', 'main', 'op', embed.fileId)))!;
        expect(targetBox.openBytes(sealed, `op/${embed.fileId}`).equals(PNG)).toBe(true);
        // Not the source's seal: its keys can't open it.
        expect(() => new SecretBox(SOURCE_KEYS, 'data-files').openBytes(sealed, `op/${embed.fileId}`)).toThrow();
        expect(Buffer.from(sealed).includes(PNG.subarray(16, 64))).toBe(false);
    });

    it('is idempotent: a second run of the same bundle changes nothing', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const bundle = await BundleReader.open(out);
        const { run } = importer(db, bundle, dir);
        await run({ apply: true });
        const after = fingerprint(db);
        const again = await run({ apply: true });
        const changed = changedTables(after, fingerprint(db));
        // Only the run's own record.
        expect(changed).toEqual(['import_runs']);
        for (const [kind, actions] of Object.entries(again.counts)) {
            expect(Object.keys(actions), kind).toEqual(['unchanged']);
        }
        expect(db.prepare('SELECT count(*) AS n FROM import_runs').get()).toEqual({ n: 2 });
    });

    it('updates what nobody here edited from a newer bundle, and keeps edits made here', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        const first = await makeBundle(dir, source);
        await importer(db, await BundleReader.open(first.out), dir).run({ apply: true });

        // Here: someone edits CB-1's title and deletes Bob's comment.
        db.prepare("UPDATE issues SET title='Edited here' WHERE id='is-1'").run();
        db.prepare("UPDATE issue_comments SET deletedAt=1, deletedBy='op' WHERE id='c-2'").run();
        // There: both issues change, a comment and a page too, and CB-2 gets a new comment.
        source.db.prepare("UPDATE issues SET body='New body', status='in_progress' WHERE id IN ('is-1','is-2')").run();
        source.db.prepare("UPDATE issue_comments SET body='Me too, edited.' WHERE id='c-2'").run();
        source.db.prepare("UPDATE pages SET content='Rewritten child.' WHERE id='pg-child'").run();
        source.db
            .prepare(
                "INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt) VALUES ('c-9', 'is-2', 'user', 'alice', 'Later.', ?)",
            )
            .run(T0 + 90_000);
        const second = await makeBundle(dir, source, {}, 'bundle-2');
        const report = await importer(db, await BundleReader.open(second.out), dir).run({ apply: true });

        expect(report.counts.issue).toEqual({ conflict: 1, update: 1 });
        expect(report.conflicts).toContainEqual({
            kind: 'issue',
            id: 'is-1',
            reason: 'edited here since it was imported',
        });
        expect(db.prepare("SELECT title, body, status FROM issues WHERE id='is-1'").get()).toEqual({
            title: 'Edited here',
            body: `Needs CB-2 and [CB-3 (SRC)](${ORIGIN}/issues/CB-3).\n\n\`\`\`\nCB-3 stays\n\`\`\``,
            status: 'open',
        });
        expect(db.prepare("SELECT body, status FROM issues WHERE id='is-2'").get()).toEqual({
            body: 'New body',
            status: 'in_progress',
        });
        // Deleted here stays deleted; new comments arrive.
        expect(db.prepare("SELECT deletedAt FROM issue_comments WHERE id='c-2'").get()).toEqual({ deletedAt: 1 });
        expect(db.prepare("SELECT body FROM issue_comments WHERE id='c-9'").get()).toEqual({ body: 'Later.' });
        // The page nobody edited here is updated, its old text kept as a revision.
        expect(db.prepare("SELECT content, revision FROM pages WHERE id='pg-child'").get()).toEqual({
            content: '_Originally by Bob Example on SRC, 2026-10-01._\n\nRewritten child.',
            revision: 2,
        });
        expect(db.prepare("SELECT revision, encoding FROM page_revisions WHERE pageId='pg-child'").get()).toEqual({
            revision: 1,
            encoding: 'utf8',
        });
    });

    it('with keepNumbersStrict, never takes or changes a number another issue has here', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        db.prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('mine', 2, 'Mine', '', 'open', 'low', 'bug', 'op', 'web', 1, 1)",
        ).run();
        const report = await importer(db, await BundleReader.open(out), dir).run({
            apply: true,
            keepNumbersStrict: true,
        });
        expect(report.renumbered).toEqual([]);
        expect(report.numbers).toEqual({ kept: 1, taken: [2] });
        expect(db.prepare('SELECT id FROM issues WHERE number=2').get()).toEqual({ id: 'mine' });
        // CB-1's mention of CB-2 now points at the source, never at the unrelated local CB-2.
        const one = db.prepare('SELECT id FROM issues WHERE number=1').get();
        expect(one).toEqual({ id: 'is-1' });
        const comment = db
            .prepare("SELECT body FROM issue_comments WHERE issueId='is-1' AND authorKind='system'")
            .get() as {
            body: string;
        };
        expect(comment.body).toContain('Was related to CB-2 on SRC.');
        expect((db.prepare("SELECT body FROM issues WHERE id='is-1'").get() as { body: string }).body).toContain(
            `[CB-2 (SRC)](${ORIGIN}/issues/CB-2)`,
        );
    });

    it('sends no notifications: it writes only its own tables, asks nothing over the network, and fires no watch', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        const first = await makeBundle(dir, source);
        const fetch = vi.fn(() => Promise.reject(new Error('no network in an import')));
        vi.stubGlobal('fetch', fetch);
        const before = fingerprint(db);
        await importer(db, await BundleReader.open(first.out), dir).run({ apply: true });
        const allowed = new Set<string>([...IMPORT_TABLES, 'change_counters']);
        expect(changedTables(before, fingerprint(db)).filter((table) => !allowed.has(table))).toEqual([]);

        // Someone here watches CB-2 for "done"; a newer bundle moves it there.
        db.prepare(
            "INSERT INTO issue_watches(id, userId, targetStatus, state, fingerprint, cursor, createdAt, sourceKind, sourceId) VALUES ('w-1', 'alice-here', 'done', 'watching', '2|done', (SELECT MAX(seq) FROM issue_events), 1, 'person', 'alice-here')",
        ).run();
        db.prepare(
            "INSERT INTO issue_watch_members(watchId, issueId, number, status) VALUES ('w-1', 'is-2', 2, 'in_progress')",
        ).run();
        source.db.prepare("UPDATE issues SET status='wont_fix' WHERE id='is-2'").run();
        source.db
            .prepare(
                "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES ('e-9', 'is-2', 'bob', 'status', 'done', 'wont_fix', ?)",
            )
            .run(T0 + 9);
        const second = await makeBundle(dir, source, {}, 'bundle-2');
        const middle = fingerprint(db);
        const report = await importer(db, await BundleReader.open(second.out), dir).run({ apply: true });
        expect(changedTables(middle, fingerprint(db)).filter((table) => !allowed.has(table))).toEqual([]);
        // The watch sees the new status as known; no status event it would replay was added.
        expect(db.prepare("SELECT status FROM issue_watch_members WHERE watchId='w-1'").get()).toEqual({
            status: 'wont_fix',
        });
        expect(db.prepare("SELECT 1 FROM issue_events WHERE id='e-9'").get()).toBeUndefined();
        expect(db.prepare('SELECT count(*) AS n FROM issue_watch_outbox').get()).toEqual({ n: 0 });
        expect(report.warnings.some((w) => w.includes('CB-2: newer status history left out'))).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refuses a bundle from another schema, a tampered file, and a Space map to nowhere', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        writeFileSync(
            join(out, 'manifest.json'),
            JSON.stringify({ ...manifest, schema: { ...manifest.schema, issues: 1 } }),
        );
        await expect(importer(db, await BundleReader.open(out), dir).run()).rejects.toThrow('another schema');
        writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
        const bundle = await BundleReader.open(out);
        await expect(importer(db, bundle, dir).run({ spaceMap: { 'sp-everyday': 'nowhere' } })).rejects.toThrow(
            'no live Space nowhere',
        );
        writeFileSync(
            join(out, 'issues.jsonl'),
            readFileSync(join(out, 'issues.jsonl'), 'utf8').replace('Ontology', 'Ontolgy'),
        );
        await expect(BundleReader.open(out)).rejects.toThrow('doesn’t match its sha256');
    });

    it('puts a source Space’s pages into an existing Space here with --space-map', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        db.prepare("INSERT INTO spaces(id, name, description, createdAt) VALUES ('sp-socio', 'Socio', '', 1)").run();
        await importer(db, await BundleReader.open(out), dir).run({
            apply: true,
            spaceMap: { 'sp-everyday': 'sp-socio' },
        });
        expect(db.prepare("SELECT spaceId FROM pages WHERE id='pg-picked'").get()).toEqual({ spaceId: 'sp-socio' });
        expect(db.prepare("SELECT 1 FROM spaces WHERE id='sp-everyday'").get()).toBeUndefined();
    });
});

describe('review regressions', () => {
    it('never overwrites an edit made here while the import runs', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        // There: the root page changes, and the child (written after it) gets a new picture.
        const sink = sealedFileSink({ db: source.db, keys: SOURCE_KEYS, store: source.store, tenantId: 'main' });
        const fileId = await sink.put({
            ownerUserId: 'alice',
            path: 'pics/b.png',
            name: 'b.png',
            mediaType: 'image/png',
            bytes: PNG,
        });
        const second = 'cbemb_second_0123456789';
        source.db
            .prepare(
                "INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES (?, ?, 'alice', NULL, 'sp-research', '', ?)",
            )
            .run(second, fileId, T0);
        source.db.prepare("UPDATE pages SET content='Root, rewritten there.' WHERE id='pg-root'").run();
        source.db
            .prepare("UPDATE pages SET content = content || ? WHERE id='pg-child'")
            .run(`\n\n\`\`\`image\n${JSON.stringify({ id: second })}\n\`\`\``);
        const bundle = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        // Here: someone edits the root page while the child's picture is being stored.
        const store = new LocalObjectStore(join(dir, 'target-userdata'));
        const real = sealedFileSink({ db, keys: TARGET_KEYS, store, tenantId: 'main' });
        const files = {
            put: async (input: Parameters<typeof real.put>[0]) => {
                db.prepare("UPDATE pages SET content='Edited here meanwhile.' WHERE id='pg-root'").run();
                return real.put(input);
            },
        };
        const report = await importer(db, bundle, dir).run({ apply: true, files, chunkSize: 1000 });
        expect(db.prepare("SELECT content FROM pages WHERE id='pg-root'").get()).toEqual({
            content: 'Edited here meanwhile.',
        });
        expect(report.conflicts).toContainEqual({
            kind: 'page',
            id: 'pg-root',
            reason: 'changed here while the import ran',
        });
        expect(report.counts.page?.conflict).toBe(1);
        // A later run still sees the edit as made here.
        const third = await importer(db, bundle, dir).run({ apply: true });
        expect(third.conflicts).toContainEqual({
            kind: 'page',
            id: 'pg-root',
            reason: 'edited here since it was imported',
        });
        expect(db.prepare("SELECT content FROM pages WHERE id='pg-root'").get()).toEqual({
            content: 'Edited here meanwhile.',
        });
    });

    it('refuses an export whose allowed page shows an image of a denied Space', async () => {
        const source = await seedSource(dir);
        const hidden = 'cbemb_hidden_0123456789';
        source.db
            .prepare(
                "INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) SELECT ?, fileId, ownerUserId, NULL, 'sp-secret', '', 1 FROM media_embeds WHERE id=?",
            )
            .run(hidden, EMBED);
        source.db
            .prepare("UPDATE pages SET content = ? WHERE id='pg-picked'")
            .run(`\`\`\`image\n${JSON.stringify({ id: hidden })}\n\`\`\``);
        const readFile = vi.fn();
        await expect(makeBundle(dir, source, { readFile })).rejects.toThrow('on the deny-list');
        expect(readFile).not.toHaveBeenCalled();
        expect(existsSync(join(dir, 'bundle'))).toBe(false);
    });

    it('follows a Space becoming members-only at the source, and never puts its pages in an open Space', async () => {
        const source = await seedSource(dir);
        source.db.prepare("DELETE FROM space_settings WHERE spaceId='sp-research'").run();
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        expect(db.prepare("SELECT membersOnly FROM space_settings WHERE spaceId='sp-research'").get()).toBeUndefined();

        // There: the Space becomes members-only, with a new page. Here: nobody touched it.
        source.db
            .prepare(
                "INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES ('sp-research', 1, 'alice', 1)",
            )
            .run();
        source.db
            .prepare(
                "INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt) VALUES ('pg-new', 'sp-research', NULL, 'New', 'Private now.', 1, 1, 1)",
            )
            .run();
        const second = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        await importer(db, second, dir).run({ apply: true });
        expect(db.prepare("SELECT membersOnly FROM space_settings WHERE spaceId='sp-research'").get()).toEqual({
            membersOnly: 1,
        });
        expect(db.prepare("SELECT 1 AS ok FROM pages WHERE id='pg-new'").get()).toEqual({ ok: 1 });

        // Here someone opens it again and renames it: the next page from there is not copied.
        db.prepare("UPDATE space_settings SET membersOnly=0 WHERE spaceId='sp-research'").run();
        db.prepare("UPDATE spaces SET name='Renamed' WHERE id='sp-research'").run();
        source.db
            .prepare(
                "INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt) VALUES ('pg-newer', 'sp-research', NULL, 'Newer', 'Also private.', 1, 2, 2)",
            )
            .run();
        const third = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-3')).out);
        const report = await importer(db, third, dir).run({ apply: true });
        expect(db.prepare("SELECT 1 FROM pages WHERE id='pg-newer'").get()).toBeUndefined();
        expect(report.warnings.some((w) => w.includes('members-only at the source but not here'))).toBe(true);
        // Mapped into an open Space here: skipped the same way.
        db.prepare("INSERT INTO spaces(id, name, description, createdAt) VALUES ('sp-open', 'Open', '', 1)").run();
        const mapped = await importer(db, third, dir).run({ apply: true, spaceMap: { 'sp-research': 'sp-open' } });
        expect(mapped.counts.page?.create).toBeUndefined();
        expect(db.prepare("SELECT count(*) AS n FROM pages WHERE spaceId='sp-open'").get()).toEqual({ n: 0 });
    });

    it('never publishes a members-only Space’s images in a Space that opened while the import ran', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        db.prepare(
            "INSERT INTO spaces(id, name, description, createdAt) VALUES ('sp-priv', 'Private here', '', 1)",
        ).run();
        db.prepare(
            "INSERT INTO space_settings(spaceId, membersOnly, updatedBy, updatedAt) VALUES ('sp-priv', 1, 'op', 1)",
        ).run();
        const store = new LocalObjectStore(join(dir, 'target-userdata'));
        const real = sealedFileSink({ db, keys: TARGET_KEYS, store, tenantId: 'main' });
        const files = {
            put: async (input: Parameters<typeof real.put>[0]) => {
                db.prepare("UPDATE space_settings SET membersOnly=0 WHERE spaceId='sp-priv'").run();
                return real.put(input);
            },
        };
        const bundle = await BundleReader.open((await makeBundle(dir, source)).out);
        const report = await importer(db, bundle, dir).run({
            apply: true,
            files,
            chunkSize: 1000,
            spaceMap: { 'sp-research': 'sp-priv' },
        });
        expect(db.prepare('SELECT count(*) AS n FROM media_embeds').get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM pages WHERE spaceId='sp-priv'").get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM page_tags').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM page_links').get()).toEqual({ n: 0 });
        expect(report.conflicts).toContainEqual({
            kind: 'page',
            id: 'pg-root',
            reason: 'the Space here isn’t members-only',
        });
    });

    it('adds nothing to an issue that is already here but not from this source', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        db.prepare(
            "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('is-1', 1, 'Restored copy', '', 'open', 'low', 'bug', 'op', 'web', 1, 1)",
        ).run();
        const bundle = await BundleReader.open((await makeBundle(dir, source)).out);
        const report = await importer(db, bundle, dir).run({ apply: true });
        expect(db.prepare("SELECT count(*) AS n FROM issue_comments WHERE issueId='is-1'").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM issue_votes WHERE issueId='is-1'").get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM issue_relations').get()).toEqual({ n: 0 });
        expect(report.numbers.taken).toEqual([1]);
        expect(report.conflicts).toContainEqual({
            kind: 'issue',
            id: 'CB-1',
            reason: 'already here, not from this source',
        });
        // CB-2 mentions CB-1: it points at the source, not at the copy here.
        expect((db.prepare("SELECT body FROM issues WHERE id='is-2'").get() as { body: string }).body).toContain(
            `[CB-1 (SRC)](${ORIGIN}/issues/CB-1)`,
        );
    });

    it('leaves out an image a page shows from another Space', async () => {
        const source = await seedSource(dir);
        source.db
            .prepare("UPDATE pages SET content = ? WHERE id='pg-picked'")
            .run(`\`\`\`image\n${JSON.stringify({ id: EMBED })}\n\`\`\``);
        const { out, warnings } = await makeBundle(dir, source);
        expect(warnings).toEqual([`Page pg-picked: image ${EMBED} belongs to another Space; left out.`]);
        const pages = readFileSync(join(out, 'pages.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(pages.find((p) => p.id === 'pg-picked').images).toEqual([]);
        expect(pages.find((p) => p.id === 'pg-root').images).toHaveLength(1);
    });

    it('reads records with a bounded line, refusing a long one before holding it', async () => {
        const path = join(dir, 'lines.jsonl');
        writeFileSync(path, `a\n${'b'.repeat(300_000)}\nc`);
        const read = async (max: number) => {
            const out: string[] = [];
            for await (const line of boundedLines(path, max)) {
                out.push(line.length > 10 ? `${line.length}` : line);
            }
            return out;
        };
        expect(await read(400_000)).toEqual(['a', '300000', 'c']);
        await expect(read(1000)).rejects.toThrow('line 2 is too long');
        writeFileSync(path, 'x'.repeat(2_000_000));
        await expect(read(1000)).rejects.toThrow('line 1 is too long');
    });

    it('refuses an image whose declared size isn’t its file’s', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const pages = join(out, 'pages.jsonl');
        writeFileSync(pages, readFileSync(pages, 'utf8').replace(`"size":${PNG.length}`, '"size":0'));
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        manifest.files['pages.jsonl'] = await hashFile(pages);
        writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
        const db = seedTarget();
        await expect(importer(db, await BundleReader.open(out), dir).run()).rejects.toThrow('no matching file');
    });

    it('reuses a file at the import path only when it holds the same bytes', async () => {
        const db = seedTarget();
        const store = new LocalObjectStore(join(dir, 'sink'));
        const sink = sealedFileSink({ db, keys: TARGET_KEYS, store, tenantId: 'main' });
        const input = { ownerUserId: 'op', path: 'imported/x.png', name: 'x.png', mediaType: 'image/png' };
        const id = await sink.put({ ...input, bytes: Buffer.from('abcd') });
        expect(await sink.put({ ...input, bytes: Buffer.from('abcd') })).toBe(id);
        await expect(sink.put({ ...input, bytes: Buffer.from('wxyz') })).rejects.toThrow('another file');
    });

    it('checks watches as each chunk commits: a watch made meanwhile never fires', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        const issuesOnly = { selection: { issues: [1, 2], spaces: [], pages: [] } };
        await importer(db, await BundleReader.open((await makeBundle(dir, source, issuesOnly)).out), dir).run({
            apply: true,
        });
        source.db.prepare("UPDATE issues SET status='wont_fix' WHERE id='is-2'").run();
        source.db.prepare("UPDATE issues SET title='Ontology layer, renamed' WHERE id='is-1'").run();
        source.db
            .prepare(
                "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES ('e-9', 'is-2', 'bob', 'status', 'done', 'wont_fix', ?)",
            )
            .run(T0 + 9);
        const bundle = await BundleReader.open((await makeBundle(dir, source, issuesOnly, 'bundle-2')).out);
        // After CB-1's chunk commits, before CB-2's does, someone here starts watching CB-2.
        let armed = false;
        const pause = async () => {
            if (armed) {
                return;
            }
            armed = true;
            await sqliteData(db).uow.transact(
                () => {
                    db.prepare(
                        "INSERT INTO issue_watches(id, userId, targetStatus, state, fingerprint, cursor, createdAt, sourceKind, sourceId) VALUES ('w-1', 'alice-here', 'wont_fix', 'watching', '2|wont_fix', (SELECT MAX(seq) FROM issue_events), 1, 'person', 'alice-here')",
                    ).run();
                    db.prepare(
                        "INSERT INTO issue_watch_members(watchId, issueId, number, status) VALUES ('w-1', 'is-2', 2, 'done')",
                    ).run();
                },
                { label: 'a watch made meanwhile' },
            );
        };
        const report = await importer(db, bundle, dir).run({ apply: true, chunkSize: 1, pause });
        expect(db.prepare("SELECT status FROM issues WHERE id='is-2'").get()).toEqual({ status: 'wont_fix' });
        expect(db.prepare("SELECT 1 FROM issue_events WHERE id='e-9'").get()).toBeUndefined();
        expect(report.warnings).toContain('CB-2: newer status history left out (someone here watches it).');
        const board = sqliteBoard(db, { userExists: () => true, deactivated: () => false, dot: () => undefined });
        await board.watches.replay();
        expect(db.prepare('SELECT count(*) AS n FROM issue_watch_outbox').get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT state FROM issue_watches WHERE id='w-1'").get()).toEqual({ state: 'watching' });
    });

    it('never puts pages into a Space removed here for good', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        db.prepare("DELETE FROM spaces WHERE id='sp-research'").run();
        source.db
            .prepare(
                "INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt) VALUES ('pg-new', 'sp-research', NULL, 'New', 'Body', 1, 1, 1)",
            )
            .run();
        const bundle = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        await importer(db, bundle, dir).run({ apply: true });
        expect(db.prepare("SELECT 1 FROM pages WHERE id='pg-new'").get()).toBeUndefined();
        expect(db.prepare("SELECT 1 FROM spaces WHERE id='sp-research'").get()).toBeUndefined();
    });

    it('points mentions of an issue deleted here at the source', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        db.prepare("UPDATE issues SET deletedAt=1, deletedBy='op' WHERE id='is-2'").run();
        source.db.prepare("UPDATE issues SET body='Now after CB-2.' WHERE id='is-1'").run();
        const bundle = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        const report = await importer(db, bundle, dir).run({ apply: true });
        expect(db.prepare("SELECT body FROM issues WHERE id='is-1'").get()).toEqual({
            body: `Now after [CB-2 (SRC)](${ORIGIN}/issues/CB-2).`,
        });
        expect(report.counts.issue?.skip).toBe(1);
        expect(db.prepare("SELECT deletedAt FROM issues WHERE id='is-2'").get()).toEqual({ deletedAt: 1 });
    });

    it('round-trips an issue whose history holds a long description', async () => {
        const source = await seedSource(dir);
        const board = sqliteBoard(source.db, {
            userExists: () => true,
            deactivated: () => false,
            dot: () => undefined,
        });
        await board.issues.update(1, { body: 'y'.repeat(15_000) }, 'alice');
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const report = await importer(db, await BundleReader.open(out), dir).run({ apply: true });
        expect(report.counts.issue).toEqual({ create: 2 });
        const long = db
            .prepare("SELECT length(toValue) AS n FROM issue_events WHERE issueId='is-1' AND length(toValue) > 10000")
            .get();
        expect(long).toEqual({ n: 15_000 });
    });

    it('adds no attachment to a comment deleted here', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        db.prepare("UPDATE issue_comments SET deletedAt=1, deletedBy='op' WHERE id='c-1'").run();
        const data = randomBytes(512);
        source.db
            .prepare(
                "INSERT INTO issue_attachments(id, issueId, commentId, name, mediaType, size, sha256, data, uploaderId, createdAt) VALUES ('at-2', 'is-1', 'c-1', 'late.txt', 'text/plain', ?, ?, ?, 'alice', ?)",
            )
            .run(data.length, createHash('sha256').update(data).digest('hex'), data, T0 + 70);
        const bundle = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        const report = await importer(db, bundle, dir).run({ apply: true });
        expect(db.prepare("SELECT 1 FROM issue_attachments WHERE id='at-2'").get()).toBeUndefined();
        expect(report.conflicts).toContainEqual({
            kind: 'attachment',
            id: 'at-2',
            reason: 'its comment is deleted here',
        });
    });

    it('refuses to start when an issue took a kept number while the backup was copied', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        const snapshot = vi.fn(async () => {
            db.prepare(
                "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('new-here', 1, 'Filed meanwhile', '', 'open', 'low', 'bug', 'op', 'web', 1, 1)",
            ).run();
            return join(dir, 'copy.sqlite');
        });
        const before = { ...fingerprint(db) };
        await expect(
            importer(db, await BundleReader.open(out), dir).run({
                apply: true,
                safety: { lastBackupAt: () => Date.now(), snapshot },
            }),
        ).rejects.toThrow('CB-1 were filed here while the import prepared');
        // Only the issue filed meanwhile (and the live counters that follow it).
        expect(changedTables(before, fingerprint(db))).toEqual(['change_counters', 'issues']);
        expect(db.prepare('SELECT count(*) AS n FROM pages').get()).toEqual({ n: 0 });
        expect(db.prepare('SELECT count(*) AS n FROM import_runs').get()).toEqual({ n: 0 });
    });

    it('reserves the kept numbers: issues filed here during an import come after them', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(
            db,
            await BundleReader.open(
                (await makeBundle(dir, source, { selection: { issues: [2], spaces: [], pages: [] } })).out,
            ),
            dir,
        ).run({ apply: true });
        expect(db.prepare('SELECT last FROM issue_counter').get()).toEqual({ last: 2 });
    });

    it('lists sensitive details that only the history holds', async () => {
        const source = await seedSource(dir);
        source.db
            .prepare(
                "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES ('e-body', 'is-1', 'alice', 'body', 'See /home/someone/notes and BIGBOX', 'Clean.', ?)",
            )
            .run(T0 + 80);
        const { out } = await makeBundle(dir, source);
        const report = await importer(seedTarget(), await BundleReader.open(out), dir).run({ terms: ['bigbox'] });
        expect(report.sensitive.hits).toEqual(
            expect.arrayContaining([
                { kind: 'path', match: '/home/someone/notes', where: 'CB-1 history' },
                { kind: 'term', match: 'bigbox', where: 'CB-1 history' },
            ]),
        );
    });

    it('adds nothing to an issue deleted here after its records were planned', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        source.db
            .prepare(
                "INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt) VALUES ('c-9', 'is-1', 'user', 'alice', 'Later.', ?)",
            )
            .run(T0 + 90);
        const bundle = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        // The review list is read once per text as it is planned, in order:
        // 2 Spaces, 3 pages, CB-1's fields and history, then its comments.
        // CB-1 is deleted here right after its first comment is planned.
        let reads = 0;
        let deleted = false;
        const terms = {
            [Symbol.iterator]() {
                if (++reads === 9) {
                    deleted = true;
                    db.prepare("UPDATE issues SET deletedAt=1, deletedBy='op' WHERE id='is-1'").run();
                }
                return [][Symbol.iterator]();
            },
        };
        const report = await importer(db, bundle, dir).run({ apply: true, terms: terms as never });
        expect(deleted).toBe(true);
        expect(db.prepare("SELECT 1 FROM issue_comments WHERE id='c-9'").get()).toBeUndefined();
        expect(report.conflicts).toContainEqual({ kind: 'comment', id: 'c-9', reason: 'its issue is deleted here' });
    });

    it('leaves out a page whose image id is another image’s here', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        db.prepare(
            "INSERT INTO media_embeds(id, fileId, ownerUserId, dotId, spaceId, sourceUrl, createdAt) VALUES (?, 'other-file', 'op', NULL, 'elsewhere', '', 1)",
        ).run(EMBED);
        const report = await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({
            apply: true,
        });
        expect(db.prepare("SELECT 1 FROM pages WHERE id='pg-root'").get()).toBeUndefined();
        expect(report.conflicts).toContainEqual({
            kind: 'page',
            id: 'pg-root',
            reason: `its image ${EMBED} has an id another image has here; the page is left out`,
        });
        // Its child is still copied, as a root here.
        expect(db.prepare("SELECT parentId FROM pages WHERE id='pg-child'").get()).toEqual({ parentId: null });
    });

    it('updates an image whose bytes changed at the source', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        const { store } = importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir);
        await importer(db, await BundleReader.open(join(dir, 'bundle')), dir).run({ apply: true });
        const before = db.prepare('SELECT fileId FROM media_embeds WHERE id=?').get(EMBED) as { fileId: string };
        // There: the same file, new bytes.
        const file = source.db.prepare('SELECT fileId, ownerUserId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
        };
        const fresh = Buffer.concat([PNG.subarray(0, 8), randomBytes(1024)]);
        const box = new SecretBox(SOURCE_KEYS, 'data-files');
        await source.store.put(
            objectKey('local', 'main', file.ownerUserId, file.fileId),
            box.sealBytes(fresh, `${file.ownerUserId}/${file.fileId}`),
        );
        source.db.prepare('UPDATE data_files SET size=? WHERE id=?').run(fresh.length, file.fileId);
        const second = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        const report = await importer(db, second, dir).run({ apply: true });
        expect(report.counts.image).toEqual({ update: 1 });
        const after = db.prepare('SELECT fileId FROM media_embeds WHERE id=?').get(EMBED) as { fileId: string };
        expect(after.fileId).not.toBe(before.fileId);
        const sealed = (await store.get(objectKey('local', 'main', 'op', after.fileId)))!;
        expect(new SecretBox(TARGET_KEYS, 'data-files').openBytes(sealed, `op/${after.fileId}`).equals(fresh)).toBe(
            true,
        );
        // And again: nothing new.
        const third = await importer(db, second, dir).run({ apply: true });
        expect(third.counts.image).toEqual({ unchanged: 1 });
    });

    it('keeps a new image readable when another operator imports it, and never brings back one deleted here', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        person(db, 'op2', 'Second operator', null, 'admin');
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        const file = source.db.prepare('SELECT fileId, ownerUserId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
        };
        const box = new SecretBox(SOURCE_KEYS, 'data-files');
        const replace = async (bytes: Buffer) => {
            await source.store.put(
                objectKey('local', 'main', file.ownerUserId, file.fileId),
                box.sealBytes(bytes, `${file.ownerUserId}/${file.fileId}`),
            );
            source.db.prepare('UPDATE data_files SET size=? WHERE id=?').run(bytes.length, file.fileId);
        };
        const fresh = Buffer.concat([PNG.subarray(0, 8), randomBytes(512)]);
        await replace(fresh);
        const second = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out);
        const { store } = importer(db, second, dir);
        await importer(db, second, dir).run({ apply: true, operatorId: 'op2' });
        const embed = db.prepare('SELECT fileId, ownerUserId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
        };
        expect(embed.ownerUserId).toBe('op2');
        const sealed = (await store.get(objectKey('local', 'main', 'op2', embed.fileId)))!;
        expect(new SecretBox(TARGET_KEYS, 'data-files').openBytes(sealed, `op2/${embed.fileId}`).equals(fresh)).toBe(
            true,
        );

        // Here: the image's file is deleted. There: new bytes again. It stays deleted.
        db.prepare("UPDATE data_files SET deletedAt=1, deletedBy='op2' WHERE id=?").run(embed.fileId);
        await replace(Buffer.concat([PNG.subarray(0, 8), randomBytes(256)]));
        const third = await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-3')).out);
        const report = await importer(db, third, dir).run({ apply: true });
        expect(report.counts.image).toEqual({ skip: 1 });
        expect(db.prepare('SELECT fileId FROM media_embeds WHERE id=?').get(EMBED)).toEqual({ fileId: embed.fileId });
        expect(db.prepare('SELECT count(*) AS n FROM data_files WHERE deletedAt IS NULL').get()).toEqual({ n: 1 });
    });

    it('keeps an image whose file was replaced here', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        const embed = db.prepare('SELECT fileId FROM media_embeds WHERE id=?').get(EMBED) as { fileId: string };
        // Here: someone saves new bytes over the imported file (it keeps its id).
        db.prepare('UPDATE data_files SET updatedAt = updatedAt + 1 WHERE id=?').run(embed.fileId);
        const file = source.db.prepare('SELECT fileId, ownerUserId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
        };
        const fresh = Buffer.concat([PNG.subarray(0, 8), randomBytes(300)]);
        await source.store.put(
            objectKey('local', 'main', file.ownerUserId, file.fileId),
            new SecretBox(SOURCE_KEYS, 'data-files').sealBytes(fresh, `${file.ownerUserId}/${file.fileId}`),
        );
        source.db.prepare('UPDATE data_files SET size=? WHERE id=?').run(fresh.length, file.fileId);
        const report = await importer(
            db,
            await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out),
            dir,
        ).run({
            apply: true,
        });
        expect(report.counts.image).toEqual({ conflict: 1 });
        expect(db.prepare('SELECT fileId FROM media_embeds WHERE id=?').get(EMBED)).toEqual({ fileId: embed.fileId });
    });

    it('leaves #n shorthand in issue text alone and still points CB-n at the source', async () => {
        const source = await seedSource(dir);
        source.db
            .prepare("UPDATE issues SET body='Shipped in #524 and #141415, after #3 and #2; see CB-3.' WHERE id='is-1'")
            .run();
        const db = seedTarget();
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        expect(db.prepare("SELECT body FROM issues WHERE id='is-1'").get()).toEqual({
            body: `Shipped in #524 and #141415, after #3 and #2; see [CB-3 (SRC)](${ORIGIN}/issues/CB-3).`,
        });
    });

    it('never moves an imported image into another Space here', async () => {
        const source = await seedSource(dir);
        source.db.prepare("DELETE FROM space_settings WHERE spaceId='sp-research'").run();
        const db = seedTarget();
        const space = db.prepare("INSERT INTO spaces(id, name, description, createdAt) VALUES (?, ?, '', 1)");
        space.run('sp-a', 'A');
        space.run('sp-b', 'B');
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({
            apply: true,
            spaceMap: { 'sp-research': 'sp-a' },
        });
        const file = source.db.prepare('SELECT fileId, ownerUserId FROM media_embeds WHERE id=?').get(EMBED) as {
            fileId: string;
            ownerUserId: string;
        };
        const fresh = Buffer.concat([PNG.subarray(0, 8), randomBytes(200)]);
        await source.store.put(
            objectKey('local', 'main', file.ownerUserId, file.fileId),
            new SecretBox(SOURCE_KEYS, 'data-files').sealBytes(fresh, `${file.ownerUserId}/${file.fileId}`),
        );
        source.db.prepare('UPDATE data_files SET size=? WHERE id=?').run(fresh.length, file.fileId);
        // A new page there shows the same image; here its Space goes to B.
        source.db
            .prepare(
                "INSERT INTO pages(id, spaceId, parentId, title, content, revision, createdAt, updatedAt) VALUES ('pg-new', 'sp-research', NULL, 'New', ?, 1, 1, 1)",
            )
            .run(`\`\`\`image\n${JSON.stringify({ id: EMBED })}\n\`\`\``);
        const before = db.prepare('SELECT fileId, spaceId FROM media_embeds WHERE id=?').get(EMBED);
        const report = await importer(
            db,
            await BundleReader.open((await makeBundle(dir, source, {}, 'bundle-2')).out),
            dir,
        ).run({
            apply: true,
            spaceMap: { 'sp-research': 'sp-b' },
        });
        expect(report.conflicts).toContainEqual({
            kind: 'image',
            id: EMBED,
            reason: 'it belongs to another Space here',
        });
        expect(db.prepare('SELECT fileId, spaceId FROM media_embeds WHERE id=?').get(EMBED)).toEqual(before);
    });

    it('matches only verified emails: an unverified look-alike gets no membership, vote or authorship', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        // Here someone signed up with Bob's address and never verified it.
        db.prepare(
            "INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES ('bob-claim', 'Not Bob', 'member', 1, 1)",
        ).run();
        db.prepare(
            "INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId) VALUES ('auth-bob-claim', 'Not Bob', 'BOB@example.test', 0, 1, 1, 'bob-claim')",
        ).run();
        const bundle = await BundleReader.open((await makeBundle(dir, source)).out);
        const dry = await importer(db, bundle, dir).run();
        expect(dry.authors.unverified).toEqual([expect.objectContaining({ name: 'Bob Example' })]);
        expect(dry.authors.mapped.map((a) => a.name)).toEqual(['Alice Example']);
        expect(reportLines(dry).join('\n')).toContain('hasn’t verified that email');
        await importer(db, bundle, dir).run({ apply: true });
        const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map((row) => row.id);
        expect(ids("SELECT userId AS id FROM space_members WHERE spaceId='sp-research'")).toEqual(['alice-here']);
        expect(ids('SELECT userId AS id FROM issue_votes')).toEqual(['alice-here']);
        expect(db.prepare("SELECT authorId, body FROM issue_comments WHERE id='c-2'").get()).toEqual({
            authorId: 'import',
            body: '_Originally by Bob Example on SRC, 2026-10-01._\n\nMe too.',
        });
        expect(db.prepare("SELECT reporterId FROM issues WHERE id='is-2'").get()).toEqual({ reporterId: 'import' });
        expect(db.prepare("SELECT count(*) AS n FROM issue_comments WHERE authorId='bob-claim'").get()).toEqual({
            n: 0,
        });
    });

    it('reports people named only by a membership, verified or not', async () => {
        const source = await seedSource(dir);
        person(source.db, 'carol', 'Carol Member', 'carol@example.test');
        person(source.db, 'dave', 'Dave Member', 'dave@example.test');
        const member = source.db.prepare(
            "INSERT INTO space_members(spaceId, userId, role, addedBy, addedAt, updatedAt) VALUES ('sp-research', ?, 'editor', 'alice', 1, 1)",
        );
        member.run('carol');
        member.run('dave');
        const db = seedTarget();
        person(db, 'carol-here', 'Carol', 'carol@example.test');
        db.prepare(
            "INSERT INTO users(id, name, role, createdAt, lastSeenAt) VALUES ('dave-claim', 'Not Dave', 'member', 1, 1)",
        ).run();
        db.prepare(
            "INSERT INTO auth_user(id, name, email, emailVerified, createdAt, updatedAt, appUserId) VALUES ('auth-dave-claim', 'Not Dave', 'dave@example.test', 0, 1, 1, 'dave-claim')",
        ).run();
        const report = await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run();
        expect(report.authors.mapped.map((a) => a.name)).toContain('Carol Member');
        expect(report.authors.unverified.map((a) => a.name)).toEqual(['Dave Member']);
    });

    it('refuses to write a record the importer could not read back', () => {
        const writer = new BundleWriter(join(dir, 'small'), 100);
        expect(() => writer.line('issues.jsonl', { body: 'x'.repeat(200) }, 'CB-9')).toThrow('CB-9 is too large');
        writer.abort();
        expect(existsSync(join(dir, 'small.partial'))).toBe(false);
    });
});

const DELETED_AT = Date.UTC(2026, 10, 10, 12);

/**
 * An issue filed here under number 2, then deleted, with a row in every
 * table that holds rows of an issue; and a live issue (50) it links to,
 * both ways, that a status watch also follows (and a second live one, 51).
 */
function seedDeletedHere(db: DatabaseSync, source = 'web') {
    const issue = db.prepare(
        "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt, deletedAt, deletedBy) VALUES (?, ?, ?, '', 'open', 'low', 'bug', 'op', ?, 1, 1, ?, ?)",
    );
    issue.run('mine', 2, 'Filed here by mistake', source, DELETED_AT, 'op');
    issue.run('other', 50, 'Live here', 'web', null, null);
    issue.run('early', 51, 'Also live here', 'web', null, null);
    const run = (sql: string, ...values: (string | number | null)[]) => db.prepare(sql).run(...values);
    run("INSERT INTO issue_labels(issueId, label) VALUES ('mine', 'oops')");
    run(
        "INSERT INTO issue_comments(id, issueId, authorKind, authorId, body, createdAt) VALUES ('mc-1', 'mine', 'user', 'op', 'Wrong board.', 2)",
    );
    run(
        "INSERT INTO issue_attachments(id, issueId, commentId, name, mediaType, size, sha256, data, uploaderId, createdAt) VALUES ('ma-1', 'mine', 'mc-1', 'a.txt', 'text/plain', 1, 'x', X'61', 'op', 2)",
    );
    run("INSERT INTO issue_votes(id, issueId, userId, dotId, createdAt) VALUES ('mv-1', 'mine', 'op', NULL, 3)");
    run(
        "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt, seq) VALUES ('me-1', 'mine', 'op', 'created', NULL, 'open', 1, 1000)",
    );
    run(
        "INSERT INTO issue_links(id, fromId, toId, kind, createdBy, createdAt) VALUES ('ml-1', 'mine', 'other', 'blocked_by', 'op', 4)",
    );
    run(
        "INSERT INTO issue_links(id, fromId, toId, kind, createdBy, createdAt) VALUES ('ml-2', 'other', 'mine', 'blocked_by', 'op', 4)",
    );
    run(
        "INSERT INTO issue_relations(id, fromId, toId, kind, createdBy, createdAt) VALUES ('mr-1', 'mine', 'other', 'related', 'op', 4)",
    );
    run(
        "INSERT INTO issue_relations(id, fromId, toId, kind, createdBy, createdAt) VALUES ('mr-2', 'early', 'mine', 'related', 'op', 4)",
    );
    run("INSERT INTO issue_triage(issueId, state, createdAt) VALUES ('mine', 'pending', 5)");
    run(
        "INSERT INTO issue_agent_actions(id, issueId, action, targetId, grantId, clientId, clientName, label, userId, createdAt) VALUES ('mx-1', 'mine', 'create', NULL, 'g', 'c', 'Client', 'Client', 'op', 6)",
    );
    run(
        "INSERT INTO issue_dot_actions(id, issueId, action, targetId, dotId, dotOwnerId, userId, trigger, causeId, threadId, createdAt) VALUES ('md-1', 'mine', 'create', NULL, 'scout', NULL, 'op', 'chat', NULL, NULL, 6)",
    );
    run(
        "INSERT INTO issue_runs(issueId, runId, threadId, via, linkedBy, createdAt) VALUES ('mine', 'run-1', 'th-1', 'report', 'op', 7)",
    );
    run("INSERT INTO dot_requests(issueId, key, capability, createdAt) VALUES ('mine', 'k', 'cap', 8)");
    run(
        "INSERT INTO dot_request_requesters(id, issueId, dotId, userId, why, example, createdAt) VALUES ('mq-1', 'mine', 'scout', 'op', 'why', 'ex', 8)",
    );
    run(
        "INSERT INTO dot_request_notices(id, issueId, userId, status, createdAt) VALUES ('mn-1', 'mine', 'op', 'done', 9)",
    );
    run(
        "INSERT INTO dispatch_runs(id, issueId, executor, status, requestedBy, createdAt, budgetUsd, timeLimitMs) VALUES ('dr-1', 'mine', 'x', 'succeeded', 'op', 10, 1, 1000)",
    );
    run("INSERT INTO dispatch_run_events(runId, seq, at, kind, text) VALUES ('dr-1', 1, 10, 'log', 'ran')");
    run(
        'INSERT INTO gateway_dispatch_credentials(hash, runId, issuedAt, expiresAt) VALUES (?, ?, 10, 20)',
        'a'.repeat(64),
        'dr-1',
    );
    const watch = db.prepare(
        "INSERT INTO issue_watches(id, userId, targetStatus, state, fingerprint, cursor, createdAt, sourceKind, sourceId) VALUES (?, 'op', 'done', ?, ?, ?, 1, 'person', 'op')",
    );
    watch.run('w-mine', 'watching', '2|done', 0);
    // Matched, its notice not sent yet.
    watch.run('w-both', 'ready', '2,50|done', 1000);
    // Unrelated, its cursor past the deleted issue's newest event.
    watch.run('w-other', 'watching', '50|done', 1000);
    const member = db.prepare('INSERT INTO issue_watch_members(watchId, issueId, number, status) VALUES (?, ?, ?, ?)');
    member.run('w-mine', 'mine', 2, 'open');
    member.run('w-both', 'mine', 2, 'open');
    member.run('w-both', 'other', 50, 'open');
    member.run('w-other', 'other', 50, 'open');
    run(
        "INSERT INTO issue_watch_outbox(id, watchId, userId, title, message, path, createdAt) VALUES ('wo-1', 'w-mine', 'op', 't', 'm', '/issues/CB-2', 11)",
    );
    run(
        "INSERT INTO issue_watch_outbox(id, watchId, userId, title, message, path, createdAt) VALUES ('wo-2', 'w-both', 'op', 't', 'm', '/issues', 11)",
    );
}

describe('a number held by an issue deleted here', () => {
    it('lists the deleted issue it replaces in the dry run, as a create', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedDeletedHere(db);
        const before = fingerprint(db);
        const report = await importer(db, await BundleReader.open(out), dir).run();
        expect(fingerprint(db)).toEqual(before);
        expect(report.counts.issue).toEqual({ create: 2 });
        expect(report.conflicts).toEqual([]);
        expect(report.numbers).toEqual({ kept: 2, taken: [] });
        expect(report.replaced).toEqual([{ issue: 'CB-2', deletedAt: DELETED_AT }]);
        expect(reportLines(report)).toContain('  replace deleted CB-2 here (deleted 2026-11-10)');
    });

    it('removes it and every row of it as it applies, keeps the number, and changes nothing on a second run', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedDeletedHere(db);
        const bundle = await BundleReader.open(out);
        const { run, snapshot } = importer(db, bundle, dir);
        const report = await run({ apply: true });
        expect(snapshot).toHaveBeenCalledTimes(1);
        expect(report.replaced).toEqual([{ issue: 'CB-2', deletedAt: DELETED_AT }]);
        expect(reportLines(report)).toContain('  replaced deleted CB-2 here (deleted 2026-11-10)');
        expect(db.prepare('SELECT id, source FROM issues WHERE number=2').get()).toEqual({
            id: 'is-2',
            source: 'import',
        });
        expect(db.prepare("SELECT 1 FROM issues WHERE id='mine'").get()).toBeUndefined();
        for (const { table, column } of ISSUE_ROWS) {
            expect(
                db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}='mine'`).get(),
                `${table}.${column}`,
            ).toEqual({
                n: 0,
            });
        }
        expect(db.prepare("SELECT count(*) AS n FROM dispatch_run_events WHERE runId='dr-1'").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM gateway_dispatch_credentials WHERE runId='dr-1'").get()).toEqual({
            n: 0,
        });
        // The watch of it alone goes, with its notice; the one also following CB-50 ends, as the board ends it.
        expect(db.prepare("SELECT 1 FROM issue_watches WHERE id='w-mine'").get()).toBeUndefined();
        expect(db.prepare("SELECT count(*) AS n FROM issue_watch_outbox WHERE watchId='w-mine'").get()).toEqual({
            n: 0,
        });
        expect(db.prepare("SELECT state, cancelReason FROM issue_watches WHERE id='w-both'").get()).toEqual({
            state: 'cancelled',
            cancelReason: 'issue_unavailable',
        });
        expect(db.prepare("SELECT issueId FROM issue_watch_members WHERE watchId='w-both'").all()).toEqual([
            { issueId: 'other' },
        ]);
        // A watch's cursor past the history left moves back to its end (none
        // was left as the import started): the next event is past it, and replayed.
        expect(db.prepare("SELECT cursor, state FROM issue_watches WHERE id='w-other'").get()).toEqual({
            cursor: 0,
            state: 'watching',
        });
        const last = (db.prepare('SELECT MAX(seq) AS seq FROM issue_events').get() as { seq: number }).seq;
        expect(last).toBeLessThan(1000);
        db.prepare(
            "INSERT INTO issue_events(id, issueId, actorId, kind, fromValue, toValue, createdAt) VALUES ('later', 'other', 'op', 'status', 'open', 'done', 99)",
        ).run();
        expect(db.prepare("SELECT seq FROM issue_events WHERE id='later'").get()).toEqual({ seq: last + 1 });
        // The live issue it linked to stays, as do the bundle's own records.
        expect(db.prepare("SELECT deletedAt FROM issues WHERE id='other'").get()).toEqual({ deletedAt: null });
        expect(db.prepare("SELECT count(*) AS n FROM issue_comments WHERE issueId='is-2'").get()).toEqual({ n: 1 });

        const after = fingerprint(db);
        const again = await run({ apply: true });
        expect(changedTables(after, fingerprint(db))).toEqual(['import_runs']);
        expect(again.replaced).toEqual([]);
        expect(again.counts.issue).toEqual({ unchanged: 2 });
    });

    it('still leaves a live issue, or a deleted one an import brought here, holding the number', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        for (const kind of ['live', 'imported', 'mapped'] as const) {
            const db = seedTarget();
            seedDeletedHere(db, kind === 'imported' ? 'import' : 'web');
            if (kind === 'live') {
                db.prepare("UPDATE issues SET deletedAt=NULL, deletedBy=NULL WHERE id='mine'").run();
            }
            if (kind === 'mapped') {
                db.prepare(
                    "INSERT INTO import_map(sourceOrigin, kind, sourceId, targetId, hash, runId, importedAt) VALUES ('https://elsewhere.example.test', 'issue', 'x-9', 'mine', '', 'r', 1)",
                ).run();
            }
            // A live issue filed here is renumbered around unless the numbers are kept strictly.
            const report = await importer(db, await BundleReader.open(out), dir).run({
                apply: true,
                keepNumbersStrict: kind === 'live',
            });
            expect(report.replaced, kind).toEqual([]);
            expect(report.renumbered, kind).toEqual([]);
            expect(report.numbers, kind).toEqual({ kept: 1, taken: [2] });
            expect(report.conflicts, kind).toContainEqual({
                kind: 'issue',
                id: 'CB-2',
                reason: 'its number or id is another issue’s here',
            });
            expect(db.prepare('SELECT id FROM issues WHERE number=2').get(), kind).toEqual({ id: 'mine' });
            expect(db.prepare("SELECT count(*) AS n FROM issue_comments WHERE issueId='mine'").get(), kind).toEqual({
                n: 1,
            });
        }
    });

    it('removes it before writing any record, so no text names a restored issue', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedDeletedHere(db);
        const states: unknown[] = [];
        const report = await importer(db, await BundleReader.open(out), dir).run({
            apply: true,
            chunkSize: 1,
            // Between chunks: the deleted issue is gone from the first one on, so it can't be restored.
            pause: async () => {
                states.push(db.prepare("SELECT 1 AS here FROM issues WHERE id='mine'").get());
            },
        });
        expect(states.length).toBeGreaterThan(1);
        expect(states.every((state) => state === undefined)).toBe(true);
        expect(report.counts.issue).toEqual({ create: 2 });
        // The page naming CB-2 points at the bundle's CB-2, now here.
        expect(
            (db.prepare("SELECT content FROM pages WHERE id='pg-picked'").get() as { content: string }).content,
        ).toContain('/issues/CB-2');
        expect(db.prepare('SELECT id FROM issues WHERE number=2').get()).toEqual({ id: 'is-2' });
    });

    it('refuses to start when the deleted issue was restored while the backup was copied', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedDeletedHere(db);
        const snapshot = vi.fn(async () => {
            db.prepare("UPDATE issues SET deletedAt=NULL, deletedBy=NULL WHERE id='mine'").run();
            return join(dir, 'copy.sqlite');
        });
        await expect(
            importer(db, await BundleReader.open(out), dir).run({
                apply: true,
                safety: { lastBackupAt: () => Date.now(), snapshot },
            }),
        ).rejects.toThrow('CB-2 were filed here while the import prepared');
        expect(db.prepare("SELECT count(*) AS n FROM issue_comments WHERE issueId='mine'").get()).toEqual({ n: 1 });
    });

    it('knows every table that holds rows of an issue', () => {
        const db = testDatabase();
        const tables = (
            db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
        ).map((row) => row.name);
        const listed = new Set(ISSUE_ROWS.map((row) => `${row.table}.${row.column}`));
        const missing = tables.flatMap((table) =>
            (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
                .filter(
                    (column) =>
                        column.name === 'issueId' || (table.startsWith('issue_') && /^(from|to)Id$/.test(column.name)),
                )
                .map((column) => `${table}.${column.name}`)
                .filter((name) => !listed.has(name)),
        );
        expect(missing).toEqual([]);
    });
});

describe('a number a live issue filed here holds (renumbering)', () => {
    /** A live issue filed here under CB-2, the number of the bundle's is-2. */
    const seedTaken = (db: DatabaseSync) =>
        db
            .prepare(
                "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('mine', 2, 'Mine', 'Filed here.', 'open', 'low', 'bug', 'op', 'web', 1, 1)",
            )
            .run();
    const body = (db: DatabaseSync, id: string) =>
        (db.prepare('SELECT body FROM issues WHERE id=?').get(id) as { body: string }).body;

    it('lists it in the dry run as a create under the next free number, and writes nothing', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedTaken(db);
        const before = fingerprint(db);
        const report = await importer(db, await BundleReader.open(out), dir).run();
        expect(fingerprint(db)).toEqual(before);
        expect(report.counts.issue).toEqual({ create: 2 });
        expect(report.conflicts).toEqual([]);
        expect(report.numbers).toEqual({ kept: 1, taken: [] });
        expect(report.renumbered).toEqual([{ issue: 'CB-2', to: 'CB-3' }]);
        expect(reportLines(report)).toContain('  renumber CB-2 → CB-3 (CB-2 here is another issue)');
        // The samples show the mentions it would rewrite.
        expect(report.rewrites.samples).toContainEqual({ where: 'CB-1', before: 'CB-2', after: 'CB-3' });
    });

    it('applies it: the next free number, every reference rewritten, a byline, the map kept', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedTaken(db);
        const { run } = importer(db, await BundleReader.open(out), dir);
        const report = await run({ apply: true });
        expect(reportLines(report)).toContain('  renumbered CB-2 → CB-3 (CB-2 here is another issue)');
        expect(db.prepare('SELECT id, number, source FROM issues ORDER BY number').all()).toEqual([
            { id: 'is-1', number: 1, source: 'import' },
            { id: 'mine', number: 2, source: 'web' },
            { id: 'is-2', number: 3, source: 'import' },
        ]);
        // The issue here keeps its own text; the renumbered one says what it was.
        expect(body(db, 'mine')).toBe('Filed here.');
        expect(body(db, 'is-2')).toBe('_Originally CB-2 on SRC._\n\nDone after CB-1.');
        const note = db
            .prepare("SELECT body FROM issue_comments WHERE issueId='is-2' AND authorKind='system'")
            .get() as { body: string };
        expect(note.body).toContain('CB-2 here is another issue, so it is CB-3 here.');
        // Mentions and links of CB-2 name CB-3 here; the uncopied CB-3 of the source points there.
        expect(body(db, 'is-1')).toMatch(
            /^Needs CB-3 and \[CB-3 \(SRC\)\]\(https:\/\/source\.example\.test\/issues\/CB-3\)\./,
        );
        expect(
            (db.prepare("SELECT content FROM pages WHERE id='pg-picked'").get() as { content: string }).content,
        ).toBe('See /issues/CB-3.');
        // The relation between the two follows the issue, not the number.
        expect(db.prepare("SELECT fromId, toId FROM issue_relations WHERE id='r-1'").get()).toEqual({
            fromId: 'is-1',
            toId: 'is-2',
        });
        expect(db.prepare("SELECT sourceId, targetId, hash FROM import_map WHERE kind='issue_number'").all()).toEqual([
            { sourceId: 'is-2', targetId: '3', hash: '2' },
        ]);
        expect(db.prepare('SELECT last FROM issue_counter').get()).toEqual({ last: 3 });

        // Again, the same bundle: nothing changes.
        const after = fingerprint(db);
        const again = await run({ apply: true });
        expect(changedTables(after, fingerprint(db))).toEqual(['import_runs']);
        expect(again.counts.issue).toEqual({ unchanged: 2 });
        expect(again.renumbered).toEqual([]);
        expect(again.conflicts).toEqual([]);
    });

    it('updates the same issue from a newer bundle, never a second one, and never renumbers it again', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        seedTaken(db);
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        // Meanwhile CB-3 here is filed, and the source edits CB-2 and mentions it again.
        const board = sqliteBoard(db, { userExists: () => true, deactivated: () => false, dot: () => undefined });
        expect((await board.issues.create({ title: 'Filed here later' }, 'op')).number).toBe(4);
        source.db
            .prepare("UPDATE issues SET title='Export v2', body='Done after CB-1, see CB-2.' WHERE id='is-2'")
            .run();
        const newer = await makeBundle(dir, source, {}, 'newer');
        const report = await importer(db, await BundleReader.open(newer.out), dir).run({ apply: true });
        expect(report.renumbered).toEqual([]);
        expect(report.counts.issue).toEqual({ unchanged: 1, update: 1 });
        expect(db.prepare("SELECT count(*) AS n FROM issues WHERE title LIKE 'Export%'").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT number, title FROM issues WHERE id='is-2'").get()).toEqual({
            number: 3,
            title: 'Export v2',
        });
        expect(body(db, 'is-2')).toBe('_Originally CB-2 on SRC._\n\nDone after CB-1, see CB-3.');
    });

    it('allocates as the import starts: an issue filed while it prepares keeps its number, the renumbered one moves on', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        const db = seedTarget();
        seedTaken(db);
        const board = sqliteBoard(db, { userExists: () => true, deactivated: () => false, dot: () => undefined });
        const filed: number[] = [];
        const report = await importer(db, await BundleReader.open(out), dir).run({
            apply: true,
            chunkSize: 1,
            safety: {
                lastBackupAt: () => Date.now(),
                // Filed after the plan (which saw CB-3 free), before the import starts.
                snapshot: async () => {
                    filed.push((await board.issues.create({ title: 'During the backup' }, 'op')).number);
                    return join(dir, 'copy.sqlite');
                },
            },
            // Filed between chunks: after every number the import holds.
            pause: async () => {
                if (filed.length < 3) {
                    filed.push((await board.issues.create({ title: 'Between chunks' }, 'op')).number);
                }
            },
        });
        expect(filed).toEqual([3, 5, 6]);
        expect(report.renumbered).toEqual([{ issue: 'CB-2', to: 'CB-4' }]);
        expect(report.conflicts).toEqual([]);
        expect(db.prepare("SELECT number FROM issues WHERE id='is-2'").get()).toEqual({ number: 4 });
        expect(body(db, 'is-1')).toMatch(/^Needs CB-4 and /);
        const numbers = (db.prepare('SELECT number FROM issues').all() as { number: number }[]).map((r) => r.number);
        expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('takes precedence after a deleted issue’s replacement, and keeps conflicts with imported copies', async () => {
        const source = await seedSource(dir);
        const { out } = await makeBundle(dir, source);
        // A deleted issue filed here at CB-2: replaced, not renumbered around.
        const replaced = seedTarget();
        seedDeletedHere(replaced);
        const first = await importer(replaced, await BundleReader.open(out), dir).run({ apply: true });
        expect(first.replaced).toHaveLength(1);
        expect(first.renumbered).toEqual([]);
        expect(replaced.prepare("SELECT number FROM issues WHERE id='is-2'").get()).toEqual({ number: 2 });
        // A live copy another import brought here at CB-2: it may be the same issue, so a conflict.
        const copied = seedTarget();
        copied
            .prepare(
                "INSERT INTO issues(id, number, title, body, status, priority, kind, reporterId, source, createdAt, updatedAt) VALUES ('theirs', 2, 'Theirs', '', 'open', 'low', 'bug', 'import', 'import', 1, 1)",
            )
            .run();
        const second = await importer(copied, await BundleReader.open(out), dir).run({ apply: true });
        expect(second.renumbered).toEqual([]);
        expect(second.conflicts).toContainEqual({
            kind: 'issue',
            id: 'CB-2',
            reason: 'its number or id is another issue’s here',
        });
        expect(copied.prepare("SELECT 1 FROM issues WHERE id='is-2'").get()).toBeUndefined();
    });

    it('renumbers around this source’s own renumbered issue when the source reaches its number', async () => {
        const source = await seedSource(dir);
        const db = seedTarget();
        seedTaken(db);
        await importer(db, await BundleReader.open((await makeBundle(dir, source)).out), dir).run({ apply: true });
        // CB-2 of the source is CB-3 here; the source now files its own CB-5,
        // and CB-3 (copied this time) lands on the renumbered copy's number.
        expect(db.prepare("SELECT number FROM issues WHERE id='is-2'").get()).toEqual({ number: 3 });
        const newer = await makeBundle(
            dir,
            source,
            { selection: { issues: [1, 2, 3], spaces: ['sp-research'], pages: ['pg-picked'] } },
            'newer',
        );
        const report = await importer(db, await BundleReader.open(newer.out), dir).run({ apply: true });
        expect(report.renumbered).toEqual([{ issue: 'CB-3', to: 'CB-4' }]);
        expect(report.conflicts).toEqual([]);
        expect(db.prepare("SELECT number FROM issues WHERE id='is-3'").get()).toEqual({ number: 4 });
        // CB-1 now names the two by their numbers here: CB-2 is CB-3, CB-3 is CB-4. Edited bodies stay.
        expect(body(db, 'is-1')).toMatch(/^Needs CB-3 and CB-4\./);
        expect(body(db, 'is-3')).toBe('_Originally CB-3 on SRC._\n\nNot copied.');
    });
});

describe('memory', () => {
    it('holds one file’s bytes at a time, in export and import', async () => {
        const source = await seedSource(dir);
        // Twenty attachments of 512 kB: 10 MB in all, under a 2 MB budget.
        const blob = (db: DatabaseSync) =>
            db.prepare(
                'INSERT INTO issue_attachments(id, issueId, commentId, name, mediaType, size, sha256, data, uploaderId, createdAt) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
            );
        const insert = blob(source.db);
        for (let i = 0; i < 20; i++) {
            const data = randomBytes(512 * 1024);
            insert.run(
                `big-${i}`,
                'is-2',
                `big-${i}.bin`,
                'application/octet-stream',
                data.length,
                createHash('sha256').update(data).digest('hex'),
                data,
                'alice',
                T0 + i,
            );
        }
        const exportBudget = new ByteBudget(2 * 1024 * 1024);
        const { out } = await makeBundle(dir, source, { budget: exportBudget });
        expect(exportBudget.peak).toBeGreaterThan(512 * 1024);
        expect(exportBudget.peak).toBeLessThanOrEqual(512 * 1024 + 64);
        const db = seedTarget();
        const importBudget = new ByteBudget(2 * 1024 * 1024);
        await importer(db, await BundleReader.open(out), dir).run({
            apply: true,
            budget: importBudget,
            chunkBytes: 1024 * 1024,
        });
        expect(importBudget.peak).toBeLessThanOrEqual(512 * 1024 + 64);
        expect(db.prepare("SELECT count(*) AS n FROM issue_attachments WHERE issueId='is-2'").get()).toEqual({ n: 20 });
        expect(importBudget.held).toBe(0);
    });

    it('refuses rather than hold more than its budget', async () => {
        const source = await seedSource(dir);
        await expect(makeBundle(dir, source, { budget: new ByteBudget(1024) })).rejects.toThrow('memory budget');
        expect(existsSync(join(dir, 'bundle.partial'))).toBe(false);
    });
});

describe('folders (CB-426)', () => {
    it('carries a folder through export and import, its body kept', async () => {
        const source = await seedSource(dir);
        source.db.prepare("UPDATE pages SET folder=1 WHERE id='pg-root'").run();
        const { out } = await makeBundle(dir, source);
        const pages = readFileSync(join(out, 'pages.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));
        expect(Object.fromEntries(pages.map((p) => [p.id, p.folder]))).toEqual({
            'pg-root': true,
            'pg-picked': false,
            'pg-child': false,
        });
        const db = seedTarget();
        await importer(db, await BundleReader.open(out), dir).run({ apply: true });
        const rows = db.prepare('SELECT id, folder, content FROM pages ORDER BY id').all();
        expect(rows.map((row) => [row.id, row.folder])).toEqual([
            ['pg-child', 0],
            ['pg-picked', 0],
            ['pg-root', 1],
        ]);
        expect(String(rows.find((row) => row.id === 'pg-root')!.content)).toContain('Tracks CB-1');
        // Its search row holds no body: a folder matches by its title only.
        const searchBody = () => db.prepare("SELECT body FROM page_search WHERE pageId='pg-root'").get()!.body;
        expect(searchBody()).toBe('');

        // Turned back into a page at the source, the next import follows; an
        // unchanged page is not seen as changed.
        source.db.prepare("UPDATE pages SET folder=0, updatedAt=updatedAt+1 WHERE id='pg-root'").run();
        const again = await makeBundle(dir, source, {}, 'bundle-2');
        const report = await importer(db, await BundleReader.open(again.out), dir).run({ apply: true });
        expect(report.counts.page).toMatchObject({ update: 1 });
        expect(db.prepare("SELECT folder FROM pages WHERE id='pg-root'").get()).toEqual({ folder: 0 });
        expect(String(searchBody())).toContain('Tracks CB-1');
    });

    it('reads a page record without the field, from before folders, as a page', async () => {
        const source = await seedSource(dir);
        source.db.prepare("UPDATE pages SET folder=1 WHERE id='pg-root'").run();
        const { out } = await makeBundle(dir, source);
        const path = join(out, 'pages.jsonl');
        const lines = readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((l) => {
                const { folder: _folder, ...record } = JSON.parse(l);
                return JSON.stringify(record);
            });
        writeFileSync(path, `${lines.join('\n')}\n`);
        expect(readFileSync(path, 'utf8')).not.toContain('"folder"');
        const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
        manifest.files['pages.jsonl'] = await hashFile(path);
        writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
        const db = seedTarget();
        await importer(db, await BundleReader.open(out), dir).run({ apply: true });
        expect(db.prepare('SELECT DISTINCT folder FROM pages').all()).toEqual([{ folder: 0 }]);
    });
});
