/**
 * Chat titles' and name suggestions' construction:
 * `chat-name-suggestions/layer.ts` builds the services over the contracts'
 * tags; this file adds the tags the other steps read them from.
 *
 * No config tag: chat names read no `PlatformConfig` field (the
 * suggestions' switch is Settings' `chatNameSuggestions`).
 */
import { Context, Effect, Layer } from 'effect';

import { ChatNames, ThreadTitles } from '../chat-name-suggestions/contract.js';
import { makeChatNames, makeThreadTitles, SuggestionsRepoLive } from '../chat-name-suggestions/layer.js';
import type { ChatNameSuggestions } from '../chat-name-suggestions/service.js';
import type { ThreadTitler } from '../chat-name-suggestions/thread-titles.js';

import { LegacyWorkspace } from './base.js';

/** The thread titler, under the graph's `LegacyThreadTitles` tag. */
export class LegacyThreadTitles extends Context.Service<LegacyThreadTitles, ThreadTitler>()(
    'socio/composition/chat-name-suggestions/ThreadTitler',
) {}

/** The name suggestions, under the graph's `LegacyChatNames` tag. */
export class LegacyChatNames extends Context.Service<LegacyChatNames, ChatNameSuggestions>()(
    'socio/composition/chat-name-suggestions/ChatNameSuggestions',
) {}

/**
 * Chat names' steps of the graph, in the graph's order: the titler
 * (offered as `ThreadTitles`), the suggestions' store (`SuggestionsRepo`),
 * then the suggestions (`ChatNames`). Each of the two attaches to the
 * runner as it is built, titles first; `LeaderWork.stop` stops them in the
 * same order.
 */
export const chatNameSuggestionsLayers = {
    titles: Layer.effectContext(
        Effect.gen(function* () {
            const titles = yield* makeThreadTitles;
            return Context.make(LegacyThreadTitles, titles).pipe(Context.add(ThreadTitles, titles));
        }),
    ),
    repo: Layer.unwrap(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            return SuggestionsRepoLive(db);
        }),
    ),
    chatNames: Layer.effectContext(
        Effect.gen(function* () {
            const chatNames = yield* makeChatNames;
            return Context.make(LegacyChatNames, chatNames).pipe(Context.add(ChatNames, chatNames));
        }),
    ),
};
