import { Layer } from 'effect';

/**
 * Replay's layers: the process's replayer behind `Replayer`, and
 * `replayMessages` behind `EventReplay`. Only the composition root imports this
 * file.
 *
 * It starts nothing and needs nothing. Each call reaches `sharedReplayer()`
 * when it is made, the same process-wide replayer `turns/local-runner.ts`
 * takes by default, so both share one worker and one cache; the replay
 * worker is still made on first use and `SOCIO_REPLAY` is read then. No
 * `PlatformConfig` field covers replay, so there is no `ReplayConfig`.
 * Nothing closes the worker at shutdown today (an idle worker is
 * `unref`ed), so the layer adds no finalizer.
 */
import { EventReplay, Replayer } from './contract.js';
import { sharedReplayer } from './pool.js';
import { replayMessages } from './replay.js';

/** `Replayer` over the process's replayer, looked up at the moment of use. */
export const ReplayerLive = Layer.sync(Replayer, () =>
    Replayer.of({
        messages: (key, threadId, rows, options) => sharedReplayer().messages(key, threadId, rows, options),
        forget: (key) => sharedReplayer().forget(key),
        forgetPrefix: (prefix) => sharedReplayer().forgetPrefix(prefix),
    }),
);

/** `EventReplay` over `replayMessages`: on the calling thread, uncached, as its callers do today. */
export const EventReplayLive = Layer.succeed(EventReplay, EventReplay.of({ messages: replayMessages }));

/** Both of replay's services. */
export const ReplayLive = Layer.mergeAll(ReplayerLive, EventReplayLive);
