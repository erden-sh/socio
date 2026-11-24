import { afterEach, expect, it } from 'vitest';

import type { AgentActor } from '@socio/foundation/agents/actor';

import { AgentBoard, agentFilingInput } from '../src/server/agents/board.js';
import { dotFilingInput } from '../src/server/issues/filings.js';

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
    const admin = { id: 'admin', name: 'Admin', role: 'admin' as const };
    const member = { id: 'member', name: 'Member', role: 'member' as const };
    workspace.recordUser(admin);
    workspace.recordUser(member);
    const board = new AgentBoard(workspace, boardOf(workspace));
    const actor = (userId: string): AgentActor => ({
        userId,
        grantId: 'grant',
        clientId: 'https://agent.example',
        clientName: 'Agent',
        clientDomain: 'agent.example',
        label: 'Agent',
        scopes: ['issues:read', 'issues:write'],
    });
    const turn = (userId: string) => ({
        userId,
        dotId: workspace.dots()[0]!.id,
        trigger: 'chat' as const,
        causeId: null,
        threadId: 'thread',
    });
    const input = {
        title: 'Implement dependent work',
        kind: 'feature' as const,
        description: 'Respect prerequisite and downstream issues.',
        force: true,
    };
    return { workspace, board, admin, member, actor, turn, input };
}

it('connected filing writes both dependency directions and attributes both histories in one transaction', async () => {
    const f = fixture();
    const prerequisite = await boardOf(f.workspace).issues.create({ title: 'Required foundation' }, 'admin');
    const downstream = await boardOf(f.workspace).issues.create({ title: 'Downstream release' }, 'admin');
    const filed = await f.board.file(f.actor('admin'), f.admin, {
        ...f.input,
        blockedBy: ['CB-1', '1'],
        blocks: ['CB-2'],
    });
    expect(filed).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    const issue = await boardOf(f.workspace).issues.require(3);
    expect(await boardOf(f.workspace).issues.blockedBy(issue.id)).toMatchObject([{ number: 1 }]);
    expect(await boardOf(f.workspace).issues.blocks(issue.id)).toMatchObject([{ number: 2 }]);
    for (const linked of [prerequisite, issue, downstream]) {
        const events = (await boardOf(f.workspace).issues.events(linked.id)).filter(
            (e) => e.kind === 'blocked_by' || e.kind === 'blocks',
        );
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.actorId === 'admin')).toBe(true);
        expect((await boardOf(f.workspace).agentActions.eventAttributions(linked.id, events)).size).toBe(events.length);
    }
});

it('missing targets, self links and cycles roll back the filing and existing-issue history', async () => {
    for (const dependencies of [
        { blockedBy: ['CB-1', 'CB-999'] },
        { blockedBy: ['CB-3'] },
        { blockedBy: ['CB-1'], blocks: ['CB-2'] },
    ]) {
        const f = fixture();
        const first = await boardOf(f.workspace).issues.create({ title: 'Foundation' }, 'admin');
        const second = await boardOf(f.workspace).issues.create({ title: 'Existing prerequisite' }, 'admin');
        await boardOf(f.workspace).issues.addBlocker(first.number, second.number, 'admin');
        const before = await boardOf(f.workspace).issues.events(first.id);
        await expect(f.board.file(f.actor('admin'), f.admin, { ...f.input, ...dependencies })).rejects.toThrow();
        expect(await boardOf(f.workspace).issues.list()).toHaveLength(2);
        expect(await boardOf(f.workspace).issues.events(first.id)).toEqual(before);
        expect(await boardOf(f.workspace).issues.blocks(first.id)).toEqual([]);
    }
});

it('member tools cannot set relationships or leave an orphan filing, but can file normally', async () => {
    const f = fixture();
    await boardOf(f.workspace).issues.create({ title: 'Existing issue' }, 'admin');
    expect(
        await f.board.file(f.actor('member'), f.member, {
            ...f.input,
            blockedBy: ['CB-1'],
        }),
    ).toMatchObject({ outcome: 'forbidden' });
    expect(
        await boardOf(f.workspace).filings.file(f.turn('member'), {
            title: 'Member dependent issue',
            kind: 'bug',
            problem: 'A problem',
            blockedBy: ['CB-1'],
            fileAnyway: true,
        }),
    ).toMatchObject({ outcome: 'forbidden' });
    expect(await boardOf(f.workspace).issues.list()).toHaveLength(1);
    expect(await f.board.file(f.actor('member'), f.member, f.input)).toMatchObject({ outcome: 'filed' });
});

it('internal socio filing accepts admin dependencies and rolls back invalid references', async () => {
    const f = fixture();
    await boardOf(f.workspace).issues.create({ title: 'Foundation' }, 'admin');
    await boardOf(f.workspace).issues.create({ title: 'Downstream' }, 'admin');
    const input = {
        title: 'Socio dependent feature',
        kind: 'feature' as const,
        problem: 'Link prerequisite work',
        fileAnyway: true,
    };
    await expect(
        boardOf(f.workspace).filings.file(f.turn('admin'), {
            ...input,
            blockedBy: ['CB-1', 'CB-999'],
        }),
    ).rejects.toThrow();
    expect(await boardOf(f.workspace).issues.list()).toHaveLength(2);
    const filed = await boardOf(f.workspace).filings.file(f.turn('admin'), {
        ...input,
        blockedBy: ['CB-1'],
        blocks: ['CB-2'],
    });
    expect(filed).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    const issue = await boardOf(f.workspace).issues.require(3);
    expect(await boardOf(f.workspace).issues.blockedBy(issue.id)).toMatchObject([{ number: 1 }]);
    expect(await boardOf(f.workspace).issues.blocks(issue.id)).toMatchObject([{ number: 2 }]);
    expect(await boardOf(f.workspace).filings.filing(issue.id)).toMatchObject({
        userId: 'admin',
        dotId: f.turn('admin').dotId,
    });
});

it('records each new internal dependency event with its acting person, cause and thread, without attributing old history', async () => {
    const f = fixture();
    const prerequisite = await boardOf(f.workspace).issues.create({ title: 'Foundation' }, 'admin', 1);
    const downstream = await boardOf(f.workspace).issues.create({ title: 'Downstream' }, 'admin', 1);
    await boardOf(f.workspace).issues.addComment(prerequisite.number, 'Existing history', 'admin', 2);
    const before = await boardOf(f.workspace).issues.events(prerequisite.id);
    const turn = {
        ...f.turn('admin'),
        trigger: 'scheduled' as const,
        causeId: 'task-fixture',
        threadId: 'private-thread-fixture',
    };
    await boardOf(f.workspace).filings.file(
        turn,
        {
            title: 'Dependent implementation',
            kind: 'feature',
            problem: 'Keep every acting identity',
            fileAnyway: true,
            blockedBy: ['CB-1'],
            blocks: ['CB-2'],
        },
        { now: 10 },
    );
    const created = await boardOf(f.workspace).issues.require(3);
    for (const linked of [prerequisite, created, downstream]) {
        const events = (await boardOf(f.workspace).issues.events(linked.id)).filter(
            (event) => event.kind === 'blocks' || event.kind === 'blocked_by',
        );
        const attributions = await boardOf(f.workspace).filings.eventAttributions(linked.id);
        expect(attributions.size).toBe(events.length);
        for (const event of events) {
            expect(attributions.get(event.id)).toMatchObject({
                userId: 'admin',
                dotId: turn.dotId,
                trigger: 'scheduled',
                causeId: 'task-fixture',
                createdAt: 10,
            });
            const stored = (await boardOf(f.workspace).filings.activity(turn.dotId, 10, 100)).find(
                (row) => row.targetId === event.id,
            );
            expect(stored).toMatchObject({
                action: 'update',
                issueId: linked.id,
                userId: 'admin',
                threadId: 'private-thread-fixture',
                trigger: 'scheduled',
                causeId: 'task-fixture',
                createdAt: 10,
            });
        }
        for (const event of before) {
            expect(attributions.has(event.id)).toBe(false);
        }
    }
    const byCause = await boardOf(f.workspace).filings.byCause('admin', ['task-fixture'], 0, 20);
    expect(byCause.filter((action) => action.action === 'update')).toHaveLength(4);
    // Relationship mutations do not consume separate filing/comment/vote quotas.
    expect(await boardOf(f.workspace).filings.usage(turn.dotId, 'admin', 100, 20)).toMatchObject({
        byDot: 1,
        byUser: 1,
    });
    const rowsBeforeFailure = await boardOf(f.workspace).filings.activity(turn.dotId, 100, 100);
    await expect(
        boardOf(f.workspace).filings.file(
            turn,
            {
                title: 'Invalid dependent implementation',
                kind: 'feature',
                problem: 'Rollback provenance with links',
                fileAnyway: true,
                blockedBy: ['CB-1', 'CB-999'],
            },
            { now: 20 },
        ),
    ).rejects.toThrow();
    expect(await boardOf(f.workspace).filings.activity(turn.dotId, 100, 100)).toEqual(rowsBeforeFailure);
});

it('tool schemas reject malformed or oversized relationships', () => {
    const f = fixture();
    for (const blockedBy of [['not-an-issue'], Array.from({ length: 21 }, () => 'CB-1')]) {
        expect(agentFilingInput.safeParse({ ...f.input, blockedBy }).success).toBe(false);
        expect(
            dotFilingInput.safeParse({
                title: 'A valid title',
                kind: 'bug',
                problem: 'Something breaks',
                blockedBy,
            }).success,
        ).toBe(false);
    }
});

it('connected agents and socios relate a new item to others, attributed on both ends (CB-274)', async () => {
    const f = fixture();
    const similar = await boardOf(f.workspace).issues.create({ title: 'Similar crash' }, 'admin');
    const nearby = await boardOf(f.workspace).issues.create({ title: 'Nearby report' }, 'admin');
    // A connected agent, for an admin.
    const filed = await f.board.file(f.actor('admin'), f.admin, {
        ...f.input,
        related: ['CB-1', '1'],
    });
    expect(filed).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    const agentIssue = await boardOf(f.workspace).issues.require(3);
    expect(await boardOf(f.workspace).issues.related(agentIssue.id)).toMatchObject([{ number: 1 }]);
    for (const linked of [similar, agentIssue]) {
        const events = (await boardOf(f.workspace).issues.events(linked.id)).filter(
            (event) => event.kind === 'related',
        );
        expect(events).toHaveLength(1);
        expect((await boardOf(f.workspace).agentActions.eventAttributions(linked.id, events)).size).toBe(1);
    }
    // read_issue gives the link from either end.
    const read = await f.board.read('CB-1', f.member);
    expect(read).toMatchObject({
        outcome: 'found',
        related: [{ issue: 'CB-3', title: f.input.title, status: 'triage' }],
        blockedBy: [],
        blocks: [],
    });

    // A socio, for an admin; with a blocking link in the same filing.
    const bySocio = await boardOf(f.workspace).filings.file(f.turn('admin'), {
        title: 'Socio related feature',
        kind: 'feature',
        problem: 'Relate it',
        fileAnyway: true,
        related: ['CB-2'],
        blockedBy: ['CB-1'],
    });
    expect(bySocio).toMatchObject({ outcome: 'filed', issue: 'CB-4' });
    const socioIssue = await boardOf(f.workspace).issues.require(4);
    expect(await boardOf(f.workspace).issues.related(socioIssue.id)).toMatchObject([{ number: 2 }]);
    expect(await boardOf(f.workspace).issues.blockedBy(socioIssue.id)).toMatchObject([{ number: 1 }]);
    const attributed = await boardOf(f.workspace).filings.eventAttributions(nearby.id);
    expect(attributed.size).toBe(1);

    // The same issue both related and blocking in one filing: refused whole.
    await expect(
        boardOf(f.workspace).filings.file(f.turn('admin'), {
            title: 'Conflicting links',
            kind: 'feature',
            problem: 'Both at once',
            fileAnyway: true,
            blockedBy: ['CB-2'],
            related: ['CB-2'],
        }),
    ).rejects.toThrow(/Change that link instead/);
    expect(await boardOf(f.workspace).issues.list()).toHaveLength(4);
    // Schemas bound the list and its references.
    for (const related of [['not-an-issue'], Array.from({ length: 51 }, () => 'CB-1')]) {
        expect(agentFilingInput.safeParse({ ...f.input, related }).success).toBe(false);
    }
});

it('members relate a new item through agents and socios, but set no blocking link (CB-274)', async () => {
    const f = fixture();
    const similar = await boardOf(f.workspace).issues.create({ title: 'Similar crash' }, 'admin');
    const filed = await f.board.file(f.actor('member'), f.member, {
        ...f.input,
        related: ['CB-1'],
    });
    expect(filed).toMatchObject({ outcome: 'filed', issue: 'CB-2' });
    const byAgent = await boardOf(f.workspace).issues.require(2);
    expect(await boardOf(f.workspace).issues.related(byAgent.id)).toMatchObject([{ number: 1 }]);
    // The history is the member's, with the agent beside it.
    const events = (await boardOf(f.workspace).issues.events(similar.id)).filter((event) => event.kind === 'related');
    expect(events.map((event) => event.actorId)).toEqual(['member']);
    expect((await boardOf(f.workspace).agentActions.eventAttributions(similar.id, events)).size).toBe(1);
    const bySocio = await boardOf(f.workspace).filings.file(f.turn('member'), {
        title: 'Member socio related issue',
        kind: 'bug',
        problem: 'A problem',
        related: ['CB-1'],
        fileAnyway: true,
    });
    expect(bySocio).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    expect(await boardOf(f.workspace).issues.related((await boardOf(f.workspace).issues.require(3)).id)).toMatchObject([
        { number: 1 },
    ]);
    // A blocking link beside it is refused whole: nothing is filed.
    for (const blocking of [{ blockedBy: ['CB-1'] }, { blocks: ['CB-1'] }]) {
        const refused = {
            outcome: 'forbidden',
            message:
                'Only an admin can set blocking links (blockedBy, blocks). Nothing was filed; related links are fine.',
        };
        expect(
            await f.board.file(f.actor('member'), f.member, {
                ...f.input,
                related: ['CB-1'],
                ...blocking,
            }),
        ).toEqual(refused);
        expect(
            await boardOf(f.workspace).filings.file(f.turn('member'), {
                title: 'Member blocking issue',
                kind: 'bug',
                problem: 'A problem',
                fileAnyway: true,
                ...blocking,
            }),
        ).toEqual(refused);
    }
    expect(await boardOf(f.workspace).issues.list()).toHaveLength(3);
});
