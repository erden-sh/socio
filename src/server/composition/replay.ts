/**
 * Replay's part of the graph: the process's replayer behind `Replayer` and
 * `replayMessages` behind `EventReplay`, from `replay/layer.ts`. It starts
 * nothing and reads no `PlatformConfig` (replay has no setting there; the
 * worker reads `SOCIO_REPLAY` on first use, as before), so there is no
 * `ReplayConfig` to build here, no routes and no lifecycle.
 */
import { ReplayLive } from '../replay/layer.js';

/** Replay's step of the graph, at its end. */
export const replayLayers = {
    bridges: ReplayLive,
};
