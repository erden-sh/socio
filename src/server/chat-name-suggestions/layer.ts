/**
 * Chat names' layers: the title writer as `ThreadTitles`, the suggestions'
 * store as `SuggestionsRepo` and the name suggestions as `ChatNames`. They read
 * the conversations (`Conversations`), the runner (`Runner`), the default
 * shared backend (`Inference`) and, for the suggestions' switch, the settings
 * (`WorkspaceSettings`), from those features' contracts. Only the composition
 * (`composition/chat-name-suggestions.ts`) and tests import this file.
 *
 * Each of the two services attaches to the runner as it is built, as
 * before; what stops them is still `LeaderWork.stop` (titles, then the
 * suggestions), not this layer's scope.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Inference, type EndpointSource, type InferenceShape } from '../inference/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../settings/contract.js';
import { Runner, type RunnerShape } from '../turns/contract.js';
import { Conversations, type ConversationsShape } from '../workspace/contract.js';

import { ChatNames, SuggestionsRepo, ThreadTitles, type ChatNameSuggestionRepository } from './contract.js';
import { sqliteChatNameSuggestionRepository } from './repository.js';
import { ChatNameSuggestions } from './service.js';
import { ThreadTitler } from './thread-titles.js';

/** Background requests' endpoint: the default shared backend's, looked up per request. */
export const sharedEndpoint =
    (inference: Pick<InferenceShape, 'shared'>): EndpointSource =>
    async () =>
        (await inference.shared())?.chatCompletions;

/** Titles for new chats, attached to the runner. */
export function threadTitler(conversations: ConversationsShape, runner: RunnerShape, endpoint: EndpointSource) {
    const titles = new ThreadTitler(conversations, runner, endpoint);
    titles.attach();
    return titles;
}

/** Whether name suggestions are on (CB-292): off unless an admin turns them on in Settings. */
export const suggestionsOn = (settings: Pick<WorkspaceSettingsShape, 'settings'>) => () =>
    !!settings.settings().chatNameSuggestions;

/**
 * Content-based name suggestions (CB-292): cheap triggers after each turn,
 * a model call only when one fires. One pending card per chat. Attached
 * to the runner.
 */
export function chatNameSuggestions(deps: {
    conversations: ConversationsShape;
    runner: RunnerShape;
    endpoint: EndpointSource;
    repo: ChatNameSuggestionRepository;
    enabled: () => boolean;
}): ChatNameSuggestions {
    const chatNames = new ChatNameSuggestions(
        deps.conversations,
        deps.runner,
        deps.endpoint,
        deps.repo,
        (line) => console.log(line),
        // Default fetch; the service aborts on stop.
        (...args) => fetch(...args),
        deps.enabled,
    );
    chatNames.attach();
    return chatNames;
}

/** The title writer over the tags; attaches it to the runner. */
export const makeThreadTitles = Effect.gen(function* () {
    return threadTitler(yield* Conversations, yield* Runner, sharedEndpoint(yield* Inference));
});

/** The name suggestions over the tags; attaches them to the runner. */
export const makeChatNames = Effect.gen(function* () {
    return chatNameSuggestions({
        conversations: yield* Conversations,
        runner: yield* Runner,
        endpoint: sharedEndpoint(yield* Inference),
        repo: yield* SuggestionsRepo,
        enabled: suggestionsOn(yield* WorkspaceSettings),
    });
});

/** `ThreadTitles`; needs `Conversations`, `Runner` and `Inference`. */
export const ThreadTitlesLive = Layer.effectContext(
    Effect.map(makeThreadTitles, (titles) => Context.make(ThreadTitles, titles)),
);

/** `SuggestionsRepo`, on the workspace's connection. */
export const SuggestionsRepoLive = (db: DatabaseSync) =>
    Layer.sync(SuggestionsRepo, () => sqliteChatNameSuggestionRepository(db));

/**
 * `ChatNames`; needs `Conversations`, `Runner`, `Inference`,
 * `SuggestionsRepo` and `WorkspaceSettings`.
 */
export const ChatNamesLive = Layer.effectContext(
    Effect.map(makeChatNames, (chatNames) => Context.make(ChatNames, chatNames)),
);
