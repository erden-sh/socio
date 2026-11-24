/**
 * A room's work (`RoomWork`): `revoke` (`revokeRoomWork`) and `switched`
 * (`roomsSwitched`), read through the tag.
 *
 * The step is placed in the graph (`composition/index.ts`) right before
 * `roomsLayers.membership`, which revokes through it. It reads the
 * approvals, work cycles, runner and room streams, all built before it,
 * and the steering turns, built later, through their port at the moment
 * of use. It registers no listener, so it changes no order.
 */
import { Context, Effect, Layer } from 'effect';

import { ROOM_APPROVAL_GONE } from '@socio/foundation/rooms/authority';

import type { ApprovalService } from '../../approvals/service.js';
import type { SteeringTurns } from '../../context/steering-turns.js';
import type { WorkCycles } from '../../cycles/service.js';
import type { RoomStreams } from '../../rooms/streams.js';
import { LegacyRoomStreams } from '../../rooms/tags.js';
import type { LocalAgentRunner } from '../../turns/local-runner.js';
import { LegacyApprovals } from '../approvals.js';
import { LegacyRunner } from '../base.js';
import { LegacyCycles } from '../cycles.js';
import { type LatePort, Ports } from '../ports.js';

/** `RoomWork.revoke` and `RoomWork.switched`. */
export interface RoomWorkShape {
    /** Ends room work nobody may do any more (`revokeRoomWork`). */
    revoke(roomId: string, userId?: string): Promise<void>;
    /** Settings → General → Rooms changed (`roomsSwitched`). */
    switched(before: boolean, after: boolean): Promise<void>;
}

/** A room's work, as rooms' membership and the settings route call it. */
export class RoomWork extends Context.Service<RoomWork, RoomWorkShape>()('socio/composition/app/RoomWork') {}

/** What a room's work reads; the steering turns through their port, built after it. */
export interface RoomWorkDeps {
    readonly approvals: Pick<ApprovalService, 'invalidate'>;
    readonly cycles: Pick<WorkCycles, 'running' | 'runningRooms'>;
    readonly runner: Pick<LocalAgentRunner, 'activeRunId' | 'stop'>;
    readonly roomStreams: Pick<RoomStreams, 'endAll'>;
    readonly steering: Pick<LatePort<Pick<SteeringTurns, 'resume'>>, 'get'>;
}

/** A room's work over `deps`, read at the moment of use. */
export function roomWork(deps: RoomWorkDeps): RoomWorkShape {
    const { approvals, cycles, runner, roomStreams, steering } = deps;
    return {
        /**
         * Ends room work nobody may do any more (CB-208), at once: the
         * running turn a removed or departed person started, or, without a
         * person (an archive, the lead socio withdrawn), whatever runs there.
         * A turn on another live runtime gets the stop through the database
         * (CB-108).
         */
        async revoke(roomId, userId) {
            // What they (or, for the whole room, anyone) were asked there can no
            // longer be decided (CB-209); their turns are not carried on.
            await approvals
                .invalidate(roomId, userId, ROOM_APPROVAL_GONE)
                .catch(() => console.error('Rooms: pending approvals could not be ended.'));
            const running = await cycles.running(roomId);
            if (userId && !(running?.initiator.kind === 'person' && running.initiator.id === userId)) {
                return;
            }
            if (!running && !runner.activeRunId(roomId)) {
                return;
            }
            await runner.stop({ threadId: roomId });
        },
        /**
         * Settings → General → Rooms changed. Turned off: every room is
         * read-only for its members at once: their live streams end here and on
         * the other runtimes (they connect again to read), and the turns
         * running in rooms stop, wherever they run; queued messages and pending
         * approvals wait. Turned back on: what waited goes on.
         */
        async switched(before, after) {
            if (before === after) {
                return;
            }
            if (after) {
                void steering.get().resume();
                return;
            }
            await roomStreams.endAll('rooms_off');
            for (const roomId of await cycles.runningRooms()) {
                await runner.stop({ threadId: roomId }).catch(() => undefined);
            }
        },
    };
}

/** The step, as `composition/index.ts` places it: `RoomWork`, built once. */
export const appRoomWorkLayers = {
    step: Layer.effect(
        RoomWork,
        Effect.gen(function* () {
            return roomWork({
                approvals: yield* LegacyApprovals,
                cycles: yield* LegacyCycles,
                runner: yield* LegacyRunner,
                roomStreams: yield* LegacyRoomStreams,
                steering: (yield* Ports).steering,
            });
        }),
    ),
};
