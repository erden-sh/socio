import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbstractAgent, EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';
import { approvalNoteMessagePrefix, approvalNoteSource } from '@socio/shared/approvals';
import { ROOM_DISCLOSURE_VERSION, ROOM_STREAM_CLOSED, ROOM_STREAM_CURSOR } from '@socio/shared/rooms/rooms';
import { TIME_ZONE_MOVED_EVENT } from '@socio/shared/time-zone';
import { SENDER_METADATA } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { ROOM_STREAM_POLL_MS, ROOM_STREAM_RECHECK_MS, RoomStreams } from '../src/server/rooms/streams.js';

import { PNG } from './fixtures/media.js';
import { ROOM_PEOPLE, matrixChats, roomsFixture, type Caller } from './fixtures/rooms.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-212 (server half): a room's members read it live, each as the rule
// lets them (other people's private results, screenshots and approvals'
// notes withheld), and a member's streams close the moment they may no
// longer read it: removed, gone, the room archived or Rooms turned off,
// on this runtime or another of the deploy (CB-108). Stop is the cycle's
// initiator's or a room admin's.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

// ---- Helpers -------------------------------------------------------------------

interface Frame {
    event?: string;
    id?: string;
    data: string;
}

/** Reads a server-sent event stream as it comes. */
function sse(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Frame[] = [];
    let buffer = '';
    let ended = false;
    let endedAt = 0;
    const done = (async () => {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            let at: number;
            while ((at = buffer.indexOf('\n\n')) >= 0) {
                const raw = buffer.slice(0, at);
                buffer = buffer.slice(at + 2);
                const frame: Frame = { data: '' };
                for (const line of raw.split('\n')) {
                    if (line.startsWith(':')) {
                        continue;
                    }
                    const split = line.indexOf(': ');
                    const [key, value] = [line.slice(0, split), line.slice(split + 2)];
                    if (key === 'event') {
                        frame.event = value;
                    } else if (key === 'id') {
                        frame.id = value;
                    } else if (key === 'data') {
                        frame.data += value;
                    }
                }
                if (frame.data || frame.event) {
                    frames.push(frame);
                }
            }
        }
    })()
        .catch(() => undefined)
        .finally(() => {
            ended = true;
            endedAt = Date.now();
        });
    cleanup.push(() => reader.cancel().catch(() => undefined));
    return {
        frames,
        done,
        get ended() {
            return ended;
        },
        get endedAt() {
            return endedAt;
        },
        /** Everything it sent, as one text. */
        text: () => frames.map((frame) => frame.data).join('\n'),
        /** Its AG-UI events. */
        events: () => frames.filter((frame) => !frame.event).map((frame) => JSON.parse(frame.data) as BaseEvent),
        named: (name: string) =>
            frames
                .filter((frame) => frame.event === name)
                .map((frame) => JSON.parse(frame.data) as Record<string, unknown>),
    };
}

/**
 * A turn that calls a tool and gets `result`, then answers; with `hold`,
 * it waits after the result until it is stopped.
 */
class ToolAgent extends AbstractAgent {
    aborted = false;
    private release?: () => void;
    constructor(
        private call: { id: string; result: string },
        private hold = false,
        private extra: object[] = [],
    ) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const { threadId, runId } = input;
            const next = (event: object) => subscriber.next(event as BaseEvent);
            next({ type: EventType.RUN_STARTED, threadId, runId });
            next({
                type: EventType.TOOL_CALL_START,
                toolCallId: this.call.id,
                toolCallName: 'computer_screenshot',
                parentMessageId: `m-${runId}`,
            });
            next({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: this.call.id,
                delta: '{}',
            });
            next({ type: EventType.TOOL_CALL_END, toolCallId: this.call.id });
            next({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `r-${runId}`,
                toolCallId: this.call.id,
                content: this.call.result,
                role: 'tool',
            });
            for (const event of this.extra) {
                next(event);
            }
            const finish = () => {
                next({
                    type: EventType.TEXT_MESSAGE_START,
                    messageId: `t-${runId}`,
                    role: 'assistant',
                });
                next({
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: `t-${runId}`,
                    delta: 'Done.',
                });
                next({ type: EventType.TEXT_MESSAGE_END, messageId: `t-${runId}` });
                next({ type: EventType.RUN_FINISHED, threadId, runId });
                subscriber.complete();
            };
            if (!this.hold) {
                finish();
            } else {
                this.release = () => subscriber.complete();
            }
        });
    }
    abortRun() {
        this.aborted = true;
        this.release?.();
    }
}

/** A turn in the room as `person` sent it (the runner, as the app runs it). */
function runAs(
    runner: LocalAgentRunner,
    dotId: string,
    threadId: string,
    runId: string,
    person: string,
    agent: AbstractAgent,
    more: Message[] = [],
) {
    const messages: Message[] = [
        {
            id: `u-${runId}`,
            role: 'user',
            content: 'What is on my screen?',
            metadata: { [SENDER_METADATA]: person },
        } as Message,
        ...more,
    ];
    agent.agentId = dotId;
    agent.threadId = threadId;
    agent.setMessages(messages);
    return lastValueFrom(
        runner.run({
            threadId,
            agent,
            input: {
                threadId,
                runId,
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
            signals: { trigger: { kind: 'person', id: person } },
        }),
        { defaultValue: undefined },
    ).catch(() => undefined);
}

const follow = async (caller: Caller, roomId: string, after = 0) => {
    const response = await caller(`/conversations/${roomId}/stream?after=${after}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    return sse(response);
};

const connect = async (caller: Caller, dotId: string, roomId: string) =>
    caller(`/copilotkit/agent/${dotId}/connect`, 'POST', {
        threadId: roomId,
        runId: 'connect',
        messages: [],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
    });

// ---- Filtering ------------------------------------------------------------------

it('streams a room to each member as the rule lets them: other people’s results, screenshots and approvals’ notes withheld', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = f.platform.runner;
    // Ada's screenshot, taken in her turn in the room (CB-209: hers alone).
    const shot = await f.platform.media.saveToolImage(
        { userId: 'ada', dotId: f.company.id, threadId: roomId },
        { name: 'screenshot-ada.png', bytes: PNG, width: 1, height: 1 },
    );
    const result = JSON.stringify({
        url: 'https://intranet.example/ADA-PAGE-CANARY',
        image: { id: shot.id },
    });
    // A finished turn of Ada's, with an approval's note that quotes hers.
    await runAs(runner, f.company.id, roomId, 'run-ada-1', 'ada', new ToolAgent({ id: 'call-ada-1', result }), [
        {
            id: `${approvalNoteMessagePrefix}n1`,
            role: 'user',
            content: 'Approved: read ADA-NOTE-CANARY.',
            metadata: { socioSource: approvalNoteSource },
        } as Message,
    ]);
    expect(runner.runTrace('run-ada-1')?.status).toBe('finished');

    // Mo and Ada follow the room; then Ada's next turn runs while they do.
    const mo = await follow(f.as('mo'), roomId);
    const ada = await follow(f.as('ada'), roomId);
    const live = new ToolAgent({ id: 'call-ada-2', result: 'ADA-LIVE-CANARY 3pm dentist' }, true, [
        {
            type: EventType.CUSTOM,
            name: TIME_ZONE_MOVED_EVENT,
            value: { zone: 'Pacific/ADA-ZONE-CANARY' },
        },
    ]);
    const running = runAs(runner, f.company.id, roomId, 'run-ada-2', 'ada', live);
    await vi.waitFor(() => expect(mo.text()).toContain('"toolCallId":"call-ada-2"'));
    await vi.waitFor(() => expect(ada.text()).toContain('ADA-LIVE-CANARY'));
    // While it runs: Mo sees the call and that it worked, never what it held.
    expect(mo.text()).not.toContain('ADA-LIVE-CANARY');
    expect(mo.text()).not.toContain('ADA-ZONE-CANARY');
    expect(ada.text()).toContain('ADA-ZONE-CANARY');
    // The room's own messages reach both.
    for (const stream of [mo, ada]) {
        expect(stream.text()).toContain('What is on my screen?');
    }

    // The stored turn, replayed: the same for each.
    for (const canary of ['ADA-PAGE-CANARY', shot.id, 'ADA-NOTE-CANARY']) {
        expect(mo.text(), canary).not.toContain(canary);
    }
    expect(mo.text()).toContain('withheld');
    expect(ada.text()).toContain('ADA-PAGE-CANARY');
    expect(ada.text()).toContain(shot.id);
    expect(ada.text()).toContain('ADA-NOTE-CANARY');
    // A cursor after each finished run, to resume after it.
    const seq = runner.historyRows(roomId, { limit: 1 })[0]!.seq;
    expect(mo.named(ROOM_STREAM_CURSOR)).toContainEqual({ seq });
    expect(mo.frames.find((frame) => frame.event === ROOM_STREAM_CURSOR)?.id).toBe(String(seq));

    // The turn ends: the stream stays open for the next one, and the stored
    // turn isn't sent again.
    live.abortRun();
    await running;
    await vi.waitFor(() => expect(mo.named(ROOM_STREAM_CURSOR)).toHaveLength(2));
    expect(mo.ended).toBe(false);
    expect(mo.events().filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(2);

    // A screenshot is served to its person only.
    const content = `/media/attachments/${shot.id}/content`;
    expect((await f.as('mo')(content)).status).toBe(404);
    expect((await f.as('ada')(content)).status).toBe(200);

    // The transcript and the history give Mo the note withheld too.
    for (const path of ['transcript', 'history']) {
        const forMo = JSON.stringify(await (await f.as('mo')(`/conversations/${roomId}/${path}`)).json());
        expect(forMo, path).not.toContain('ADA-NOTE-CANARY');
        const forAda = JSON.stringify(await (await f.as('ada')(`/conversations/${roomId}/${path}`)).json());
        expect(forAda, path).toContain('ADA-NOTE-CANARY');
    }

    // The runtime's own connect (AG-UI): a member's, filtered the same way;
    // nobody else's.
    const viaConnect = await connect(f.as('mo'), f.company.id, roomId);
    expect(viaConnect.status).toBe(200);
    const connected = sse(viaConnect);
    await connected.done;
    expect(connected.text()).toContain('call-ada-2');
    for (const canary of ['ADA-LIVE-CANARY', 'ADA-PAGE-CANARY', shot.id]) {
        expect(connected.text(), canary).not.toContain(canary);
    }
    // Only AG-UI frames on the runtime's connect.
    expect(connected.frames.every((frame) => !frame.event)).toBe(true);
    for (const person of ['rex', 'ivy', 'nina', 'alice', 'olive']) {
        expect((await connect(f.as(person), f.company.id, roomId)).status, person).toBe(403);
        expect((await f.as(person)(`/conversations/${roomId}/stream`)).status, person).toBe(404);
    }
});

it('resumes after a cursor, and serves a private chat’s stream to its owner only', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId, privateId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const n of [1, 2]) {
        await runAs(
            f.platform.runner,
            f.company.id,
            roomId,
            `run-${n}`,
            'mo',
            new ToolAgent({ id: `call-${n}`, result: `MO-RESULT-${n}` }),
        );
    }
    const [first] = f.platform.runner.historyRows(roomId, { after: 0, limit: 1 });
    const stream = await follow(f.as('mo'), roomId, first!.seq);
    await vi.waitFor(() => expect(stream.named(ROOM_STREAM_CURSOR)).toHaveLength(1));
    expect(stream.text()).toContain('MO-RESULT-2');
    expect(stream.text()).not.toContain('MO-RESULT-1');
    expect((await f.as('mo')(`/conversations/${roomId}/stream?after=x`)).status).toBe(400);
    // A private chat: its owner's, nobody else's; no room registry.
    const own = sse(await f.as('olive')(`/conversations/${privateId}/stream`));
    expect((await f.as('ada')(`/conversations/${privateId}/stream`)).status).toBe(404);
    // Made a room, it ends at its next turn: its owner connects again as a
    // member, so other people's turns never reach them unfiltered.
    expect(
        (
            await f.as('olive')(`/rooms/${privateId}/convert`, 'POST', {
                confirmHistory: true,
            })
        ).status,
    ).toBe(201);
    expect(own.ended).toBe(false);
    await runAs(
        f.platform.runner,
        f.company.id,
        privateId,
        'run-olive',
        'olive',
        new ToolAgent({ id: 'call-olive', result: 'OLIVE-RESULT' }),
    );
    await own.done;
    expect(own.text()).not.toContain('OLIVE-RESULT');

    // The server stopping ends every stream, with no reason: the reader
    // connects to the next server.
    f.platform.roomStreams.stop();
    await stream.done;
    expect(stream.named(ROOM_STREAM_CLOSED)).toEqual([]);
});

// ---- Ending -----------------------------------------------------------------------

it('closes a removed member’s streams within a second, and theirs only', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Mo's turn runs, and Mo and Ada each watch the room two ways.
    const agent = new ToolAgent({ id: 'call-mo', result: 'MO-RESULT' }, true);
    const running = runAs(f.platform.runner, f.company.id, roomId, 'run-mo', 'mo', agent);
    await vi.waitFor(() => expect(f.platform.runner.activeRunId(roomId)).toBe('run-mo'));
    const moFollow = await follow(f.as('mo'), roomId);
    const moConnect = sse(await connect(f.as('mo'), f.company.id, roomId));
    const adaFollow = await follow(f.as('ada'), roomId);
    await vi.waitFor(() => expect(moConnect.text()).toContain('call-mo'));
    expect(f.platform.roomStreams.count(roomId, 'mo')).toBe(2);

    const removedAt = Date.now();
    expect((await f.as('ada')(`/rooms/${roomId}/members/mo`, 'DELETE')).status).toBe(200);
    await Promise.all([moFollow.done, moConnect.done]);
    expect(moFollow.endedAt - removedAt).toBeLessThan(1_000);
    expect(moConnect.endedAt - removedAt).toBeLessThan(1_000);
    expect(moFollow.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'removed' }]);
    expect(f.platform.roomStreams.count(roomId, 'mo')).toBe(0);
    // Ada's stays open; Mo can't open another.
    expect(adaFollow.ended).toBe(false);
    expect((await f.as('mo')(`/conversations/${roomId}/stream`)).status).toBe(404);
    // And Mo's turn was stopped (CB-208).
    await vi.waitFor(() => expect(agent.aborted).toBe(true));
    await running;
});

it('closes streams as a member leaves, as the room is archived, and as Rooms are turned off; members then read it again', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Nina joins, then leaves: her stream ends as she goes.
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const nina = await follow(f.as('nina'), roomId);
    const mo = await follow(f.as('mo'), roomId);
    expect((await f.as('nina')(`/rooms/${roomId}/leave`, 'POST')).status).toBe(200);
    await nina.done;
    expect(nina.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'left' }]);
    expect(mo.ended).toBe(false);

    // Archived: everyone's ends; members read the archived room again.
    const ada = await follow(f.as('ada'), roomId);
    expect((await f.as('ada')(`/rooms/${roomId}/archive`, 'POST')).status).toBe(200);
    await Promise.all([mo.done, ada.done]);
    expect(mo.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'archived' }]);
    expect(ada.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'archived' }]);
    const archived = await follow(f.as('mo'), roomId);
    expect((await f.as('ada')(`/rooms/${roomId}/unarchive`, 'POST')).status).toBe(200);
    expect(archived.ended).toBe(false);

    // Rooms off: every room's streams end and its turn stops; members still
    // read (read-only), nobody sends, stops or queues.
    const agent = new ToolAgent({ id: 'call-mo', result: 'MO-RESULT' }, true);
    const running = runAs(f.platform.runner, f.company.id, roomId, 'run-mo', 'mo', agent);
    await vi.waitFor(async () => expect(await f.platform.cycles.running(roomId)).toBeTruthy());
    const off = await f.as('alice')('/settings', 'PATCH', {
        rooms: { enabled: false },
    });
    expect(off.status).toBe(200);
    await archived.done;
    expect(archived.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'rooms_off' }]);
    await vi.waitFor(() => expect(agent.aborted).toBe(true));
    await running;
    const readOnly = await follow(f.as('mo'), roomId);
    expect(readOnly.ended).toBe(false);
    expect(f.workspace.allows('mo', roomId, 'send')).toBe(false);
    expect(await f.platform.cycles.mayStop(roomId, 'ada')).toBe(false);
    expect(await f.platform.cycles.mayDispatch(roomId, 'mo')).toBe(false);
    // Turned back on, the room runs again; queued work goes on.
    const resume = vi.spyOn(f.platform.steering, 'resume');
    expect((await f.as('alice')('/settings', 'PATCH', { rooms: { enabled: true } })).status).toBe(200);
    expect(resume).toHaveBeenCalled();
    expect(f.workspace.allows('mo', roomId, 'send')).toBe(true);
});

it('re-checks open streams: a change it was not told of ends them within seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    cleanup.push(() => vi.useRealTimers());
    let allowed = true;
    let on = true;
    const db = testDatabase();
    cleanup.push(() => db.close());
    const streams = new RoomStreams(db, {
        mayRead: () => allowed,
        roomsOn: () => on,
    });
    const closed: Array<string | undefined> = [];
    streams.open('room-1', 'mo', { close: (reason) => closed.push(reason) });
    allowed = false;
    vi.advanceTimersByTime(ROOM_STREAM_RECHECK_MS);
    expect(closed).toEqual(['access']);
    expect(streams.count()).toBe(0);
    // The switch turned off elsewhere (another runtime's admin): the poll
    // reads it.
    allowed = true;
    streams.open('room-1', 'mo', { close: (reason) => closed.push(reason) });
    on = false;
    vi.advanceTimersByTime(ROOM_STREAM_POLL_MS);
    expect(closed).toEqual(['access', 'rooms_off']);
    streams.stop();
});

// ---- Two runtimes (CB-108) ----------------------------------------------------------

it('closes a stream on one runtime when the member is removed on the other', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'rooms-two-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'socio.db'));
    // Two runtimes over one file, as two servers over one database.
    const runtime = async () => {
        const { platform, workspace, app, dispose } = await makeTestRuntime({
            database: path,
            config: {
                apiKey: '',
                model: '',
                rooms: { enabled: true },
                data: { userDataDir: join(dir, 'data') },
            },
            runner: new LocalAgentRunner(path, { runtime: new RuntimeSession() }),
            app: {
                config: { mode: 'live', baseUrl: '' },
                auth: {
                    provider: new MockAuthProvider(ROOM_PEOPLE, 'rooms-matrix-secret-0123456789abcdef'),
                    secureCookies: false,
                },
            },
        });
        cleanup.push(dispose);
        for (const user of ROOM_PEOPLE) {
            workspace.recordUser(user);
        }
        const cookies = new Map<string, string>();
        const as =
            (userId: string): Caller =>
            async (route, method = 'GET', body) => {
                let cookie = cookies.get(userId);
                if (!cookie) {
                    const login = await app.request('/api/auth/mock/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId }),
                    });
                    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
                    cookies.set(userId, cookie);
                }
                return app.request(`/api${route}`, {
                    method,
                    headers: {
                        cookie,
                        ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                });
            };
        return { platform, workspace, as };
    };
    const a = await runtime();
    const b = await runtime();
    const dotId = a.workspace.companyDots()[0]!.id;
    const made = await a.as('ada')('/rooms', 'POST', { dotId, title: 'Launch' });
    const { id: roomId } = (await made.json()) as { id: string };
    await a.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'mo' });
    await a.as('mo')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });

    // Mo's stream is on runtime B; Ada removes Mo on runtime A.
    const onB = await follow(b.as('mo'), roomId);
    const adaOnB = await follow(b.as('ada'), roomId);
    expect(b.platform.roomStreams.count(roomId, 'mo')).toBe(1);
    expect(a.platform.roomStreams.count()).toBe(0);
    const removedAt = Date.now();
    expect((await a.as('ada')(`/rooms/${roomId}/members/mo`, 'DELETE')).status).toBe(200);
    await onB.done;
    // B learned it from the signal row, well before its 5-s re-check.
    expect(onB.endedAt - removedAt).toBeLessThan(1_000);
    expect(onB.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'removed' }]);
    expect(adaOnB.ended).toBe(false);

    // Invited back and joined again on A: a new stream on B is not closed
    // by the old removal.
    await a.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'mo' });
    await a.as('mo')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const back = await follow(b.as('mo'), roomId);
    await new Promise((resolve) => setTimeout(resolve, ROOM_STREAM_POLL_MS * 3));
    expect(back.ended).toBe(false);

    // The room archived on A ends every stream on B.
    await a.as('ada')(`/rooms/${roomId}/archive`, 'POST');
    await Promise.all([back.done, adaOnB.done]);
    expect(adaOnB.named(ROOM_STREAM_CLOSED)).toEqual([{ reason: 'archived' }]);
});

// ---- Stop -----------------------------------------------------------------------------

it('lets the cycle’s initiator or a room admin stop a room’s turn, and nobody else', async () => {
    const f = await roomsFixture(cleanup);
    const { roomId } = await matrixChats(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await f.as('ada')(`/rooms/${roomId}/invites`, 'POST', { userId: 'nina' });
    await f.as('nina')(`/rooms/${roomId}/accept`, 'POST', {
        disclosureVersion: ROOM_DISCLOSURE_VERSION,
    });
    const stop = (person: string) => f.as(person)(`/copilotkit/agent/${f.company.id}/stop/${roomId}`, 'POST', {});
    const turn = async (runId: string) => {
        const agent = new ToolAgent({ id: `call-${runId}`, result: 'ok' }, true);
        const running = runAs(f.platform.runner, f.company.id, roomId, runId, 'mo', agent);
        await vi.waitFor(async () =>
            expect(await f.platform.cycles.running(roomId)).toMatchObject({
                initiator: { kind: 'person', id: 'mo' },
            }),
        );
        return { agent, running };
    };

    // Mo's turn: Nina (a member, not its initiator) may not stop it; people
    // outside the room, a removed member, an invitee and a workspace admin
    // are refused before that.
    const first = await turn('run-1');
    const refused = await stop('nina');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'not_initiator' });
    for (const person of ['rex', 'ivy', 'olive', 'alice']) {
        expect((await stop(person)).status, person).toBe(403);
    }
    expect(first.agent.aborted).toBe(false);
    // Its initiator may.
    expect((await stop('mo')).status).toBe(200);
    await vi.waitFor(() => expect(first.agent.aborted).toBe(true));
    await first.running;

    // A room admin may stop anyone's.
    const second = await turn('run-2');
    expect((await stop('ada')).status).toBe(200);
    await vi.waitFor(() => expect(second.agent.aborted).toBe(true));
    await second.running;
});
