import { afterEach, expect, it } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { AgentBoard } from '../src/server/agents/board.js';
import { filingTools } from '../src/server/issues/filing-tools.js';

import { boardOf } from './helpers/board.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const close of cleanup.splice(0)) {
        close();
    }
});
function fixture() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const member = { id: 'member', name: 'Member', role: 'member' as const };
    workspace.recordUser(member);
    return { workspace, member, board: new AgentBoard(workspace, boardOf(workspace)) };
}

it('pages actual status events by persistent order, preserving equal and backward timestamps without authors', async () => {
    const f = fixture();
    const issue = await boardOf(f.workspace).issues.create({ title: 'Dated issue' }, 'private-actor', 1000);
    await boardOf(f.workspace).issues.update(issue.number, { status: 'open' }, 'private-actor', 1000);
    await boardOf(f.workspace).issues.update(
        issue.number,
        { title: 'Edited title', status: 'wont_fix' },
        'private-actor',
        900,
    );
    await boardOf(f.workspace).issues.update(issue.number, { status: 'in_progress' }, 'private-actor', 800);
    const first = await f.board.read('CB-1', f.member, '', { historyLimit: 2 });
    expect(first).toMatchObject({
        outcome: 'found',
        statusHistory: {
            complete: false,
            coverage: 'recorded-only',
            order: 'sequence',
            events: [
                {
                    kind: 'created',
                    from: null,
                    to: 'triage',
                    at: new Date(1000).toISOString(),
                },
                {
                    kind: 'status',
                    from: 'triage',
                    to: 'open',
                    at: new Date(1000).toISOString(),
                },
            ],
        },
    });
    if (first.outcome !== 'found') {
        throw Error('Missing issue');
    }
    const next = await f.board.read('CB-1', f.member, '', {
        historyAfter: first.statusHistory.next!,
        historyLimit: 2,
    });
    expect(next).toMatchObject({
        statusHistory: {
            complete: true,
            next: null,
            events: [
                {
                    kind: 'status',
                    from: 'open',
                    to: 'wont_fix',
                    at: new Date(900).toISOString(),
                },
                {
                    kind: 'status',
                    from: 'wont_fix',
                    to: 'in_progress',
                    at: new Date(800).toISOString(),
                },
            ],
        },
    });
    if (next.outcome !== 'found') {
        throw Error('Missing issue');
    }
    const sequence = [...first.statusHistory.events, ...next.statusHistory.events].map((e) => e.sequence);
    expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
    expect(new Set(sequence).size).toBe(4);
    const history = JSON.stringify([first.statusHistory, next.statusHistory]);
    expect(history).not.toMatch(/private-actor|actorId|issueId|Edited title/);
});

it('labels imported initial states as recorded imports without inventing earlier transitions', async () => {
    const f = fixture();
    await boardOf(f.workspace).issues.create(
        { title: 'Imported finished issue', status: 'done' },
        'importer',
        2000,
        'import',
    );
    const item = await boardOf(f.workspace).filings.item('CB-1', { userId: f.member.id });
    expect(item).toMatchObject({
        statusHistory: {
            complete: true,
            coverage: 'recorded-only',
            events: [
                {
                    kind: 'imported',
                    from: null,
                    to: 'done',
                    at: new Date(2000).toISOString(),
                },
            ],
        },
    });
    if (item.outcome === 'found') {
        expect(item.statusHistory.events).toHaveLength(1);
    }
    await expect(
        boardOf(f.workspace).filings.item('CB-1', {
            userId: f.member.id,
            historyLimit: 101,
        }),
    ).rejects.toThrow();
    await expect(
        boardOf(f.workspace).filings.item('CB-1', { userId: f.member.id, historyAfter: -1 }),
    ).rejects.toThrow();
});

it('the shared listing enumerates closed and open issues, filters, stable ties and explicit completion', async () => {
    const f = fixture();
    for (const status of ['triage', 'open', 'done', 'wont_fix'] as const) {
        await boardOf(f.workspace).issues.create({ title: 'Issue ' + status, status }, 'member', 1000);
    }
    const first = await f.board.list({}, { sort: 'newest', limit: 2 }, f.member);
    expect(first).toMatchObject({
        total: 4,
        next: 2,
        complete: false,
        enumeration: 'live',
        items: [{ issue: 'CB-4' }, { issue: 'CB-3' }],
    });
    const last = await boardOf(f.workspace).filings.list(
        {},
        { userId: f.member.id, sort: 'newest', limit: 2, offset: first.next! },
    );
    expect(last).toMatchObject({
        total: 4,
        next: null,
        complete: true,
        items: [{ issue: 'CB-2' }, { issue: 'CB-1' }],
    });
    expect(new Set([...first.items, ...last.items].map((x) => x.issue)).size).toBe(4);
    expect(await boardOf(f.workspace).filings.list({ status: 'done' }, { userId: f.member.id })).toMatchObject({
        total: 1,
        items: [{ issue: 'CB-3', status: 'done' }],
    });
});

it('internal listing and history keep the issuesAllowed gate and turn checks', async () => {
    const f = fixture();
    await boardOf(f.workspace).issues.create({ title: 'Visible to member' }, 'member', 1000);
    const dot = f.workspace.dots()[0]!;
    const turn = (allowed: boolean, stopped = false) =>
        ({
            dot: { ...dot, issuesAllowed: allowed },
            userId: f.member.id,
            threadId: 'thread',
            signal: new AbortController().signal,
            check: () => {
                if (stopped) {
                    throw Error('stopped');
                }
            },
        }) as unknown as DotTurn;
    expect(filingTools(boardOf(f.workspace).filings, turn(false))).toEqual([]);
    type Tool = { name: string; execute: (input: unknown) => Promise<unknown> };
    const tools = filingTools(boardOf(f.workspace).filings, turn(true)) as unknown as Tool[];
    expect(await tools.find((t) => t.name === 'list_improvements')!.execute({ limit: 1 })).toMatchObject({
        total: 1,
        next: null,
        complete: true,
        items: [{ issue: 'CB-1' }],
    });
    expect(
        await tools.find((t) => t.name === 'read_improvement')!.execute({ issue: 'CB-1', historyLimit: 1 }),
    ).toMatchObject({
        statusHistory: {
            complete: true,
            events: [{ kind: 'created', to: 'triage' }],
        },
    });
    const stopped = filingTools(boardOf(f.workspace).filings, turn(true, true)) as unknown as Tool[];
    await expect(stopped.find((t) => t.name === 'list_improvements')!.execute({})).rejects.toThrow('stopped');
});

it('caps default history pages and exposes the continuation rather than claiming a complete timeline', async () => {
    const f = fixture();
    const issue = await boardOf(f.workspace).issues.create({ title: 'Long status history' }, 'member', 1000);
    for (let i = 0; i < 104; i++) {
        await boardOf(f.workspace).issues.update(
            issue.number,
            { status: i % 2 === 0 ? 'open' : 'triage' },
            'member',
            1000,
        );
    }
    const first = await boardOf(f.workspace).filings.item('CB-1', { userId: f.member.id });
    if (first.outcome !== 'found') {
        throw Error('Missing issue');
    }
    expect(first.statusHistory.events).toHaveLength(100);
    expect(first.statusHistory.complete).toBe(false);
    const last = await boardOf(f.workspace).filings.item('CB-1', {
        userId: f.member.id,
        historyAfter: first.statusHistory.next!,
    });
    if (last.outcome !== 'found') {
        throw Error('Missing issue');
    }
    expect(last.statusHistory.events).toHaveLength(5);
    expect(last.statusHistory).toMatchObject({ complete: true, next: null });
    expect(new Set([...first.statusHistory.events, ...last.statusHistory.events].map((e) => e.sequence)).size).toBe(
        105,
    );
});
