import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { ISSUE_ATTACHMENTS_PER_ISSUE } from '@socio/shared/issues/issue-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { Goals, IssuesConfig, MediaFiles } from '../src/server/issues/contract.js';
import { filingTools } from '../src/server/issues/filing-tools.js';
import { issuesModule } from '../src/server/issues/module.js';
import { SqliteBoardService } from '../src/server/issues/tags.js';
import { turnFiles } from '../src/server/issues/turn-files.js';

import { PNG, pngOf } from './fixtures/media.js';
import { testModuleServices } from './helpers/module-services.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/**
 * A Dot's board tools carry the conversation's files onto what it files
 * or comments: only this conversation's, readable by the person it acts
 * for, through the board's attachment checks; each refusal is per file.
 */

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type Tool = { name: string; execute: (input: unknown) => Promise<unknown> };
type Outcome = {
    outcome: string;
    message: string;
    attachments?: {
        attached: Array<{ id: string; name: string }>;
        notAttached: Array<{ id: string; name?: string; reason: string }>;
    };
};

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-dot-attach-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: '', runtimeUrl: '', data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const dot = { ...workspace.dots()[0]!, issuesAllowed: true };
    const thread = await platform.createConversation(dot.id, 'A', 'alice');
    /** An attachment sent in a message of `threadId` (bound, as a turn does). */
    const sent = async (name: string, bytes: Uint8Array, { userId = 'alice', threadId = thread.id } = {}) => {
        const ref = (
            await platform.media.upload(userId, {
                name,
                bytes,
                purpose: 'attachment',
                threadId,
            })
        ).attachment!;
        await platform.media.bind(
            (await platform.media.attachment(ref.id))!,
            { userId, dotId: dot.id, threadId },
            `m-${ref.id}`,
        );
        return ref;
    };
    const turn: DotTurn = {
        dot,
        userId: 'alice',
        threadId: thread.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    const tools = filingTools(platform.board.filings, turn, {
        origin: 'https://brain.example',
        files: (ids) => turnFiles(platform.media, turn, ids),
    }) as unknown as Tool[];
    const tool = (name: string) => tools.find((item) => item.name === name)!;
    return { platform, workspace, dot, thread, sent, turn, tool, store };
}

it('copies the conversation’s screenshots onto a new item, uploaded by the person', async () => {
    const f = await fixture();
    const shot = await f.sent('image.png', pngOf(2048, 7));
    const log = await f.sent('app.log', Buffer.from('error at line 3\n'));
    const result = (await f.tool('file_improvement').execute({
        title: 'Export button does nothing',
        kind: 'bug',
        problem: 'Pressing Export on the board does nothing.',
        attachments: [shot.id, log.id, shot.id],
    })) as Outcome;
    expect(result).toMatchObject({
        outcome: 'filed',
        attachments: {
            attached: [
                { id: shot.id, name: 'image.png' },
                { id: log.id, name: 'app.log' },
            ],
            notAttached: [],
        },
    });
    expect(result.message).toContain('Attached “image.png”, “app.log”.');
    const issue = (await f.platform.board.issues.get(1))!;
    const files = await f.platform.board.issues.attachments(issue.id);
    expect(files).toMatchObject([
        {
            name: 'image.png',
            mediaType: 'image/png',
            size: 2048,
            commentId: null,
            uploaderId: 'alice',
        },
        { name: 'app.log', mediaType: 'text/plain', uploaderId: 'alice' },
    ]);
    // The bytes, as they were sent.
    expect(Buffer.from((await f.platform.board.issues.attachment(files[0]!.id))!.data)).toEqual(pngOf(2048, 7));
    // The item is still the Dot's filing, for the person.
    expect(issue.reporterId).toBe(`dot:${f.dot.id}`);
    expect(await f.platform.board.filings.filing(issue.id)).toMatchObject({
        dotId: f.dot.id,
        userId: 'alice',
    });
});

it('attaches files to a Dot’s comment', async () => {
    const f = await fixture();
    await f.platform.board.issues.create({ title: 'Dark mode' }, 'bob');
    const shot = await f.sent('dark.png', PNG);
    const result = (await f.tool('comment_on_improvement').execute({
        issue: 'CB-1',
        comment: 'Here is how it looks at night.',
        attachments: [shot.id],
    })) as Outcome;
    expect(result).toMatchObject({
        outcome: 'commented',
        attachments: { attached: [{ id: shot.id, name: 'dark.png' }] },
    });
    const issue = (await f.platform.board.issues.get(1))!;
    const [comment] = await f.platform.board.issues.comments(issue.id);
    expect(await f.platform.board.issues.attachments(issue.id)).toMatchObject([
        { name: 'dark.png', commentId: comment!.id, uploaderId: 'alice' },
    ]);
});

it('refuses, file by file, what the turn may not use or the board does not take, and still files', async () => {
    const f = await fixture();
    const other = await f.platform.createConversation(f.dot.id, 'B', 'alice');
    const elsewhere = await f.sent('elsewhere.png', PNG, { threadId: other.id });
    const bobsThread = await f.platform.createConversation(f.dot.id, 'C', 'bob');
    const bobs = await f.sent('bob.png', PNG, {
        userId: 'bob',
        threadId: bobsThread.id,
    });
    const gone = await f.sent('gone.png', PNG);
    await f.platform.data.deleteFile(
        'alice',
        f.platform.media.view((await f.platform.media.attachment(gone.id))!).path!,
    );
    const archive = await f.sent('bundle.zip', Buffer.from('PK\u0003\u0004 not really a zip'));
    const good = await f.sent('good.png', PNG);
    const result = (await f.tool('file_improvement').execute({
        title: 'Settings page crashes',
        kind: 'bug',
        problem: 'The settings page crashes on open.',
        attachments: [elsewhere.id, bobs.id, gone.id, archive.id, 'cbatt_AAAAAAAAAAAAAAAAAAAAAA', good.id],
    })) as Outcome;
    expect(result.outcome).toBe('filed');
    const here = 'it isn’t one of the files shared in this conversation';
    expect(result.attachments).toEqual({
        attached: [{ id: good.id, name: 'good.png' }],
        notAttached: [
            { id: elsewhere.id, reason: here },
            { id: bobs.id, reason: here },
            { id: gone.id, name: 'gone.png', reason: 'it was deleted' },
            {
                id: archive.id,
                name: 'bundle.zip',
                reason: 'the board takes only PNG, JPEG, GIF or WebP images, PDFs and plain text files',
            },
            { id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA', reason: here },
        ],
    });
    // No names of files the person can't see leak into the result.
    expect(JSON.stringify(result)).not.toMatch(/elsewhere|bob\.png/);
    expect(result.message).toContain('Not attached: “bundle.zip”');
    expect(result.message).toMatch(/never describe those as attached/);
    expect(
        (await f.platform.board.issues.attachments((await f.platform.board.issues.get(1))!.id)).map(
            (file) => file.name,
        ),
    ).toEqual(['good.png']);
});

it('stops at the board’s per-item cap, and refuses more ids than it in the input', async () => {
    const f = await fixture();
    await f.platform.board.issues.create({ title: 'Dark mode' }, 'bob');
    const issue = (await f.platform.board.issues.get(1))!;
    for (let i = 0; i < ISSUE_ATTACHMENTS_PER_ISSUE - 1; i += 1) {
        await f.platform.board.issues.addAttachment(1, { name: `old-${i}.png`, data: PNG }, 'bob');
    }
    const one = await f.sent('one.png', pngOf(100, 1));
    const two = await f.sent('two.png', pngOf(100, 2));
    const result = (await f.tool('comment_on_improvement').execute({
        issue: 'CB-1',
        comment: 'Two more screenshots.',
        attachments: [one.id, two.id],
    })) as Outcome;
    expect(result).toMatchObject({
        outcome: 'commented',
        attachments: {
            attached: [{ id: one.id }],
            notAttached: [
                {
                    id: two.id,
                    name: 'two.png',
                    reason: `the item already has ${ISSUE_ATTACHMENTS_PER_ISSUE} attachments, the most the board allows`,
                },
            ],
        },
    });
    expect(await f.platform.board.issues.attachments(issue.id)).toHaveLength(ISSUE_ATTACHMENTS_PER_ISSUE);
    await expect(
        f.tool('comment_on_improvement').execute({
            issue: 'CB-1',
            comment: 'Too many.',
            attachments: Array.from({ length: ISSUE_ATTACHMENTS_PER_ISSUE + 1 }, (_, i) => `cbatt_${i}`),
        }),
    ).rejects.toThrow();
});

it('lists an item’s and its comments’ attachments in read_improvement, as text', async () => {
    const f = await fixture();
    const shot = await f.sent('image.png', pngOf(170_000));
    await f.tool('file_improvement').execute({
        title: 'Export button does nothing',
        kind: 'bug',
        problem: 'Pressing Export does nothing.',
        attachments: [shot.id],
    });
    const log = await f.sent('app.log', Buffer.from('boom\n'));
    await f.tool('comment_on_improvement').execute({
        issue: 'CB-1',
        comment: 'The log.',
        attachments: [log.id],
    });
    const item = (await f.tool('read_improvement').execute({
        issue: 'CB-1',
    })) as Record<string, unknown> & {
        comments: { recent: Array<Record<string, unknown>> };
    };
    const url = 'https://brain.example/issues/CB-1';
    expect(item.attachments).toEqual([{ name: 'image.png', type: 'image/png', size: '166 KB', url }]);
    expect(item.comments.recent.at(-1)!.attachments).toEqual([
        { name: 'app.log', type: 'text/plain', size: '5 B', url },
    ]);
    expect(JSON.stringify(item)).not.toContain('base64');
});

it('wires the conversation’s files into the module’s board tools, and says so when a turn has none', async () => {
    const f = await fixture();
    const shot = await f.sent('image.png', PNG);
    const tools = issuesModule.dotTools!(
        {
            // The Board, a goal by its task and the turn's files, as the app's
            // services hold them.
            services: testModuleServices({ store: f.store, workspace: f.workspace }, [
                [IssuesConfig, { appOrigin: 'https://brain.example' }],
                [SqliteBoardService, f.platform.context.services.get(SqliteBoardService)],
                [Goals, f.platform.context.services.get(Goals)],
                [MediaFiles, f.platform.context.services.get(MediaFiles)],
            ]),
        } as never,
        f.turn,
    ) as unknown as Tool[];
    const filed = (await tools
        .find((tool) => tool.name === 'file_improvement')!
        .execute({
            title: 'Export button does nothing',
            kind: 'bug',
            problem: 'Pressing Export does nothing.',
            attachments: [shot.id],
        })) as Outcome;
    expect(filed.attachments?.attached).toEqual([{ id: shot.id, name: 'image.png' }]);
    // Without the conversation's files, nothing is attached, and it says so.
    const bare = filingTools(f.platform.board.filings, f.turn) as unknown as Tool[];
    const result = (await bare
        .find((tool) => tool.name === 'comment_on_improvement')!
        .execute({
            issue: 'CB-1',
            comment: 'More.',
            attachments: [shot.id],
        })) as Outcome;
    expect(result.attachments).toEqual({
        attached: [],
        notAttached: [{ id: shot.id, reason: 'files can’t be attached in this turn' }],
    });
    expect(result.message).toContain('Nothing was attached.');
});

it('tells the Dot to attach shared screenshots and never to claim an attachment it did not make', async () => {
    const f = await fixture();
    for (const name of ['file_improvement', 'comment_on_improvement']) {
        const description = (f.tool(name) as unknown as { description: string }).description;
        expect(description).toMatch(/screenshots or files/);
        expect(description).toMatch(/never describe an image or file as attached/);
    }
});
