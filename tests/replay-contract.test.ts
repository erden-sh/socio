// The replay worker's contract: what moved there keeps its values, the
// replayers implement the shape, and the tag carries its
// `socio/replay/Replayer` key.
import { EventType } from '@ag-ui/client';
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { REPLAY_CACHE_BYTES as packagedBytes } from '@socio/foundation/replay/limits';

import {
    REPLAY_CACHE_BYTES,
    REPLAY_TIMEOUT_MS,
    ReplayError,
    Replayer,
    type ReplayerShape,
    type StoredRunRow,
} from '../src/server/replay/contract.js';
import * as pool from '../src/server/replay/pool.js';
import * as replay from '../src/server/replay/replay.js';

it('keeps the moved values', () => {
    expect(REPLAY_CACHE_BYTES).toBe(packagedBytes);
    expect([REPLAY_CACHE_BYTES, REPLAY_TIMEOUT_MS]).toEqual([64 * 1024 * 1024, 600_000]);
    const error = new ReplayError('Replay timed out.', 'timeout');
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('ReplayError: Replay timed out.');
    expect(error.reason).toBe('timeout');
});

it('the tag carries its key', () => {
    expect(Replayer.key).toBe('socio/replay/Replayer');
});

it('an InlineReplayer serves the Replayer tag', async () => {
    const replayer: ReplayerShape = new pool.InlineReplayer();
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
    const result = await Effect.runPromise(
        Replayer.use((tag) => Effect.promise(() => tag.messages('k', 'thread', rows))).pipe(
            Effect.provide(Layer.succeed(Replayer, replayer)),
        ),
    );
    expect(result.messages).toEqual(await replay.replayRows('thread', rows));
    expect(result.messages.map((message) => message.content)).toEqual(['Hello']);
    expect(result.stats).toEqual({ cachedRows: 0, replayedRows: 1 });
});
