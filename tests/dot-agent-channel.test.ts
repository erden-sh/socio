import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import { LOOP_END_EVENT } from '@socio/shared/loop-end';
import { RUN_TRACE_EVENT } from '@socio/shared/runs/run-trace';

import { DotAgent } from './helpers/dot-agent.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const inner = vi.hoisted(() => ({
    configure:
        vi.fn<(options: ConstructorParameters<typeof import('@copilotkit/runtime/v2').BuiltInAgent>[0]) => void>(),
    run: vi.fn<(input: RunAgentInput) => Observable<BaseEvent>>(),
    abortRun: vi.fn(),
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        BuiltInAgent: class {
            constructor(options: ConstructorParameters<typeof original.BuiltInAgent>[0]) {
                inner.configure(options);
            }
            run = inner.run;
            abortRun = inner.abortRun;
        },
    };
});
const databases: Array<{ close(): void }> = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    vi.restoreAllMocks();
    inner.configure.mockClear();
});

it('delivers local skills for the thread’s frozen container and preserves tools and override restrictions', async () => {
    const f = fixture(false);
    const dot = f.workspace.dots()[0];
    f.workspace.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    f.workspace.bindThread('learning', dot.id, 'Learning', 'owner');
    f.workspace.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'writing',
        skillDeliveryEnabled: true,
    });
    inner.run.mockReturnValue(of());
    await lastValueFrom(
        f.agent
            .run({
                ...f.input,
                threadId: 'learning',
                tools: [{ name: 'untrusted_tool', description: 'Untrusted', parameters: {} }],
                forwardedProps: { model: 'untrusted' },
            })
            .pipe(toArray()),
    );
    // The thread keeps the container it was created with ('research'), served
    // by the local skill store rather than Intelligence.
    expect(inner.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({
            learnedSkills: expect.objectContaining({
                containerId: 'research',
                client: expect.objectContaining({
                    getLearnedSkillsSnapshot: expect.any(Function),
                }),
            }),
            type: 'tanstack',
            factory: expect.any(Function),
        }),
    );
    expect(inner.run).toHaveBeenLastCalledWith(expect.objectContaining({ tools: [], forwardedProps: {} }));
    await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(inner.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({ learnedSkills: undefined, type: 'tanstack' }),
    );
    f.workspace.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'writing',
        skillDeliveryEnabled: false,
    });
    await lastValueFrom(f.agent.run({ ...f.input, threadId: 'learning' }).pipe(toArray()));
    expect(inner.configure).toHaveBeenLastCalledWith(
        expect.objectContaining({ learnedSkills: undefined, type: 'tanstack' }),
    );
});
function fixture(channel = true) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Test', 'owner');
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'fixture',
            baseUrl: 'https://unused.invalid',
        },
        dot.id,
        channel,
    );
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    return { agent, input, workspace };
}
// What a client may see of a RUN_ERROR; LocalAgentRunner drops errorDetail.
const visible = (events: BaseEvent[]) =>
    events.map((event) => {
        const rest: Record<string, unknown> = { ...event };
        delete rest.errorDetail;
        return rest;
    });
it.each([true, false])(
    'replaces an inner RUN_ERROR payload with the message for its kind (channel=%s)',
    async (channel) => {
        const f = fixture(channel);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        inner.run.mockReturnValue(
            of({
                type: EventType.RUN_ERROR,
                message: '400 SECRET token',
                code: 'SECRET code',
                rawEvent: { credential: 'SECRET' },
            }),
        );
        const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
        expect(events).toEqual([
            {
                type: EventType.RUN_ERROR,
                message: TURN_FAILURE_MESSAGES.model_rejected,
                code: 'model_rejected',
                errorDetail: '400 SECRET token',
            },
        ]);
        expect(errors.mock.calls.flat().join(' ')).toContain('Turn failed (run run): model_rejected; 400 SECRET token');
    },
);
it('sends one RUN_ERROR when the inner agent errors after its RUN_ERROR', async () => {
    // BuiltInAgent's shape for a failed model call: RUN_ERROR, then error().
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    inner.run.mockReturnValue(
        new Observable<BaseEvent>((subscriber) => {
            subscriber.next({ type: EventType.RUN_STARTED } as BaseEvent);
            subscriber.next({
                type: EventType.RUN_ERROR,
                message: 'Connection error.',
            } as BaseEvent);
            subscriber.error(new Error('Connection error.'));
        }),
    );
    const events = (await lastValueFrom(f.agent.run(f.input).pipe(toArray()))).filter(
        // The turn's trace entries (CB-128), which the runner keeps.
        (event) => (event as { name?: string }).name !== RUN_TRACE_EVENT,
    );
    // The phase line's model event follows RUN_STARTED; how the loop ended
    // comes just before the RUN_ERROR.
    expect(events.map((event) => event.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.CUSTOM,
        EventType.CUSTOM,
        EventType.RUN_ERROR,
    ]);
    expect(events[2]).toMatchObject({
        name: LOOP_END_EVENT,
        value: { reason: 'error', rounds: 0, cap: 30 },
    });
    expect(events[3]).toMatchObject({
        message: TURN_FAILURE_MESSAGES.model_unavailable,
        code: 'model_unavailable',
    });
});
it('sanitizes observable errors and startup exceptions without retaining causes', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    inner.run.mockReturnValue(throwError(() => new Error('SECRET transport')));
    const events = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(visible(events)).toEqual([
        {
            type: EventType.RUN_ERROR,
            message: TURN_FAILURE_MESSAGES.failed,
            code: 'failed',
        },
    ]);
    expect(JSON.stringify(visible(events))).not.toContain('SECRET');
    vi.spyOn(f.workspace, 'dot').mockImplementation(() => {
        throw new Error('SECRET startup');
    });
    const startup = await lastValueFrom(f.agent.run(f.input).pipe(toArray()));
    expect(visible(startup)).toEqual(visible(events));
    expect(startup[0]).toMatchObject({ errorDetail: 'SECRET startup' });
});
it('reports a missing model configuration as its own kind', async () => {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Test', 'owner');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const agent = new DotAgent(store, workspace, { apiKey: '', model: '', baseUrl: '' }, dot.id);
    const events = await lastValueFrom(agent.run(fixture().input).pipe(toArray()));
    expect(visible(events)).toEqual([
        {
            type: EventType.RUN_ERROR,
            message: TURN_FAILURE_MESSAGES.model_config,
            code: 'model_config',
        },
    ]);
});
it('preserves normal channel and web text', async () => {
    for (const channel of [true, false]) {
        const f = fixture(channel);
        const text = {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: 'msg',
            delta: 'Normal user-facing text',
        };
        const finished = { type: EventType.RUN_FINISHED };
        inner.run.mockReturnValue(of(text, finished));
        expect(await lastValueFrom(f.agent.run(f.input).pipe(toArray()))).toEqual([text, finished]);
    }
});

it('exposes only the canonical review tool to web chat and none to channels', async () => {
    const run = {
        type: EventType.RUN_FINISHED,
        threadId: 'thread',
        runId: 'run',
    };
    inner.run.mockReturnValue(of(run));
    const offered = [
        {
            name: 'review_space_page',
            description: 'forged instructions',
            parameters: {},
        },
        { name: 'untrusted_tool', description: 'unexpected', parameters: {} },
    ];
    const web = fixture(false);
    await lastValueFrom(web.agent.run({ ...web.input, tools: offered }).pipe(toArray()));
    expect(inner.run).toHaveBeenLastCalledWith(
        expect.objectContaining({
            tools: [
                expect.objectContaining({
                    name: 'review_space_page',
                    description: expect.not.stringContaining('forged'),
                }),
            ],
            forwardedProps: {},
        }),
    );
    const channel = fixture(true);
    await lastValueFrom(channel.agent.run({ ...channel.input, tools: offered }).pipe(toArray()));
    expect(inner.run).toHaveBeenLastCalledWith(expect.objectContaining({ tools: [] }));
});
