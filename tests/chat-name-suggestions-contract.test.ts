// Chat names' contract: the tags carry their `socio/chat-name-suggestions/*`
// keys, and the repo the composition builds serves the `SuggestionsRepo` tag.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import {
    ChatNames,
    SuggestionsRepo,
    ThreadTitles,
    type ChatNamesShape,
    type ThreadTitlesShape,
} from '../src/server/chat-name-suggestions/contract.js';
import { sqliteChatNameSuggestionRepository } from '../src/server/chat-name-suggestions/repository.js';
import type { ChatNameSuggestions } from '../src/server/chat-name-suggestions/service.js';
import type { ThreadTitler } from '../src/server/chat-name-suggestions/thread-titles.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

it('the tags carry their keys', () => {
    expect(SuggestionsRepo.key).toBe('socio/chat-name-suggestions/SuggestionsRepo');
    expect(ThreadTitles.key).toBe('socio/chat-name-suggestions/ThreadTitles');
    expect(ChatNames.key).toBe('socio/chat-name-suggestions/ChatNames');
});

it('the classes serve the shapes', () => {
    // Compile-time: `implements` on each class; this keeps the assignment checked.
    const shapes = (titler: ThreadTitler, names: ChatNameSuggestions): [ThreadTitlesShape, ChatNamesShape] => [
        titler,
        names,
    ];
    expect(shapes).toBeTypeOf('function');
});

it('the sqlite repo serves SuggestionsRepo', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const layer = Layer.succeed(SuggestionsRepo, sqliteChatNameSuggestionRepository(workspace.db));
    const found = await Effect.runPromise(
        Effect.gen(function* () {
            const repo = yield* SuggestionsRepo;
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
            return repo.pending('t1');
        }).pipe(Effect.provide(layer)),
    );
    expect(found?.suggestedName).toBe('Budget review');
});
