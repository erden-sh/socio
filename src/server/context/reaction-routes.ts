import { Hono, type Context } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import { messageText } from '@socio/foundation/turns/media-parts';
import { REACTION_MESSAGE_ID, isReactionKind, type ReactionsView } from '@socio/shared/chat/reactions';
import { ROOM_DENIAL_MESSAGES } from '@socio/shared/rooms/rooms';
import { TraceTimes } from '@socio/shared/runs/trace-times';

import type { EventReplayShape } from '../replay/contract.js';
import type { RunnerShape } from '../turns/contract.js';

import type { DotRepliesShape } from './contract.js';
import { messageReactions } from './reactions.js';
import type { ReactionRouteSources } from './sources.js';

/**
 * Reactions on a Dot's messages (CB-133), for whoever may read the
 * conversation: its owner, a team topic's members, and a room's active
 * members (CB-208), who react while they may send there (Rooms on, the
 * room unarchived). Anyone else gets "not found", as for the
 * conversation itself. `replay` rebuilds the stored replies (replay's
 * `EventReplay`).
 */
export function reactionRoutes(platform: ReactionRouteSources, replay: Pick<EventReplayShape, 'messages'>) {
    const app = new Hono<AppEnv>();
    const store = messageReactions(platform.workspace.db);
    const readable = (userId: string, id: string) => platform.workspace.readableThread(userId, id);
    const view = (thread: { id: string; team?: boolean; kind?: string }, userId: string): ReactionsView => ({
        shared: !!thread.team || thread.kind === 'room',
        messages: store.view(thread.id, userId),
    });
    const missing = (what: string) => ({ error: `${what} not found.` });

    // Polled by the chat: 304 when nothing changed (conditional.ts).
    app.get('/conversations/:id/reactions', async (c) => {
        const thread = await readable(c.get('user').id, c.req.param('id'));
        if (!thread) {
            return c.json(missing('Conversation'), 404);
        }
        return conditionalJson(c, () => view(thread, c.get('user').id));
    });

    const react = (add: boolean) => async (c: Context<AppEnv>) => {
        const userId = c.get('user').id;
        const thread = await readable(userId, c.req.param('id') ?? '');
        if (!thread) {
            return c.json(missing('Conversation'), 404);
        }
        if (thread.kind === 'room') {
            const { decision } = platform.workspace.access(userId, thread.id, 'send');
            if (!decision.allowed) {
                return c.json(
                    {
                        error: ROOM_DENIAL_MESSAGES[decision.reason],
                        code: decision.reason,
                    },
                    409,
                );
            }
        }
        const kind = c.req.param('kind');
        if (!isReactionKind(kind)) {
            return c.json({ error: 'React with up, down, retry or needs-work.' }, 400);
        }
        const messageId = c.req.param('messageId') ?? '';
        if (!REACTION_MESSAGE_ID.test(messageId)) {
            return c.json(missing('Message'), 404);
        }
        if (add) {
            // Only a Dot's stored reply can be reacted to.
            const message = await dotMessage(platform.runner, replay, thread.id, messageId);
            if (!message) {
                return c.json(missing('Message'), 404);
            }
            store.add(thread.id, messageId, userId, kind, message);
        } else {
            store.remove(thread.id, messageId, userId, kind);
        }
        return c.json(view(thread, userId));
    };
    app.put('/conversations/:id/messages/:messageId/reactions/:kind', react(true));
    app.delete('/conversations/:id/messages/:messageId/reactions/:kind', react(false));
    return app;
}

/**
 * The stored reply from the Dot with this id, with its time and text: the
 * only kind of message a reaction is for (here, and in Telegram, CB-145).
 */
export async function dotMessage(
    runner: Pick<RunnerShape, 'rowsMentioning'>,
    replay: Pick<EventReplayShape, 'messages'>,
    threadId: string,
    id: string,
) {
    for (const row of runner.rowsMentioning(threadId, id)) {
        const found = (await replay.messages(threadId, row.events)).find(
            (message) => message.id === id && message.role === 'assistant',
        );
        const text = found ? messageText(found.content) : '';
        if (text.trim()) {
            return { text, at: new TraceTimes(row.events).messages.get(id) };
        }
    }
    return undefined;
}

/** `dotMessage` over `runner` and `replay`, as the `DotReplies` tag serves it. */
export const dotReplies = (
    runner: Pick<RunnerShape, 'rowsMentioning'>,
    replay: Pick<EventReplayShape, 'messages'>,
): DotRepliesShape => ({
    find: (threadId, id) => dotMessage(runner, replay, threadId, id),
});
