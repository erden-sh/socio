/**
 * Runs' layers: they implement `contract.ts`. Only the composition root and
 * tests import this file.
 *
 * - `RunRefs`: what grounded each turn, written on the runner's connection
 *   (`infra/sqlite/run-refs.ts`). Nothing to build.
 * - `RunsViews`: the run views (`views.ts`) over the runner's turns
 *   (`Runner`), the workspace's slices (`People`, `Socios`,
 *   `Conversations`), the rooms' access rule (`Access`) and a run's source,
 *   which the composition provides (`RunsHost`: `RunSource`).
 *
 * Nothing is started and nothing is read here: Runs has no lifecycle.
 */
import { Context, Effect, Layer } from 'effect';

import type { AgentRunSource } from '@socio/shared/types';

import { Access } from '../rooms/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import { RunRefs, RunsViews } from './contract.js';
import { sqliteRunRefs } from './infra/sqlite/run-refs.js';
import { runsViews } from './views.js';

/** What the run views ask of the platform: a run's source. */
export interface RunsHostShape {
    /**
     * A run's source as recorded by its server-side caller; browser and
     * Telegram runs take the conversation's channel (`RunSource`).
     */
    readonly runSource: (threadId: string, recorded?: AgentRunSource | null) => Promise<AgentRunSource>;
}

export class RunsHost extends Context.Service<RunsHost, RunsHostShape>()('socio/runs/RunsHost') {}

/** `RunRefs` over the runner's connection, as the runner hands it in. */
export const RunRefsLive = Layer.succeed(RunRefs, sqliteRunRefs);

/** The run views, over the tags of what they read. */
export const RunsViewsLive = Layer.effect(
    RunsViews,
    Effect.gen(function* () {
        const conversations = yield* Conversations;
        const people = yield* People;
        const socios = yield* Socios;
        const roomAccess = yield* Access;
        const { runSource } = yield* RunsHost;
        return RunsViews.of(
            runsViews({
                runner: yield* Runner,
                runSource: (threadId, recorded) => runSource(threadId, recorded),
                workspace: {
                    allows: (userId, id, action, check) => conversations.allows(userId, id, action, check),
                    archivedConversations: (userId) => conversations.archivedConversations(userId),
                    conversations: (userId) => conversations.conversations(userId),
                    deletedThreadIds: () => conversations.deletedThreadIds(),
                    readableThread: (userId, id, check) => conversations.readableThread(userId, id, check),
                    thread: (id) => conversations.thread(id),
                    users: () => people.users(),
                    dots: () => socios.dots(),
                    roomAccess,
                },
            }),
        );
    }),
);

/** Runs' tags: `RunRefs` and `RunsViews`. */
export const RunsLive = Layer.mergeAll(RunRefsLive, RunsViewsLive);
