import type { Message } from '@ag-ui/client';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import { withPrivateResultsWithheld } from '@socio/foundation/context/room-context';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type { CodingSessionView } from '@socio/shared/coding/coding-sessions';
import { TOOL_ACTOR_METADATA } from '@socio/shared/types';

import type { RunRecord, SessionRecord } from '../src/server/coding/infra/rows.js';
import { promptNote, roomPromptNote } from '../src/server/coding/report.js';
import { gitGateway } from '../src/server/gateway/git.js';

import { REPO, codingWorld, eventually, openCodeOutput } from './support/coding-fixture.js';

// CB-239, CB-232: in a room, a
// coding session's results are its own person's. Other members, and
// later turns acting for them, get a neutral line; a prompt's report in a
// room says only that it ended; the person's own card leaves the agent's
// words out once they may no longer use the repository.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET_WORDS = 'Changed src/payroll.ts to skip the audit';

it('withholds every coding tool’s result from turns for anyone else in a room', () => {
    const tools = ['coding_start', 'coding_prompt', 'coding_status', 'coding_diff', 'coding_open_pr', 'coding_stop'];
    const messages: Message[] = [
        {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: tools.map((name, index) => ({
                id: `call-${index}`,
                type: 'function',
                function: { name, arguments: '{}' },
            })),
        } as Message,
        ...tools.map(
            (_name, index) =>
                ({
                    id: `t${index}`,
                    role: 'tool',
                    toolCallId: `call-${index}`,
                    content: JSON.stringify({
                        status: 'done',
                        session: { id: 'sess-1', repository: REPO, branch: 'socio/x/1' },
                        agentSaid: SECRET_WORDS,
                        diff: '+secret line',
                    }),
                    metadata: { [TOOL_ACTOR_METADATA]: 'alice' },
                }) as Message,
        ),
    ];
    const forBob = withPrivateResultsWithheld(messages, 'bob');
    for (const [index, name] of tools.entries()) {
        const content = String((forBob[index + 1] as { content: unknown }).content);
        expect(JSON.parse(content)).toMatchObject({
            withheld: true,
            tool: name,
            status: 'ok',
        });
        expect(content).not.toContain(REPO);
        expect(content).not.toContain('payroll');
        expect(content).not.toContain('secret line');
    }
    // Alice's own turn keeps her results.
    expect(withPrivateResultsWithheld(messages, 'alice')).toBe(messages);
});

const session = {
    id: 'sess-1',
    repository: REPO,
    branch: 'socio/rulo/ab12cd34',
    base: 'main',
} as SessionRecord;
const run = {
    id: 'run-1',
    state: 'done',
    summary: SECRET_WORDS,
    error: null,
    changedFiles: ['src/payroll.ts'],
    tokens: 1234,
} as unknown as RunRecord;

it('words a room’s report note with nothing of the session; a private chat’s keeps the details', () => {
    const room = roomPromptNote(run, 'Alice');
    expect(room.startsWith('[Coding prompt ended.')).toBe(true);
    expect(room).toContain('"Alice"');
    expect(room).toContain('finished');
    for (const secret of [REPO, 'socio/rulo', 'payroll', SECRET_WORDS, '1234', 'sess-1']) {
        expect(room).not.toContain(secret);
    }
    expect(roomPromptNote({ ...run, state: 'failed' } as RunRecord, 'Alice')).toContain('ended early');
    // A person's name is quoted as data, on one line.
    expect(roomPromptNote(run, 'Al\nice "x"')).toContain('"Al ice \\"x\\""');
    const own = promptNote(session, run);
    expect(own).toContain(REPO);
    expect(own).toContain(SECRET_WORDS);
});

async function roomWorld() {
    const world = await codingWorld({ waitMs: 50 });
    cleanup.push(() => world.close());
    const turns = vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({ text: 'Noted.' } as never);
    const roomId = world.chatOf('alice', 'Sales room');
    const thread = world.workspace.slices.conversations.thread.bind(world.workspace.slices.conversations);
    vi.spyOn(world.workspace.slices.conversations, 'thread').mockImplementation((id: string) => {
        const found = thread(id);
        return found && id === roomId ? { ...found, kind: 'room', title: 'Sales room' } : found;
    });
    // Alice and Bob are the room's members.
    vi.spyOn(world.workspace.slices.conversations, 'allows').mockImplementation(
        (personId: string, id: string) => id === roomId && ['alice', 'bob'].includes(personId),
    );
    const turn = world.turnOf('alice', { threadId: roomId });
    const { session } = await world.started({}, turn);
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        const id = c.req.header('x-test-user') ?? 'alice';
        c.set('user', { id, name: id, role: 'member' } as never);
        await next();
    });
    app.route('/gateway', world.routes());
    const card = (user: string) =>
        app.request(`/gateway/sessions/${session!.id}`, {
            headers: { 'x-test-user': user },
        });
    return { ...world, turns, roomId, turn, session: session!, card };
}

it('reports a prompt that outlived the turn in a room with a neutral note, acting for its person only', async () => {
    const world = await roomWorld();
    expect(world.session.conversationKind).toBe('room');
    const runs: string[] = [];
    world.supervisor.behavior.onPrompt = (exec) => void runs.push(exec.runId);
    expect(await world.tool('coding_prompt', world.turn)({ message: 'Fix payroll' })).toMatchObject({
        status: 'working',
    });
    world.supervisor.finish(runs[0]!, { stdout: openCodeOutput(SECRET_WORDS) });
    const reports = () => world.turns.mock.calls.filter((call) => String(call[1]).startsWith('[Coding prompt ended.'));
    await eventually(() => reports().length === 1);
    const [threadId, note, , options] = reports()[0]!;
    expect(threadId).toBe(world.roomId);
    expect(String(note)).toContain('This is a room');
    for (const secret of [REPO, world.session.branch, 'payroll', SECRET_WORDS]) {
        expect(String(note)).not.toContain(secret);
    }
    expect(options).toMatchObject({
        textOnly: true,
        actingUserId: 'alice',
        trigger: { kind: 'person', id: 'alice' },
    });
    // The note itself is an approval note the room's other members get
    // withheld (it is stored as Alice's).
    const stored = await world.platform.approvals.list('alice');
    expect(JSON.stringify(stored)).not.toContain(SECRET_WORDS);
});

it('shows the session card to its person only; another member gets the 404 the client shows as the neutral line', async () => {
    const world = await roomWorld();
    const own = await world.card('alice');
    expect(own.status).toBe(200);
    const bob = await world.card('bob');
    expect(bob.status).toBe(404);
    expect(await bob.json()).toEqual({ error: 'No such session.' });
});

it('leaves the agent’s words out of its own person’s card once they may no longer use the repository', async () => {
    const world = await roomWorld();
    const runs: string[] = [];
    world.supervisor.behavior.onPrompt = (exec) => void runs.push(exec.runId);
    await world.tool('coding_prompt', world.turn)({ message: 'Fix payroll' });
    world.supervisor.finish(runs[0]!, { stdout: openCodeOutput(SECRET_WORDS) });
    await eventually(() => world.service.runs.latest(world.session.id)?.state === 'done');
    const before = (await (await world.card('alice')).json()) as CodingSessionView;
    expect(before.run?.summary).toContain('payroll');
    expect(before.resultsWithheld).toBeUndefined();
    // An admin narrows the repository to Bob: Alice may no longer see it.
    await gitGateway(world.platform).repos.save(REPO, { users: ['bob'] }, 'olga');
    const after = (await (await world.card('alice')).json()) as CodingSessionView;
    expect(after.resultsWithheld).toBe(true);
    expect(after.run).toMatchObject({
        summary: null,
        progress: [],
        changedFiles: [],
    });
    expect(JSON.stringify(after)).not.toContain('payroll');
    // The facts stay: which repository and branch, its state.
    expect(after).toMatchObject({ repository: REPO });
});
