import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { pendingApproval } from '@socio/shared/approvals';

import { completion } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { Store } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-data-tools-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { store, workspace, platform, config, dispose } = await makeTestRuntime({
        config: {
            apiKey: 'fixture',
            model: 'custom-model',
            baseUrl: 'https://unused.invalid/v1',
            data: { userDataDir: dir },
        },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Data', 'alice');
    const agent = (actingUserId?: string) =>
        new DotAgent(store, workspace, config, dot.id, !!actingUserId, actingUserId, {
            extensions: platform.dotExtensions,
        });
    const input = (text: string): RunAgentInput => ({
        threadId: 'thread',
        runId: `run-${Math.random()}`,
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: text }],
        tools: [],
        forwardedProps: {},
    });
    return { platform, workspace, dot, agent, input };
}
const call = (name: string, args: unknown, id = name) =>
    completion(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        },
        'tool_calls',
    );
const results = (events: Array<{ type: string }>) =>
    Object.fromEntries(
        events
            .filter((event) => event.type === EventType.TOOL_CALL_RESULT)
            .map((event) => {
                const e = event as unknown as { toolCallId: string; content: string };
                return [e.toolCallId, JSON.parse(e.content)];
            }),
    );

it('gives a turn the data tools and capabilities, acting for the conversation’s owner', async () => {
    const f = await fixture();
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
            call('data_create_table', {
                table: 'prices',
                columns: [
                    { name: 'sku', type: 'TEXT', primaryKey: true },
                    { name: 'price', type: 'REAL' },
                ],
            }),
        )
        .mockResolvedValueOnce(call('data_insert', { table: 'prices', rows: [{ sku: 'a', price: 3 }] }))
        .mockResolvedValueOnce(call('capabilities', {}))
        .mockResolvedValueOnce(
            call('data_query', {
                sql: 'SELECT sku, price FROM prices WHERE price > ?',
                params: [1],
            }),
        )
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Tracked.' }));
    const events = await lastValueFrom(f.agent().run(f.input('Track prices.')).pipe(toArray()));
    const first = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
        tools: Array<{ function: { name: string } }>;
    };
    const names = first.tools.map((tool) => tool.function.name);
    expect(names).toEqual(
        expect.arrayContaining([
            'capabilities',
            'data_list',
            'data_query',
            'data_create_table',
            'files_put',
            'files_list',
        ]),
    );
    const out = results(events);
    expect(out.data_create_table).toMatchObject({
        status: 'done',
        result: { created: true },
    });
    expect(out.data_query.rows).toEqual([['a', 3]]);
    const capabilities = out.capabilities as {
        capabilities: Array<{
            id: string;
            enabled: boolean;
            tools: string[];
            approvals?: Array<{ policy: string }>;
        }>;
        identity: unknown;
        requests: unknown;
    };
    const data = capabilities.capabilities.find((entry) => entry.id === 'data')!;
    expect(data.enabled).toBe(true);
    expect(data.tools).toContain('data_upsert');
    expect(data.approvals?.every((entry) => entry.policy === 'manual')).toBe(true);
    expect(capabilities.capabilities.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(['pages', 'computer', 'web.research', 'memory', 'data', 'files']),
    );
    expect(capabilities.capabilities.find((entry) => entry.id === 'computer')?.enabled).toBe(false);
    // The web identity and its requests fill their sections.
    expect(capabilities.identity).toMatchObject({
        id: 'web_reads',
        identity: 'agent',
    });
    expect(capabilities.requests).toMatchObject({ pending: [], resolved: [] });
    // The table lives in Alice's scratch dataset for this Dot.
    const scratch = f.platform.data.datasetsFor('alice').find((d) => d.scratchForDotId === f.dot.id)!;
    expect(f.platform.data.detailFor('alice', scratch.id).tables[0]).toMatchObject({ name: 'prices', rowCount: 1 });
    expect(f.platform.data.datasetsFor('bob')).toEqual([]);
});

it('returns pending approval for a new dataset, and acts for the linked user on a channel turn', async () => {
    const f = await fixture();
    vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
            call('data_create_dataset', {
                name: 'Watchlist',
                description: 'Shares to watch',
            }),
        )
        .mockResolvedValueOnce(call('capabilities', {}))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Asked.' }));
    // A Telegram turn by Bob in a shared conversation: Bob's data, Bob's approval.
    const events = await lastValueFrom(f.agent('bob').run(f.input('Make a watchlist.')).pipe(toArray()));
    const out = results(events);
    const pending = pendingApproval(out.data_create_dataset)!;
    expect(pending.approval.url).toBe(`/approvals/${pending.approval.id}`);
    expect((await f.platform.approvals.get(pending.approval.id, 'bob')).status).toBe('pending');
    await expect(f.platform.approvals.get(pending.approval.id, 'alice')).rejects.toThrow(/not found/);
    expect(out.capabilities.pendingApprovals).toEqual([
        expect.objectContaining({ id: pending.approval.id, status: 'pending' }),
    ]);
});

it('gives text-only turns no data tools', async () => {
    const f = await fixture();
    const workspace = f.workspace;
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'No tools.' }));
    const agent = new DotAgent(
        new Store(testDatabase()),
        workspace,
        {
            apiKey: 'x',
            model: 'm',
            baseUrl: 'https://unused.invalid/v1',
        },
        f.dot.id,
        false,
        undefined,
        { textOnly: true, extensions: f.platform.dotExtensions },
    );
    await lastValueFrom(agent.run(f.input('Hi')).pipe(toArray()));
    const body = JSON.parse(String(network.mock.calls[0][1]?.body)) as {
        tools?: unknown[];
    };
    expect(body.tools ?? []).toEqual([]);
});

it('lets the Dot read and copy what the user attached in this conversation, and nowhere else (CB-54)', async () => {
    const f = await fixture();
    // 150,000 bytes with a two-byte character across the 100 KB window.
    const content = `${'a'.repeat(99_999)}é${'b'.repeat(49_999)}`;
    const { attachment, item } = await f.platform.media.upload('alice', {
        name: 'long notes.txt',
        bytes: Buffer.from(content),
        purpose: 'attachment',
    });
    const dotActor = (threadId: string) => ({
        kind: 'dot' as const,
        userId: 'alice',
        dotId: f.dot.id,
        threadId,
    });
    // Attached, not yet sent: no Dot sees it (the path is taken as one in
    // its own folder, where there is no such file).
    await expect(f.platform.data.getFile(dotActor('thread'), item.path)).rejects.toThrow(
        `No file dots/${f.dot.id}/${item.path}.`,
    );
    const network = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(call('files_get', { path: item.path }, 'page-1'))
        .mockResolvedValueOnce(call('files_get', { path: item.path, offset: 99_999 }, 'page-2'))
        .mockResolvedValueOnce(call('files_copy', { from: item.path, to: 'notes.txt' }, 'copy'))
        .mockResolvedValueOnce(call('attachments_list', {}, 'list'))
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Read.' }));
    const events = await lastValueFrom(
        f
            .agent()
            .run({
                ...f.input('Read it.'),
                messages: [
                    {
                        id: 'with-file',
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Read it.' },
                            {
                                type: 'binary',
                                id: attachment!.id,
                                mimeType: 'text/plain',
                                filename: 'long notes.txt',
                            },
                        ],
                    } as never,
                ],
            })
            .pipe(toArray()),
    );
    const out = results(events);
    // Windows end on a whole character and join up exactly.
    expect(out['page-1']).toMatchObject({
        path: item.path,
        encoding: 'utf8',
        offset: 0,
        nextOffset: 99_999,
        truncated: true,
    });
    expect(out['page-2']).toMatchObject({ offset: 99_999, nextOffset: null });
    expect(out['page-1'].content + out['page-2'].content).toBe(content);
    expect(out.copy).toMatchObject({ path: `dots/${f.dot.id}/notes.txt` });
    expect(out.list.attachments).toEqual([
        expect.objectContaining({
            id: attachment!.id,
            name: 'long notes.txt',
            kind: 'text',
            path: item.path,
            shownAsImage: false,
        }),
    ]);
    // The model's note named the path and the tool to read it with.
    const first = JSON.stringify(JSON.parse(String(network.mock.calls[0][1]?.body)).messages);
    expect(first).toContain(`saved at ${item.path}`);
    // Reads are audited as conversation attachments.
    expect(
        f.platform.data
            .auditFor('alice')
            .filter((entry) => entry.action === 'files_get' && entry.outcome === 'ok')
            .map((entry) => entry.detail),
    ).toContain('conversation attachment');

    // The same Dot in another conversation, and a data token, need a grant.
    f.workspace.bindThread('other', f.dot.id, 'Other', 'alice');
    await expect(f.platform.data.getFile(dotActor('other'), item.path)).rejects.toThrow(
        `No file dots/${f.dot.id}/${item.path}.`,
    );
    await expect(
        f.platform.data.getFile({ kind: 'token', userId: 'alice', dotId: f.dot.id }, item.path),
    ).rejects.toThrow(`No file dots/${f.dot.id}/${item.path}.`);
    // A read grant on attachments/ covers them all.
    f.platform.data.setGrant('alice', {
        dotId: f.dot.id,
        folder: 'attachments/',
        access: 'read',
    });
    expect((await f.platform.data.getFile(dotActor('other'), item.path)).data.length).toBe(150_000);
});

it('lets a socio in a conversation read back its own file at a deep path', async () => {
    const f = await fixture();
    const actor = {
        kind: 'dot' as const,
        userId: 'alice',
        dotId: f.dot.id,
        threadId: 'thread',
    };
    // 12 parts given; stored under dots/<id>/ it has 14.
    const path = 'a/b/c/d/e/f/g/h/i/j/k/l.txt';
    await f.platform.data.putFile(actor, path, Buffer.from('deep'), 'text/plain');
    const { file, data } = await f.platform.data.getFile(actor, path);
    expect(file.path).toBe(`dots/${f.dot.id}/${path}`);
    expect(data.toString()).toBe('deep');
    // A deep path with no file is still missing, not refused.
    await expect(f.platform.data.getFile(actor, 'a/b/c/d/e/f/g/h/i/j/k/m.txt')).rejects.toThrow(
        `No file dots/${f.dot.id}/a/b/c/d/e/f/g/h/i/j/k/m.txt.`,
    );
});
