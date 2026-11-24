import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ATTACHMENT_EXTENSIONS } from '@socio/shared/issues/issue-attachment-files';
import type { IssueAttachment, IssueComment, IssueDetail } from '@socio/shared/issues/issue-types';
import { cleanName } from '@socio/shared/media/file-types';

import { openUserDb, wipe, workspaceKeyName, workspaceLayout, type WorkspaceLayout } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { AbortedError, NetworkError } from '../../src/net/errors';
import { editIssueFields, FILE_ISSUE_LEAD, FILE_ISSUE_RUN_GONE, fileIssueView } from '../../src/shell/file-issue';
import { unsentListRows } from '../../src/shell/unsent';
import { type AttachmentFiles, type Attachments, openAttachments, type PickedFile } from '../../src/sync/attachments';
import { type Drafts, openDrafts } from '../../src/sync/chat-drafts';
import { createImageProcessor, ISSUE_IMAGE_PROFILE } from '../../src/sync/image-processing';
import {
    attachmentBody,
    attachToIssue,
    commentWithFiles,
    fileIssueWithFiles,
    heldIssueFiles,
    ISSUE_ATTACHMENT_IDS,
    ISSUE_ATTACHMENT_KIND,
    ISSUE_ATTACHMENT_REFUSALS,
    ISSUE_ATTACHMENT_VIEWS,
    ISSUE_ATTACHMENTS,
    issueAttachmentKind,
    issueEditTray,
    removeHeldFile,
    resendIssueWithFiles,
} from '../../src/sync/issue-attachments';
import { COMMENT_IDS, issueCommentKinds } from '../../src/sync/issue-comments';
import {
    ISSUE_DRAFT,
    ISSUE_REFUSALS,
    issueCommentsDraft,
    issueCreateKind,
    issueDraftText,
    resendIssue,
} from '../../src/sync/issue-create';
import { ISSUE_IDS } from '../../src/sync/local-ids';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { createNodeFileSystem } from '../helpers/node-fs';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';
import { addWorkspace, launch, phone as testPhone } from '../helpers/store';

import { turns, USER_KEY } from './outbox-fakes';

// Issue attachments on a real user.db, outbox, drafts and attachments
// directory, against a fake server whose issue routes answer as
// src/server/issues's do: the body's base64 decoded, the name `cleanName`'d,
// the SHA-256 recorded, 413 past 5 MiB or 10 files. Nothing may reach /api/media.

const ME = 'user-me';
const MiB = 1024 * 1024;

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Script = 'ok' | 'drop' | 'hold' | { readonly status: number };

function server() {
    const details = new Map<number, IssueDetail>();
    const log: string[] = [];
    /** What each attachment POST does, in order: stored and answered by default. */
    const scripts: Script[] = [];
    /** Each create's body, as sent. */
    const creates: Record<string, unknown>[] = [];
    /** Runs that are gone: a create linked to one is refused with a 404, as src/server's is. */
    const goneRuns = new Set<string>();
    let clock = 10_000_000;
    let ids = 0;
    let last = 40;

    const issue = (number = ++last): IssueDetail => {
        const at = (clock += 1_000);
        const detail = {
            issue: {
                id: `issue-${number}`,
                number,
                title: 'Export fails',
                body: 'Steps',
                status: 'triage',
                priority: 'medium',
                kind: 'bug',
                area: null,
                labels: [],
                reporterId: ME,
                assigneeId: null,
                resolution: null,
                source: 'web',
                createdAt: at,
                updatedAt: at,
                closedAt: null,
            },
            comments: [],
            attachments: [],
            events: [],
            users: {},
        } as unknown as IssueDetail;
        details.set(number, detail);
        return detail;
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        if (input.startsWith('/api/media')) {
            return json(500, { error: 'Issue files never go here.' });
        }
        if (input === '/api/issues' && method === 'POST') {
            const body = (init.json ?? {}) as Record<string, unknown>;
            creates.push(body);
            if (typeof body.runId === 'string' && goneRuns.has(body.runId)) {
                return json(404, { error: 'Run not found.' });
            }
            return json(201, issue());
        }
        if (input === '/api/issues') {
            return json(200, {
                issues: [...details.values()].map(({ issue: i }) => ({
                    number: i.number,
                    title: i.title,
                    updatedAt: i.updatedAt,
                })),
                users: {},
            });
        }
        const match = /^\/api\/issues\/(\d+)(\/comments|\/attachments)?$/.exec(input);
        const number = match ? Number(match[1]) : NaN;
        const detail = details.get(number);
        if (!match || detail === undefined) {
            return json(404, { error: 'Issue not found.' });
        }
        if (match[2] === '/comments' && method === 'POST') {
            const body = (init.json ?? {}) as { body?: string };
            const comment: IssueComment = {
                id: `comment-${++ids}`,
                issueId: detail.issue.id,
                authorKind: 'user',
                authorId: ME,
                body: String(body.body).trim(),
                createdAt: (clock += 1_000),
                editedAt: null,
            };
            details.set(number, { ...detail, comments: [...detail.comments, comment] });
            return json(201, comment);
        }
        if (match[2] === '/attachments' && method === 'POST') {
            const script = scripts.shift() ?? 'ok';
            if (typeof script === 'object') {
                return json(script.status, { error: 'Refused.' });
            }
            if (script === 'hold') {
                // Never answers: the request is stopped by its signal (a kill).
                return new Promise<Response>((_, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new AbortedError(input)));
                });
            }
            expect(init.json).toBeUndefined();
            const body = JSON.parse(init.jsonText ?? 'null') as {
                name: string;
                mediaType?: string;
                data: string;
                commentId?: string;
            };
            expect(Object.keys(body).sort()).toEqual(
                ['data', 'mediaType', 'name', ...(body.commentId ? ['commentId'] : [])].sort(),
            );
            expect(body.data).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
            const data = Buffer.from(body.data, 'base64');
            // The server detects the type and refuses a declared one that disagrees
            // (only text/markdown passes for plain text); here, by extension.
            const detected = ATTACHMENT_EXTENSIONS[body.name.split('.').pop()?.toLowerCase() ?? ''];
            if (
                body.mediaType !== undefined &&
                body.mediaType !== detected &&
                !(detected === 'text/plain' && body.mediaType === 'text/markdown')
            ) {
                return json(415, { error: 'Only images, PDFs and plain text can be attached.' });
            }
            if (data.byteLength > 5 * MiB || detail.attachments.length >= 10) {
                return json(413, { error: 'Attachments can be at most 5 MB.' });
            }
            const attachment: IssueAttachment = {
                id: `att-${++ids}`,
                issueId: detail.issue.id,
                commentId: body.commentId ?? null,
                name: cleanName(body.name),
                mediaType: (body.mediaType ?? 'image/png') as IssueAttachment['mediaType'],
                size: data.byteLength,
                sha256: sha(data),
                uploaderId: ME,
                createdAt: (clock += 1_000),
            };
            details.set(number, { ...detail, attachments: [...detail.attachments, attachment] });
            if (script === 'drop') {
                throw new NetworkError(input);
            }
            return json(201, attachment);
        }
        return method === 'GET' ? json(200, detail) : json(404, {});
    };

    return {
        fetch,
        details,
        log,
        scripts,
        creates,
        goneRuns,
        issue,
        get clock() {
            return clock;
        },
        writes: () => log.filter((line) => !line.startsWith('GET')),
        media: () => log.filter((line) => line.includes('/api/media')),
        attachments: (number: number) => details.get(number)?.attachments ?? [],
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

const temp = (prefix: string) => {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
};

let ids = 0;
const newId = () => `id-${++ids}`;

/** node:fs, with base64 and SHA-256 as the platform binds them. */
function nodeFiles(): AttachmentFiles {
    const fs = createNodeFileSystem();
    return {
        list: fs.list,
        remove: fs.remove,
        mkdir: fs.mkdir,
        copy: (from, to) => copyFile(from, to),
        body: async (path) => new Uint8Array(await readFile(path)),
        base64: async (path) => (await readFile(path)).toString('base64'),
        sha256: async (path) => sha(await readFile(path)),
    };
}

interface Phone {
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly attachments: Attachments;
    readonly layout: WorkspaceLayout;
    readonly held: Map<string, IssueDetail>;
    /** A picked file in the picker's folder, its bytes `fill` repeated. */
    pick(name: string, bytes?: number, mime?: string, fill?: string): PickedFile;
    copies(): string[];
    relaunch(): Promise<Phone>;
    until(done: () => boolean): Promise<void>;
}

async function open(
    srv: Server,
    kept?: { directory: string; picker: string },
    options: { processIssueImage?: (file: PickedFile) => Promise<PickedFile> } = {},
): Promise<Phone> {
    const directory = kept?.directory ?? temp('socio-issue-files-');
    const picker = kept?.picker ?? temp('socio-picker-');
    mkdirSync(picker, { recursive: true });
    const layout: WorkspaceLayout = {
        ...workspaceLayout('/unused', 'cd'.repeat(32)),
        directory,
        attachments: join(directory, 'attachments'),
    };
    const file = await openUserDb(createNodeSqliteDriver({ keys: new Map() }), directory, USER_KEY);
    const held = new Map<string, IssueDetail>();
    const issueDetails = {
        peek: (key: string) => (held.has(key) ? ({ state: { value: held.get(key)! } } as never) : undefined),
        put: async (key: string, detail: IssueDetail) => void held.set(key, detail),
    };
    const attachments = await openAttachments({
        db: file.db,
        state: file.state,
        layout,
        files: nodeFiles(),
        setFileProtection: async () => {},
        fetch: srv.fetch,
        newId,
        processIssueImage: options.processIssueImage,
    });
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            issueCreateKind({ issueDetails }) as OutboxKind<unknown>,
            ...issueCommentKinds({ issueDetails }),
            issueAttachmentKind({ attachments, issueDetails }) as OutboxKind<unknown>,
        ],
        fetch: srv.fetch,
        random: () => 0,
    });
    // As the scope does: a file goes once its row has settled or been discarded.
    const unsubscribes = [
        outbox.onUnsent(() => void attachments.sweep()),
        outbox.subscribe((change) => {
            if (change.type === 'remove') {
                void attachments.sweep();
            }
        }),
    ];
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
        await drafts.close();
        await outbox.dispose();
        await attachments.close();
        await file.db.close().catch(() => {});
    };
    cleanups.push(close);
    outbox.start();
    let picks = 0;
    const self: Phone = {
        outbox,
        drafts,
        attachments,
        layout,
        held,
        pick(name, bytes = 64, mime = 'image/png', fill = 'x') {
            const uri = join(picker, `${(picks += 1)}-${name}`);
            writeFileSync(uri, fill.repeat(Math.ceil(bytes / fill.length)).slice(0, bytes));
            return { uri, name, mime, bytes, temporary: true };
        },
        copies: () => (existsSync(layout.attachments) ? readdirSync(layout.attachments).sort() : []),
        async relaunch() {
            await close();
            return open(srv, { directory, picker }, options);
        },
        async until(done) {
            const end = Date.now() + 15_000;
            for (;;) {
                await turns(10);
                // A held request never idles: look again soon.
                await Promise.race([outbox.idle(), new Promise((resolve) => setTimeout(resolve, 100))]);
                await turns(10);
                if (done()) {
                    return;
                }
                if (Date.now() > end) {
                    throw new Error(
                        `Timed out waiting for the outbox: ${JSON.stringify(outbox.rows().map((r) => [r.kind, r.state, r.lastError, r.attempts]))} unsent ${JSON.stringify(outbox.unsent().map((w) => w.reason))} log ${JSON.stringify(srv.log)}`,
                    );
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                outbox.poke();
            }
        },
    };
    return self;
}

/** FileIssue with its tray: the box's fields, then Send. */
async function fileWithTray(phone: Phone, srv: Server, title = 'Export fails', runId?: string) {
    phone.drafts.write(ISSUE_DRAFT, issueDraftText({ title, body: 'Steps', ...(runId ? { runId } : {}) }));
    const filed = await fileIssueWithFiles({
        drafts: phone.drafts,
        attachments: phone.attachments,
        newId,
        reporterId: ME,
        after: null,
        serverAt: srv.clock,
    });
    expect(filed).not.toBeNull();
    return filed!;
}

const fileRows = (outbox: Outbox) => outbox.rows().filter((row) => row.kind === ISSUE_ATTACHMENT_KIND);

describe('picking into an issue box', () => {
    it('copies the file and asks nothing of /api/media, online', async () => {
        const srv = server();
        const phone = await open(srv);
        const { added, problems } = await phone.attachments.add(ISSUE_DRAFT, [phone.pick('screen.png')]);
        expect(problems).toEqual([]);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({ state: 'ready', serverId: null, draftScope: ISSUE_DRAFT });
        phone.attachments.pump();
        await turns(20);
        expect(srv.log).toEqual([]);
        expect(phone.copies()).toEqual([`${added[0]!.id}.png`]);
    });

    it('refuses at pick, in shared’s words, a GIF over 5 MiB, an unconverted HEIC and an eleventh file', async () => {
        const srv = server();
        const failing = createImageProcessor({
            profile: ISSUE_IMAGE_PROFILE,
            render: () => Promise.reject(new Error('cannot decode')),
            remove: async () => {},
        });
        const phone = await open(srv, undefined, { processIssueImage: failing });
        const gif = await phone.attachments.add(ISSUE_DRAFT, [phone.pick('dance.gif', 6_000_000, 'image/gif')]);
        expect(gif.added).toEqual([]);
        expect(gif.problems).toEqual([
            { name: 'dance.gif', reason: 'too-large', message: 'dance.gif is larger than 5 MB.' },
        ]);
        const heic = await phone.attachments.add(ISSUE_DRAFT, [phone.pick('IMG_1.HEIC', 1000, 'image/heic')]);
        expect(heic.problems[0]).toMatchObject({ name: 'IMG_1.HEIC', reason: 'type' });
        expect(heic.problems[0]!.message).toContain('only images, PDFs and plain text');

        const comments = issueCommentsDraft('41');
        const many = await phone.attachments.add(comments, [phone.pick('a.png'), phone.pick('b.png')], {
            existing: 9,
        });
        expect(many.added.map((file) => file.name)).toEqual(['a.png']);
        expect(many.problems).toEqual([
            { name: 'b.png', reason: 'too-many', message: 'b.png: an issue can have at most 10 attachments.' },
        ]);
        expect(srv.log).toEqual([]);
    });

    it('scales a 4.9 MB HEIC into a JPEG under 5 MiB', async () => {
        const srv = server();
        const out = temp('socio-rendered-');
        const sizes: number[] = [];
        let renders = 0;
        const processIssueImage = createImageProcessor({
            profile: ISSUE_IMAGE_PROFILE,
            // The first JPEG is still too large; the second, smaller side fits.
            render: async (_uri, { maxSide }) => {
                const bytes = (renders += 1) === 1 ? 5_600_000 : 3_100_000;
                sizes.push(maxSide);
                const uri = join(out, `r${renders}.jpg`);
                writeFileSync(uri, Buffer.alloc(bytes, 1));
                return { uri, width: maxSide, height: maxSide, bytes };
            },
            remove: async (uri) => rmSync(uri, { force: true }),
        });
        const phone = await open(srv, undefined, { processIssueImage });
        const { added, problems } = await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('IMG_2.HEIC', 4_900_000, 'image/heic'),
        ]);
        expect(problems).toEqual([]);
        expect(added[0]).toMatchObject({ name: 'IMG_2.jpg', mime: 'image/jpeg', bytes: 3_100_000 });
        expect(added[0]!.bytes).toBeLessThanOrEqual(5 * MiB);
        expect(sizes).toHaveLength(2);
        expect(sizes[1]).toBeLessThan(sizes[0]!);
        expect(readdirSync(out)).toEqual([]);
    });
});

describe('filing with files', () => {
    it('queues one row per file with the create, each file on its row, and sends each once', async () => {
        const srv = server();
        const phone = await open(srv);
        const { added } = await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('one.png', 100, 'image/png', 'a'),
            phone.pick('two.txt', 200, 'text/plain', 'b'),
        ]);
        const filed = await fileWithTray(phone, srv);
        const rows = fileRows(phone.outbox);
        expect(rows).toHaveLength(2);
        for (const [i, row] of rows.entries()) {
            expect(row.lane).toBe(`issue-comments:${filed.localKey}`);
            expect(row.dependsOn).toBe(filed.localKey);
            expect(phone.attachments.carried(row.id).map((file) => file.id)).toEqual([added[i]!.id]);
            expect(JSON.parse(row.payload)).toMatchObject({
                issue: filed.localKey,
                fileId: added[i]!.id,
                commentId: null,
                uploaderId: ME,
                seen: [],
            });
        }
        expect(phone.attachments.list(ISSUE_DRAFT)).toEqual([]);

        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.writes()).toEqual([
            'POST /api/issues',
            'POST /api/issues/41/attachments',
            'POST /api/issues/41/attachments',
        ]);
        expect(srv.media()).toEqual([]);
        const stored = srv.attachments(41);
        expect(stored.map((a) => [a.name, a.sha256])).toEqual([
            ['one.png', sha(Buffer.from('a'.repeat(100)))],
            ['two.txt', sha(Buffer.from('b'.repeat(200)))],
        ]);
        expect(phone.outbox.resolve(ISSUE_ATTACHMENT_IDS, rows[0]!.id)).toBe(stored[0]!.id);
        // Sent: the copies go (the attachments' sweep).
        await phone.until(() => phone.copies().length === 0);
    });

    it('sends a picked .json or .csv as plain text, whatever type the picker reported', async () => {
        const srv = server();
        const phone = await open(srv);
        const { added, problems } = await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('state.json', 40, 'application/json', '{}'),
            phone.pick('rows.csv', 40, 'text/comma-separated-values', 'a,'),
            phone.pick('run.log', 40, 'application/octet-stream', 'l'),
        ]);
        expect(problems).toEqual([]);
        expect(added).toHaveLength(3);
        await fileWithTray(phone, srv);
        expect(fileRows(phone.outbox).map((row) => JSON.parse(row.payload).mediaType)).toEqual([
            'text/plain',
            'text/plain',
            'text/plain',
        ]);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.attachments(41).map((a) => [a.name, a.mediaType])).toEqual([
            ['state.json', 'text/plain'],
            ['rows.csv', 'text/plain'],
            ['run.log', 'text/plain'],
        ]);
    });

    it('keeps every copy through a kill after the create settles, then sends them', async () => {
        const srv = server();
        let phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('one.png', 100, 'image/png', 'a'),
            phone.pick('two.png', 100, 'image/png', 'b'),
        ]);
        srv.scripts.push('hold');
        const filed = await fileWithTray(phone, srv);
        await phone.until(() => phone.outbox.resolve(ISSUE_IDS, filed.localKey) === '41');
        await phone.until(() => srv.writes().length === 2);
        expect(phone.copies()).toHaveLength(2);

        phone = await phone.relaunch();
        await phone.attachments.sweep();
        expect(phone.copies()).toHaveLength(2);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.attachments(41)).toHaveLength(2);
        expect(phone.outbox.unsent()).toEqual([]);
        await phone.until(() => phone.copies().length === 0);
    });

    it('finds a file the server stored before its answer was lost by its hash, whatever the name became', async () => {
        const srv = server();
        let phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [phone.pick('Ünï "côdé"\u0007 shot.png', 80, 'image/png', 'u')]);
        srv.scripts.push('hold');
        const filed = await fileWithTray(phone, srv);
        await phone.until(() => srv.writes().length === 2);
        // Killed with the request in flight; the next attempt reaches the server and its answer is lost.
        phone = await phone.relaunch();
        expect(fileRows(phone.outbox)[0]?.state).toBe('unknown');
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.attachments(41)).toHaveLength(1);
        expect(phone.outbox.resolve(ISSUE_IDS, filed.localKey)).toBe('41');

        srv.scripts.push('drop');
        await phone.attachments.add(issueCommentsDraft('41'), [phone.pick('Ünï "côdé"\u0007 again.png', 90)]);
        await attachToIssue({
            outbox: phone.outbox,
            attachments: phone.attachments,
            newId,
            issue: '41',
            uploaderId: ME,
            serverAt: srv.clock,
            seen: srv.attachments(41).map((a) => a.id),
        });
        await phone.until(() => phone.outbox.rows().length === 0);
        const stored = srv.attachments(41);
        expect(stored).toHaveLength(2);
        expect(stored[1]!.name).toBe('Ünï côdé again.png');
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.writes().filter((line) => line.endsWith('/attachments'))).toHaveLength(3);
    });

    it('settles two identical files on two attachments when one answer is lost', async () => {
        const srv = server();
        const phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('same.png', 50, 'image/png', 's'),
            phone.pick('same.png', 50, 'image/png', 's'),
        ]);
        srv.scripts.push('ok', 'drop');
        await fileWithTray(phone, srv);
        await phone.until(() => phone.outbox.rows().length === 0);
        const stored = srv.attachments(41);
        expect(stored).toHaveLength(2);
        expect(stored[0]!.sha256).toBe(stored[1]!.sha256);
        const rows = srv.writes().filter((line) => line.endsWith('/attachments'));
        expect(rows).toHaveLength(2);
        expect(phone.outbox.unsent()).toEqual([]);
    });

    it('sends a comment’s files after it, under the comment’s server id', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        const box = issueCommentsDraft('41');
        await phone.attachments.add(box, [phone.pick('log.txt', 30, 'text/plain')]);
        phone.drafts.write(box, 'Here is the log.');
        const sent = await commentWithFiles({
            outbox: phone.outbox,
            drafts: phone.drafts,
            attachments: phone.attachments,
            newId,
            issue: '41',
            authorId: ME,
            serverAt: srv.clock,
            seen: [],
            seenFiles: [],
        });
        const [row] = fileRows(phone.outbox);
        expect(row!.dependsOn).toBe(sent!.commentId);
        expect(row!.lane).toBe(sent!.row.lane);
        await phone.until(() => phone.outbox.rows().length === 0);
        const comment = phone.outbox.resolve(COMMENT_IDS, sent!.commentId);
        expect(srv.attachments(41)[0]).toMatchObject({ commentId: comment, name: 'log.txt' });
    });

    it('sends a 413 to Unsent in words covering both causes, the file kept until discarded', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        await phone.attachments.add(issueCommentsDraft('41'), [phone.pick('big.png')]);
        srv.scripts.push({ status: 413 });
        await attachToIssue({
            outbox: phone.outbox,
            attachments: phone.attachments,
            newId,
            issue: '41',
            uploaderId: ME,
            serverAt: srv.clock,
            seen: [],
        });
        await phone.until(() => phone.outbox.unsent().length === 1);
        const [write] = phone.outbox.unsent();
        expect(write!.reason).toBe(ISSUE_ATTACHMENT_REFUSALS.tooLarge);
        const [listed] = unsentListRows(phone.outbox.unsent(), [], {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(listed).toMatchObject({
            what: 'File “big.png”',
            where: 'CB-41',
            why: 'Too large, or the issue already has 10 files',
            text: null,
        });
        await phone.attachments.sweep();
        expect(phone.copies()).toHaveLength(1);
        await phone.outbox.discardUnsent(write!.id);
        await phone.until(() => phone.copies().length === 0);
    });

    it('Edit of a filing refused because its run is gone sends it again without the run, its files after it', async () => {
        const srv = server();
        srv.goneRuns.add('run-gone');
        const phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [phone.pick('screen.png', 100, 'image/png', 'a')]);
        const filed = await fileWithTray(phone, srv, 'Export fails', 'run-gone');
        await phone.until(() => phone.outbox.unsent().length === 1);
        const [write] = phone.outbox.unsent();
        expect(write!.reason).toBe(ISSUE_REFUSALS.runGone);
        expect(srv.creates.map((body) => body.runId)).toEqual(['run-gone']);
        expect(fileRows(phone.outbox)).toHaveLength(1);

        // FileIssue's Edit opens without the link, and says so.
        const opened = editIssueFields(write!)!;
        expect(opened.runUnlinked).toBe(true);
        expect(opened.fields.runId ?? null).toBeNull();
        expect(
            fileIssueView({
                fields: opened.fields,
                editing: true,
                busy: false,
                picking: false,
                editable: true,
                runUnlinked: opened.runUnlinked,
            }).lead,
        ).toBe(`${FILE_ISSUE_LEAD} ${FILE_ISSUE_RUN_GONE}`);
        expect(
            await resendIssue({
                outbox: phone.outbox,
                id: filed.localKey,
                fields: opened.fields,
                idempotencyKey: 'k-again',
            }),
        ).toBe(true);

        await phone.until(() => phone.outbox.rows().length === 0);
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.creates).toHaveLength(2);
        expect(srv.creates[1]).not.toHaveProperty('runId');
        expect(srv.writes()).toEqual(['POST /api/issues', 'POST /api/issues', 'POST /api/issues/41/attachments']);
        expect(srv.attachments(41).map((a) => [a.name, a.sha256])).toEqual([
            ['screen.png', sha(Buffer.from('a'.repeat(100)))],
        ]);
        await phone.until(() => phone.copies().length === 0);
    });

    it('Edit restores a refused filing’s tray: Remove discards that file’s row, Add queues one behind the filing', async () => {
        const srv = server();
        srv.goneRuns.add('run-gone');
        const phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [
            phone.pick('keep.png', 100, 'image/png', 'k'),
            phone.pick('drop.png', 100, 'image/png', 'd'),
        ]);
        const filed = await fileWithTray(phone, srv, 'Export fails', 'run-gone');
        await phone.until(() => phone.outbox.unsent().length === 1);
        const held = heldIssueFiles(phone.outbox.holds(), filed.localKey);
        expect(held.map((file) => file.name)).toEqual(['keep.png', 'drop.png']);
        expect(phone.attachments.carried(held[0]!.rowId).map((file) => file.name)).toEqual(['keep.png']);

        // Remove: that row goes, and its copy with it.
        expect(await removeHeldFile(phone.outbox, held[1]!.rowId)).toBe(true);
        expect(heldIssueFiles(phone.outbox.holds(), filed.localKey).map((file) => file.name)).toEqual(['keep.png']);
        await phone.until(() => phone.copies().length === 1);

        // Add: picked into the Edit's tray, then a row of its own waiting on the filing's local key.
        const tray = issueEditTray(filed.localKey);
        await phone.attachments.add(tray, [phone.pick('added.png', 100, 'image/png', 'n')], { existing: 1 });
        const [added] = await attachToIssue({
            outbox: phone.outbox,
            attachments: phone.attachments,
            newId,
            issue: filed.localKey,
            uploaderId: ME,
            serverAt: srv.clock,
            draft: tray,
        });
        expect(added).toMatchObject({ dependsOn: filed.localKey, lane: `issue-comments:${filed.localKey}` });
        expect(phone.attachments.list(tray)).toEqual([]);
        expect(heldIssueFiles(phone.outbox.holds(), filed.localKey).map((file) => file.name)).toEqual([
            'keep.png',
            'added.png',
        ]);

        // Send again: the filing, then the files the tray holds now.
        const opened = editIssueFields(phone.outbox.unsent()[0]!)!;
        expect(
            await resendIssue({
                outbox: phone.outbox,
                id: filed.localKey,
                fields: opened.fields,
                idempotencyKey: 'k2',
            }),
        ).toBe(true);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.attachments(41).map((a) => a.name)).toEqual(['keep.png', 'added.png']);
        await phone.until(() => phone.copies().length === 0);
    });

    it('Send again queues a file left in the Edit’s tray, so every file it shows is sent', async () => {
        const srv = server();
        srv.goneRuns.add('run-gone');
        const phone = await open(srv);
        await phone.attachments.add(ISSUE_DRAFT, [phone.pick('keep.png', 100, 'image/png', 'k')]);
        const filed = await fileWithTray(phone, srv, 'Export fails', 'run-gone');
        await phone.until(() => phone.outbox.unsent().length === 1);

        // A pick whose own queueing never ran (or failed): in the tray, with no row.
        const tray = issueEditTray(filed.localKey);
        await phone.attachments.add(tray, [phone.pick('late.png', 100, 'image/png', 'l')], { existing: 1 });
        expect(phone.attachments.list(tray).map((file) => file.name)).toEqual(['late.png']);
        expect(heldIssueFiles(phone.outbox.holds(), filed.localKey).map((file) => file.name)).toEqual(['keep.png']);

        const opened = editIssueFields(phone.outbox.unsent()[0]!)!;
        expect(
            await resendIssueWithFiles({
                outbox: phone.outbox,
                attachments: phone.attachments,
                newId,
                uploaderId: ME,
                serverAt: srv.clock,
                id: filed.localKey,
                fields: opened.fields,
                idempotencyKey: 'k3',
            }),
        ).toBe(true);
        expect(phone.attachments.list(tray)).toEqual([]);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.attachments(41).map((a) => a.name)).toEqual(['keep.png', 'late.png']);
        await phone.until(() => phone.copies().length === 0);

        // A filing that is gone: nothing queued, nothing sent.
        expect(
            await resendIssueWithFiles({
                outbox: phone.outbox,
                attachments: phone.attachments,
                newId,
                uploaderId: ME,
                id: filed.localKey,
                fields: opened.fields,
                idempotencyKey: 'k4',
            }),
        ).toBe(false);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('lays a pending file over the detail’s attachments', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.scripts.push('hold');
        await phone.attachments.add(ISSUE_DRAFT, [phone.pick('one.png')]);
        const filed = await fileWithTray(phone, srv);
        const overlays = overlaysOf({
            rows: phone.outbox.rows(),
            kinds: ISSUE_ATTACHMENT_VIEWS,
            scope: { resolve: () => null },
        }).filter((overlay) => overlay.collection === ISSUE_ATTACHMENTS);
        expect(overlays).toHaveLength(1);
        expect(overlays[0]).toMatchObject({
            mode: 'insert',
            value: { issue: filed.localKey, name: 'one.png', mediaType: 'image/png', commentId: null },
        });
    });
});

describe('the body', () => {
    it('joins the base64 into JSON the server reads as it would a stringified object', () => {
        const fields = { name: 'a "b".png', mediaType: 'image/png', commentId: 'c-1' };
        const data = Buffer.from('hello').toString('base64');
        expect(JSON.parse(attachmentBody(fields, data))).toEqual({ ...fields, data });
        expect(JSON.parse(attachmentBody({ ...fields, commentId: null }, data))).toEqual({
            name: fields.name,
            mediaType: fields.mediaType,
            data,
        });
    });
});

describe('signing out', () => {
    it('leaves no copy of a queued issue file after the wipe', async () => {
        const root = temp('socio-issue-files-wipe-');
        const { store } = await launch(testPhone(root));
        cleanups.push(() => store.registry.close());
        const ada = await addWorkspace(store, 'https://acme.example.test', 'u-ada');
        const layout = workspaceLayout(root, ada.id);
        const userKey = await store.keys.read(workspaceKeyName(ada.id, 'user'));
        const file = await openUserDb(store.driver, layout.directory, userKey!);
        const srv = server();
        const attachments = await openAttachments({
            db: file.db,
            state: file.state,
            layout,
            files: nodeFiles(),
            setFileProtection: async () => {},
            fetch: srv.fetch,
            newId: () => 'f1',
        });
        const picker = temp('socio-picker-');
        const uri = join(picker, 'a.png');
        writeFileSync(uri, 'png');
        await attachments.add(ISSUE_DRAFT, [{ uri, name: 'a.png', mime: 'image/png', bytes: 3, temporary: true }]);
        expect(readdirSync(layout.attachments)).toEqual(['f1.png']);
        await attachments.close();
        await wipe(store, ada.id, 'sign-out');
        expect(existsSync(layout.directory)).toBe(false);
        expect(srv.log).toEqual([]);
    });
});
