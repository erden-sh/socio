/**
 * Conversations and socios (`ConversationAdmin`): `create`, `delete`,
 * `deletion`, `archiveDot`, `forgetDot` and `history`, the composition's own
 * code, read through the tag.
 *
 * The step is placed in the graph (`composition/index.ts`) after every
 * service it reads (`liveLayers.counters`). It reads only the root's stores
 * and runner and the data spaces, all built before it, and registers no
 * listener, so it changes no order.
 *
 * A run's source (`runSourceOf`) and a conversation's history
 * (`historyOf`) need no step: each reads only the root's objects, so a
 * step built before this one (`AppTurns`) may use them.
 */
import { randomUUID } from 'node:crypto';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';
import { deletedWith } from '@socio/data/soft-delete';
import { messageText } from '@socio/foundation/turns/media-parts';
import type { ModelChoice } from '@socio/shared/inference';
import type { AgentRunSource, ConversationDeletion, DeleteBlocker } from '@socio/shared/types';

import type { DataSpace } from '../../dataspace/space.js';
import type { LocalAgentRunner } from '../../turns/local-runner.js';
import { DELETE_BLOCKED } from '../../workspace/contract.js';
import { LegacyRunner, LegacyStore, LegacyWorkspace } from '../base.js';
import type { CoreStore } from '../core-store.js';
import { LegacyData } from '../dataspace.js';
import type { AppWorkspace } from '../workspace-parts.js';

/** Why a Dot's schedules paused: shown on each (Schedules & jobs). */
export const DOT_ARCHIVED_SCHEDULE = 'Paused: its socio was archived.';

/**
 * A run's source as recorded by its server-side caller. Browser and
 * Telegram runs (and runs stored before sources were recorded) take the
 * conversation's channel.
 */
export const runSourceOf =
    (workspace: { readonly telegram: Pick<AppWorkspace['telegram'], 'threadInfo'> }) =>
    async (threadId: string, recorded?: AgentRunSource | null): Promise<AgentRunSource> =>
        recorded ?? ((await workspace.telegram.threadInfo(threadId)) ? 'telegram' : 'web');

/**
 * A conversation's last messages, as plain text (`history`): pure over the
 * workspace and the runner, so `AppTurns` (built before this step) and
 * `ConversationAdmin` share one implementation.
 */
export const historyOf =
    (deps: {
        readonly workspace: Pick<AppWorkspace, 'requireThread'>;
        readonly runner: Pick<LocalAgentRunner, 'messages'>;
    }) =>
    async (threadId: string): Promise<string> => {
        deps.workspace.requireThread(threadId);
        const messages = await deps.runner.messages(threadId);
        return messages
            .filter((message) => ['user', 'assistant'].includes(message.role))
            .slice(-12)
            .map((message) => `${message.role}: ${messageText(message.content)}`)
            .join('\n')
            .slice(-12000);
    };

/** The composition's conversations and socios code (`createConversation`, ...), behind `ConversationAdmin`. */
export interface ConversationAdminShape {
    /** A new web conversation with the socio, for `userId` (`createConversation`). */
    create(
        dotId: string,
        title: string,
        userId: string,
        inference?: ModelChoice | null,
    ): Promise<ReturnType<AppWorkspace['bindThread']>>;
    /** Deletes one of the user's web conversations (`deleteConversation`). */
    delete(id: string, userId: string, now?: number): Promise<void>;
    /** What deleting one would take with it, and what stops it now. */
    deletion(id: string, userId: string): Promise<ConversationDeletion>;
    /** Archives a socio, pausing its schedules and goals. */
    archiveDot(id: string, actor: string): Promise<ReturnType<AppWorkspace['archiveDot']>>;
    /** After a socio is deleted: what of it the data spaces keep or drop. */
    forgetDot(dotId: string): ReturnType<DataSpace['forgetDot']>;
    /** The conversation's last messages, as plain text. */
    history(threadId: string): Promise<string>;
}

/** Conversations and socios, as the edge and the graph's steps call them. */
export class ConversationAdmin extends Context.Service<ConversationAdmin, ConversationAdminShape>()(
    'socio/composition/app/ConversationAdmin',
) {}

/** What the conversations' code reads: the root's stores and runner, and the data spaces. */
export interface ConversationAdminDeps {
    readonly store: CoreStore;
    readonly workspace: AppWorkspace;
    readonly runner: LocalAgentRunner;
    readonly data: DataSpace;
}

/** The conversations and socios over `deps`, read at the moment of use. */
export function conversationAdmin(deps: ConversationAdminDeps): ConversationAdminShape {
    const { store, workspace, runner, data } = deps;

    const deletionOf = async (id: string, userId: string) => {
        workspace.requireOwnedThread(userId, id);
        const tasks: string[] = [];
        let running = false;
        for (const task of await workspace.threadTasks(id)) {
            const live = await store.scheduled.get(task);
            if (!live) {
                continue;
            }
            tasks.push(task);
            running ||= live.status === 'running';
        }
        const blocked: DeleteBlocker | undefined =
            runner.activeRunId(id) || running ? 'running' : await workspace.deleteBlocker(id);
        return { tasks, blocked };
    };

    return {
        async create(dotId, title, userId, inference = null) {
            if (!workspace.dot(dotId)) {
                throw new Error('Socio not found.');
            }
            return workspace.bindThread(randomUUID(), dotId, title, userId, inference);
        },
        /**
         * Deletes one of the user's web conversations with the scheduled
         * tasks bound to it (CB-64: hides them; the history, calls and tasks
         * are kept for the admin view). Nothing may be running in it.
         */
        async delete(id, userId, now = Date.now()) {
            const { tasks, blocked } = await deletionOf(id, userId);
            if (blocked) {
                throw new Error(DELETE_BLOCKED[blocked]);
            }
            // Soft delete: the tasks are stamped and the conversation hidden
            // in one unit of work on the shared connection (CB-110): all of it, or
            // none. A task that started running since refuses, and nothing changes.
            const parent = deletedWith('conversation', id);
            await sqliteData(store.connection).uow.run(
                async () => {
                    for (const task of tasks) {
                        if (
                            !(await store.scheduled.deleteTask(task, userId, parent, now)) &&
                            (await store.scheduled.get(task))?.status === 'running'
                        ) {
                            throw new Error(DELETE_BLOCKED.running);
                        }
                    }
                    // Counted from the stamps, so a retry after a failure counts them all.
                    let stamped = 0;
                    for (const task of await workspace.threadTasks(id)) {
                        if ((await store.scheduled.withDeleted(task))?.deletedWith === parent) {
                            stamped++;
                        }
                    }
                    // The workspace's own unit: the same one on the shared connection.
                    await workspace.data.uow.run(
                        async () => {
                            await workspace.deleteThread(id, userId, now);
                            workspace.audit(
                                {
                                    actor: userId,
                                    action: 'delete',
                                    targetKind: 'conversation',
                                    targetId: id,
                                    detail: stamped
                                        ? `with ${stamped} scheduled ${stamped === 1 ? 'task' : 'tasks'}`
                                        : '',
                                },
                                now,
                            );
                        },
                        { label: 'delete conversation' },
                    );
                },
                { label: 'delete conversation' },
            );
        },
        /**
         * What deleting one of the user's conversations would take with it,
         * and what stops it now (CB-66: the chat menu asks before it offers
         * Delete).
         */
        async deletion(id, userId) {
            const { tasks, blocked } = await deletionOf(id, userId);
            return { scheduledTasks: tasks.length, blocked: blocked ?? null };
        },
        /**
         * Archives a Dot (never a delete): it leaves every list, starts no
         * chats or turns, and every schedule and goal of it pauses, with the
         * reason. Its chats, filings, goals and audit stay; unarchiving
         * brings it back with its schedules still paused, for their owners
         * to resume.
         */
        async archiveDot(id, actor) {
            const dot = workspace.archiveDot(id, actor);
            const paused = await store.scheduled.pauseTasks(
                [...(await store.scheduled.dotScheduleIds(id)), ...(await workspace.dotThreadTaskIds(id))],
                DOT_ARCHIVED_SCHEDULE,
            );
            console.log(`Dots: archived dot=${id} schedules paused=${paused}`);
            return dot;
        },
        /**
         * After a Dot is deleted: its scratch datasets stay with each user,
         * marked "from a deleted Dot"; its grants, data tokens, pending
         * approvals and policies go. (The data module also finds deleted
         * Dots on its own.)
         */
        forgetDot(dotId) {
            return data.forgetDot(dotId);
        },
        history: historyOf({ workspace, runner }),
    };
}

/** The step, as `composition/index.ts` places it: `ConversationAdmin`, built once. */
export const appConversationsLayers = {
    step: Layer.effect(
        ConversationAdmin,
        Effect.gen(function* () {
            return conversationAdmin({
                store: yield* LegacyStore,
                workspace: yield* LegacyWorkspace,
                runner: yield* LegacyRunner,
                data: yield* LegacyData,
            });
        }),
    ),
};
