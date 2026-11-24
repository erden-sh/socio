/**
 * The workspace's layers: they implement `contract.ts`. Only the composition
 * root (`main.ts`, `composition/`) and tests import this file.
 */
import { Effect, Layer } from 'effect';

import { isAdmin } from '@socio/shared/roles';

import { EventReplay } from '../replay/contract.js';
import { Runner } from '../turns/contract.js';

import { chatHistory } from './chat-history.js';
import {
    Audit,
    ChatHistory,
    Conversations,
    Socios,
    People,
    PeopleSync,
    Spaces,
    type SociosShape,
    type PeopleShape,
    type PeopleSyncShape,
    WorkspaceViewSources,
    WorkspaceViews,
} from './contract.js';
import { workspaceViews } from './views.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * `PeopleSync` over the people and the socios: the same five reads the
 * store gave the Board when it built it itself (before the Effect pilot).
 * A `WorkspaceStore` is both, for a platform built on its own.
 */
export function peopleSync(
    source: Pick<PeopleShape, 'users' | 'isDeactivated'> & Pick<SociosShape, 'dot'>,
): PeopleSyncShape {
    return PeopleSync.of({
        userExists: (id) => source.users().some((user) => user.id === id),
        deactivated: (id) => source.isDeactivated(id),
        canManageDependencies: (id) => source.users().some((user) => user.id === id && isAdmin(user)),
        user: (id) => source.users().find((user) => user.id === id),
        dot: (id) => source.dot(id),
    });
}

/**
 * The five slices of the boot step's store (during the migration
 * `WorkspaceStore` implements them): the very objects the
 * store forwards to, so the root's services and the legacy facade share
 * one state, one set of listeners and one connection.
 */
export const WorkspaceLive = (workspace: WorkspaceStore) =>
    Layer.mergeAll(
        Layer.succeed(People, workspace.slices.people),
        Layer.succeed(Spaces, workspace.slices.spaces),
        Layer.succeed(Socios, workspace.slices.socios),
        Layer.succeed(Audit, workspace.slices.audit),
        Layer.succeed(Conversations, workspace.slices.conversations),
    );

/** The Board's synchronous port, over the `People` and `Socios` slices. */
export const PeopleSyncLive = Layer.effect(
    PeopleSync,
    Effect.gen(function* () {
        const people = yield* People;
        const dots = yield* Socios;
        return peopleSync({
            users: () => people.users(),
            isDeactivated: (id) => people.isDeactivated(id),
            dot: (id) => dots.dot(id),
        });
    }),
);

/**
 * `ChatHistory` (CB-136): a chat's history pages over the runner's stored
 * turns, replayed by `EventReplay`.
 */
export const ChatHistoryLive = Layer.effect(
    ChatHistory,
    Effect.gen(function* () {
        return chatHistory(yield* Runner, yield* EventReplay);
    }),
);

/**
 * `WorkspaceViews`: the shell's views over the workspace's own slices and
 * what the composition root offers beyond them (`WorkspaceViewSources`).
 */
export const WorkspaceViewsLive = Layer.effect(
    WorkspaceViews,
    Effect.gen(function* () {
        const dots = yield* Socios;
        const conversations = yield* Conversations;
        const people = yield* People;
        return WorkspaceViews.of(
            workspaceViews(
                {
                    dotsFor: (userId, options) => dots.dotsFor(userId, options),
                    conversations: (userId) => conversations.conversations(userId),
                    archivedConversations: (userId) => conversations.archivedConversations(userId),
                    callsFor: (userId) => conversations.callsFor(userId),
                    preferences: (userId) => people.preferences(userId),
                },
                yield* WorkspaceViewSources,
            ),
        );
    }),
);
