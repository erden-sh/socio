// Replay's layers: `ReplayerLive` serves the `Replayer` tag over the process's
// replayer, the one `sharedReplayer()` hands `turns/local-runner.ts`, so both
// share one cache; `EventReplay` is `replayMessages`; the composition root's
// step serves both.
import { EventType } from '@ag-ui/client';
import { Effect } from 'effect';
import { expect, it } from 'vitest';

import { replayLayers } from '../src/server/composition/replay.js';
import { EventReplay, Replayer, type StoredRunRow } from '../src/server/replay/contract.js';
import { EventReplayLive, ReplayerLive, ReplayLive } from '../src/server/replay/layer.js';
import { InlineReplayer, sharedReplayer } from '../src/server/replay/pool.js';
import { replayMessages, replayRows } from '../src/server/replay/replay.js';

const rows: StoredRunRow[] = [
    {
        seq: 1,
        runId: 'run-1',
        events: JSON.stringify([
            { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run-1' },
            { type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
            { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'Hello' },
            { type: EventType.TEXT_MESSAGE_END, messageId: 'm1' },
            { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run-1' },
        ]),
    },
];

it('the composition step serves both tags', async () => {
    expect(replayLayers.bridges).toBe(ReplayLive);
    const services = await Effect.runPromise(
        Effect.gen(function* () {
            return [yield* Replayer, yield* EventReplay];
        }).pipe(Effect.provide(replayLayers.bridges)),
    );
    expect(services).toHaveLength(2);
});

it('EventReplay is replayMessages, on the calling thread', async () => {
    const events = JSON.parse(rows[0].events);
    const messages = await Effect.runPromise(
        EventReplay.use((replay) => Effect.promise(() => replay.messages('thread', events))).pipe(
            Effect.provide(EventReplayLive),
        ),
    );
    expect(messages).toEqual(await replayMessages('thread', events));
    expect(messages.map((message) => message.content)).toEqual(['Hello']);
});

it('the tag replays through the shared replayer and forgets in its cache', async () => {
    // The test suite sets SOCIO_REPLAY=inline: the shared replayer is inline.
    const shared = sharedReplayer();
    expect(shared).toBeInstanceOf(InlineReplayer);
    const cache = (shared as InlineReplayer).cache;
    const key = 'replay-layer-test:thread';
    const prefix = 'replay-layer-test-prefix:';

    const first = await Effect.runPromise(
        Replayer.use((replayer) => Effect.promise(() => replayer.messages(key, 'thread', rows))).pipe(
            Effect.provide(ReplayerLive),
        ),
    );
    expect(first.messages).toEqual(await replayRows('thread', rows));
    expect(first.stats).toEqual({ cachedRows: 0, replayedRows: 1 });
    expect(cache.has(key)).toBe(true);

    const again = await Effect.runPromise(
        Replayer.use((replayer) => Effect.promise(() => replayer.messages(key, 'thread', rows))).pipe(
            Effect.provide(ReplayerLive),
        ),
    );
    expect(again.stats).toEqual({ cachedRows: 1, replayedRows: 0 });

    await Effect.runPromise(
        Replayer.use((replayer) => Effect.sync(() => replayer.forget(key))).pipe(Effect.provide(ReplayerLive)),
    );
    expect(cache.has(key)).toBe(false);

    await shared.messages(`${prefix}a`, 'thread', rows);
    await shared.messages(`${prefix}b`, 'thread', rows);
    await Effect.runPromise(
        Replayer.use((replayer) => Effect.sync(() => replayer.forgetPrefix(prefix))).pipe(Effect.provide(ReplayerLive)),
    );
    expect([cache.has(`${prefix}a`), cache.has(`${prefix}b`)]).toEqual([false, false]);
});
