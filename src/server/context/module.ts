import { withPrivateResultsWithheld, withToolActors } from '@socio/foundation/context/room-context';
import { contextSettings } from '@socio/foundation/context/settings';

import type { ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import { formatChartTool } from './chart.js';
import { ContextConfig, SharedChats } from './contract.js';
import { chatSchema, contextNotes } from './notes.js';
import { roomPins, roomPinsNote } from './pins.js';
import { messageReactions, reactionNews } from './reactions.js';
import { recallTool } from './recall.js';
import { searchNotesTool } from './search-notes.js';

/**
 * Chat: long conversations that never outgrow their model (CB-129). Each
 * thread's running notes (the `chat_context_notes` table; `fit.ts` keeps
 * them) and the `recall` tool, which reads what compaction set aside from
 * the stored conversation. Reactions on a Dot's messages (CB-133) are
 * stored here too; their routes sit with the conversations' and the Dot is
 * told of new ones on its next turn (`dotTurnNote`).
 *
 * Its tools read the runner's stored conversation (`Runner`), whether the
 * chat is shared (`SharedChats`, memory's `TurnMemory` by the slice they
 * call) and the context's configuration
 * (`ContextConfig`) from the app's services, and the workspace and store
 * from `ModuleContext`, at the moment of use.
 */
export const chatModule: ServerModule = {
    ...chatSchema,
    paths: [],
    dotTools: ({ db, services }, turn) => {
        const runner = services.get(Runner);
        const memory = services.get(SharedChats);
        // In a chat with other people in it (CB-210), what the turn reads back
        // is what its prompt may hold: other people's tool results withheld,
        // and notes written for everyone only.
        const shared = () => memory.sharedChat(turn.threadId, turn.userId);
        return [
            formatChartTool(turn),
            recallTool(turn, async (threadId) => {
                const messages = await runner.messages(threadId);
                return (await shared())
                    ? withPrivateResultsWithheld(withToolActors(messages, runner.toolActors(threadId)), turn.userId)
                    : messages;
            }),
            // Only where prompts carry a core of the notes and a pointer (CB-134).
            ...(contextSettings(services.get(WorkspaceSettings).settings(), services.get(ContextConfig).context)
                .selection === 'pointer'
                ? [searchNotesTool(turn, contextNotes(db), shared)]
                : []),
        ];
    },
    // Per-turn content: placed with the person's newest message, not in the
    // system prompt or with the stable notes at the prompt's start, so that
    // start can stay cached from turn to turn (CB-139).
    // The chats, socios and people are the workspace's `Conversations`,
    // `Socios` and `People`, on the modules' connection.
    dotTurnNote: ({ db, services }, turn) => {
        const conversations = services.get(Conversations);
        const socios = services.get(Socios);
        const people = services.get(People);
        const workspace = {
            db,
            thread: (id: string) => conversations.thread(id),
            dot: (id: string) => socios.dot(id),
            users: () => people.users(),
            access: (...args: Parameters<typeof conversations.access>) => conversations.access(...args),
        };
        return (
            reactionNews(messageReactions(db), turn, (id) => people.users().find((user) => user.id === id)?.name) +
            // A room's pinned facts, read afresh each turn (CB-217).
            roomPinsNote({ thread: (id) => workspace.thread(id), pins: () => roomPins(workspace) }, turn.threadId)
        );
    },
    capabilities: () => [
        {
            id: 'inline_charts',
            label: 'Inline charts',
            description:
                'Format supplied data as a bar or line chart, with a plain Markdown summary and table. Formatting does not fetch or verify data.',
            tools: ['format_chart'],
            status: () => ({ enabled: true }),
        },
        {
            id: 'recall',
            label: 'Earlier in this chat',
            description:
                'Long conversations are kept within the model’s limits automatically: big tool results are cut to an excerpt, older ones set aside, and the oldest turns kept as notes. Nothing is deleted: recall reads any of it again, by the ref a note names or by searching words.',
            tools: ['recall', 'search_notes'],
            status: () => ({ enabled: true }),
        },
    ],
};
