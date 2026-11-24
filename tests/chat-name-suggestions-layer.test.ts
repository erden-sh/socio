// Chat names' layers: built over the contracts' tags, the title writer and the
// suggestions attach to the runner as they are built (titles first), the
// suggestions read their store through `SuggestionsRepo`, and their switch and
// endpoint are read at the moment of use.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { ChatNames, SuggestionsRepo, ThreadTitles } from '../src/server/chat-name-suggestions/contract.js';
import {
    ChatNamesLive,
    sharedEndpoint,
    suggestionsOn,
    SuggestionsRepoLive,
    ThreadTitlesLive,
} from '../src/server/chat-name-suggestions/layer.js';
import { ChatNameSuggestions } from '../src/server/chat-name-suggestions/service.js';
import { ThreadTitler } from '../src/server/chat-name-suggestions/thread-titles.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { Runner, type RunFinishedListener, type RunnerShape } from '../src/server/turns/contract.js';
import { Conversations, type ConversationsShape } from '../src/server/workspace/contract.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const endpoint = { baseUrl: 'http://model.test/v1', model: 'm' };

function stubs(settings: { chatNameSuggestions?: boolean }) {
    const listeners: RunFinishedListener[] = [];
    const runner = { onRunFinished: (listener: RunFinishedListener) => void listeners.push(listener) };
    const layer = Layer.mergeAll(
        Layer.succeed(Conversations, {} as ConversationsShape),
        Layer.succeed(Runner, runner as unknown as RunnerShape),
        Layer.succeed(Inference, {
            shared: async () => ({ chatCompletions: endpoint }),
        } as unknown as InferenceShape),
        Layer.succeed(WorkspaceSettings, { settings: () => settings } as unknown as WorkspaceSettingsShape),
    );
    return { listeners, layer };
}

it('builds the services over the tags, each attached to the runner, titles first', async () => {
    const db = testDatabase();
    cleanup.push(() => db.close());
    const { listeners, layer } = stubs({});
    const graph = ChatNamesLive.pipe(
        Layer.provideMerge(SuggestionsRepoLive(db)),
        Layer.provideMerge(ThreadTitlesLive),
        Layer.provideMerge(layer),
    );
    const { titles, chatNames, repo } = await Effect.runPromise(
        Effect.gen(function* () {
            return { titles: yield* ThreadTitles, chatNames: yield* ChatNames, repo: yield* SuggestionsRepo };
        }).pipe(Effect.provide(graph)),
    );
    cleanup.push(
        () => titles.stop(),
        () => chatNames.stop(),
    );
    expect(titles).toBeInstanceOf(ThreadTitler);
    expect(chatNames).toBeInstanceOf(ChatNameSuggestions);
    expect(listeners).toHaveLength(2);
    expect(String(listeners[0])).toContain('this.onRun(threadId, status)');
    expect(String(listeners[1])).toContain('void this.onRun(threadId, status)');
    repo.insert({
        threadId: 't1',
        suggestedName: 'Budget review',
        trigger: 'unnamed',
        status: 'pending',
        suggestedAtMessageIndex: 6,
        rejectedAtMessageIndex: -1,
        createdAt: 1,
        settledAt: null,
    });
    expect(chatNames.suggestion('t1')?.suggestedName).toBe('Budget review');
});

it('reads the switch and the shared backend at the moment of use', async () => {
    const settings: { chatNameSuggestions?: boolean } = {};
    const enabled = suggestionsOn({ settings: () => settings as never });
    expect(enabled()).toBe(false);
    settings.chatNameSuggestions = true;
    expect(enabled()).toBe(true);

    let shared: { chatCompletions: typeof endpoint } | undefined;
    const source = sharedEndpoint({ shared: async () => shared as never });
    expect(typeof source).toBe('function');
    expect(await (source as () => Promise<unknown>)()).toBeUndefined();
    shared = { chatCompletions: endpoint };
    expect(await (source as () => Promise<unknown>)()).toBe(endpoint);
});
