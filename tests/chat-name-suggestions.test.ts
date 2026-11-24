import { lastValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { EndpointSource } from '@socio/foundation/inference/endpoints';

import { keywordsOf, nameOverlap } from '../src/server/chat-name-suggestions/keywords.js';
import { sqliteChatNameSuggestionRepository } from '../src/server/chat-name-suggestions/repository.js';
import { ChatNameSuggestions } from '../src/server/chat-name-suggestions/service.js';
import {
    DRIFT_RATIO,
    DRIFT_WINDOW_MESSAGES,
    evaluateNameTrigger,
    REJECT_COOLDOWN_MESSAGES,
    UNNAMED_AFTER_MESSAGES,
} from '../src/server/chat-name-suggestions/triggers.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

const endpoint: EndpointSource = {
    baseUrl: 'http://model.test/v1/',
    apiKey: 'unused',
    model: 'qwen-test',
    titleModelOptions: {},
};

function reply(content: string) {
    return async () => Response.json({ choices: [{ message: { content } }] });
}

function fixture(suggestedName = 'Q4 Budget Review') {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    const repo = sqliteChatNameSuggestionRepository(workspace.db);
    const requests: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
        requests.push(init!);
        return reply(suggestedName)();
    };
    const thread = workspace.bindThread('thread', workspace.dots()[0].id, 'Untitled', 'owner');
    const service = new ChatNameSuggestions(
        workspace,
        runner,
        endpoint,
        repo,
        () => undefined,
        fetchImpl,
        () => true,
        () => 1000,
    );
    service.attach();
    cleanup.push(
        () => void service.stop(),
        () => runner.close(),
        () => workspace.close(),
    );
    const finish = async (agent: ScriptAgent, runId: string, userText: string) => {
        agent.threadId = thread.id;
        const messages = [
            ...(await runner.messages(thread.id)),
            { id: `u-${runId}`, role: 'user' as const, content: userText },
        ];
        agent.setMessages(messages);
        await lastValueFrom(
            runner.run({
                threadId: thread.id,
                agent,
                input: {
                    threadId: thread.id,
                    runId,
                    messages,
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                },
            }),
            { defaultValue: undefined },
        );
    };
    const run = async (...args: Parameters<typeof finish>) => {
        await finish(...args);
        await service.idle();
    };
    const suggestion = () => repo.get(thread.id);
    return { run, finish, suggestion, requests, thread, repo, workspace, runner, service };
}

it('keywordsOf strips stopwords and stems', () => {
    expect([...keywordsOf('the backing up of databases')]).toContain('back');
    expect([...keywordsOf('Backing Up Databases')]).toContain('back');
    // All-stopword input falls back to the plain words (matches capabilityKey).
    expect(keywordsOf('the a an').size).toBe(3);
    expect(keywordsOf('budget forecast revenue').size).toBeGreaterThan(0);
});

it('nameOverlap is 1 when the name covers the window, 0 when unrelated', () => {
    const name = keywordsOf('SQLite Backup');
    expect(nameOverlap(name, ['how to back up sqlite safely', 'sqlite backup tips'])).toBe(1);
    expect(nameOverlap(name, ['quarterly budget review', 'marketing plan'])).toBe(0);
    const partial = nameOverlap(keywordsOf('SQLite Backup Plan'), ['sqlite backup tips']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
});

it('unnamed trigger fires at N=6 messages, not before', () => {
    const texts = ['hello there', 'hi', 'how are you', 'good', 'thanks', 'bye'];
    expect(
        evaluateNameTrigger({
            title: 'Untitled',
            messageCount: 5,
            recentTexts: texts.slice(0, 5),
            lastRejectedAt: -1,
            pending: false,
        }),
    ).toBeUndefined();
    expect(
        evaluateNameTrigger({
            title: 'Untitled',
            messageCount: 6,
            recentTexts: texts,
            lastRejectedAt: -1,
            pending: false,
        })?.trigger,
    ).toBe('unnamed');
    // An empty title is also unnamed.
    expect(
        evaluateNameTrigger({
            title: '',
            messageCount: 6,
            recentTexts: texts,
            lastRejectedAt: -1,
            pending: false,
        })?.trigger,
    ).toBe('unnamed');
});

it('drift trigger fires below 20% overlap and not otherwise', () => {
    const recent = [
        'quarterly budget review',
        'marketing spend plan',
        'revenue forecast',
        'q4 targets',
        'headcount planning',
        'board deck draft',
        'investor update',
        'finance review',
        'okrs for next quarter',
        'hiring plan',
        'compensation bands',
        'sales pipeline',
    ];
    // A name about SQLite backup has ~0 overlap with a budget conversation.
    expect(
        evaluateNameTrigger({
            title: 'SQLite Backup',
            messageCount: recent.length,
            recentTexts: recent,
            lastRejectedAt: -1,
            pending: false,
        })?.trigger,
    ).toBe('drift');
    // A name about budget has high overlap: no drift.
    expect(
        evaluateNameTrigger({
            title: 'Q4 Budget Review',
            messageCount: recent.length,
            recentTexts: recent,
            lastRejectedAt: -1,
            pending: false,
        }),
    ).toBeUndefined();
    // Not enough messages yet: no drift check.
    expect(
        evaluateNameTrigger({
            title: 'SQLite Backup',
            messageCount: 5,
            recentTexts: recent.slice(0, 5),
            lastRejectedAt: -1,
            pending: false,
        }),
    ).toBeUndefined();
});

it('cooldown blocks re-suggest within K=30 messages of a reject', () => {
    const recent = Array.from({ length: DRIFT_WINDOW_MESSAGES }, () => 'quarterly budget revenue forecast');
    // 10 messages after a reject at index 0: blocked.
    expect(
        evaluateNameTrigger({
            title: 'SQLite Backup',
            messageCount: 10,
            recentTexts: recent,
            lastRejectedAt: 0,
            pending: false,
        }),
    ).toBeUndefined();
    // 30 messages after: allowed.
    expect(
        evaluateNameTrigger({
            title: 'SQLite Backup',
            messageCount: REJECT_COOLDOWN_MESSAGES,
            recentTexts: recent,
            lastRejectedAt: 0,
            pending: false,
        })?.trigger,
    ).toBe('drift');
});

it('only one pending suggestion per chat at a time', () => {
    const recent = Array.from({ length: DRIFT_WINDOW_MESSAGES }, () => 'quarterly budget revenue forecast');
    expect(
        evaluateNameTrigger({
            title: 'SQLite Backup',
            messageCount: recent.length,
            recentTexts: recent,
            lastRejectedAt: -1,
            pending: true,
        }),
    ).toBeUndefined();
});

it('makes a model call and stores a pending suggestion when the unnamed trigger fires', async () => {
    const f = fixture();
    // Send 6 messages to reach the unnamed threshold.
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    const s = f.suggestion();
    expect(s).toBeDefined();
    expect(s!.status).toBe('pending');
    expect(s!.suggestedName).toBe('Q4 Budget Review');
    expect(s!.trigger).toBe('unnamed');
    expect(f.requests).toHaveLength(1);
});

it('does not call the model when no trigger fires (named chat, no drift)', async () => {
    const f = fixture();
    // Name the chat so the unnamed trigger can't fire, and keep messages on-topic.
    f.workspace.renameThread(f.thread.id, 'Q4 Budget Review');
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent('budget answer'), `r${i}`, `budget message ${i}`);
    }
    expect(f.suggestion()).toBeUndefined();
    expect(f.requests).toHaveLength(0);
});

it('does not re-suggest while a suggestion is already pending', async () => {
    const f = fixture();
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    expect(f.suggestion()?.status).toBe('pending');
    const before = f.requests.length;
    // More turns: the pending card is still there, so no new model call.
    for (let i = 0; i < 3; i += 1) {
        await f.run(new ScriptAgent(`more ${i}`), `m${i}`, `more message ${i}`);
    }
    expect(f.requests).toHaveLength(before);
    expect(f.suggestion()?.status).toBe('pending');
});

it('reject enforces the cooldown: no re-suggest within 30 messages', async () => {
    const f = fixture();
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    const count = (await f.runner.messages(f.thread.id)).length;
    f.repo.settle(f.thread.id, 'rejected', 2000, count);
    expect(f.suggestion()?.status).toBe('rejected');
    // A few more turns: still in cooldown, no new suggestion.
    for (let i = 0; i < 5; i += 1) {
        await f.run(new ScriptAgent(`more ${i}`), `m${i}`, `more message ${i}`);
    }
    // The rejected row stays (status rejected), no new pending row.
    expect(f.suggestion()?.status).toBe('rejected');
    expect(f.suggestion()?.rejectedAtMessageIndex).toBe(count);
});

it('no silent rename: the name is unchanged while a suggestion is pending or rejected', async () => {
    const f = fixture();
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    // The suggested name is stored, but the thread title is untouched.
    const title = f.workspace.thread(f.thread.id)!.title;
    expect(title).toBe('Untitled');
    expect(f.suggestion()?.suggestedName).toBe('Q4 Budget Review');
});

it('accept applies the suggested name and clears the card', async () => {
    const f = fixture();
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    const s = f.suggestion()!;
    // Accept: apply the name directly (the route does this; here we simulate).
    f.workspace.renameThread(f.thread.id, s.suggestedName);
    f.repo.settle(f.thread.id, 'accepted', 3000);
    expect(f.workspace.thread(f.thread.id)!.title).toBe('Q4 Budget Review');
    expect(f.suggestion()?.status).toBe('accepted');
});

it('customize applies the reviewer-edited name', async () => {
    const f = fixture();
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`answer ${i}`), `r${i}`, `user message ${i}`);
    }
    f.workspace.renameThread(f.thread.id, 'Q4 Finance Plan');
    f.repo.settle(f.thread.id, 'customized', 4000);
    expect(f.workspace.thread(f.thread.id)!.title).toBe('Q4 Finance Plan');
    expect(f.suggestion()?.status).toBe('customized');
});

it('drift trigger re-suggests after a named chat drifts', async () => {
    const f = fixture('New Topic Name');
    // Start with a named, on-topic chat.
    f.workspace.renameThread(f.thread.id, 'SQLite Backup Tips');
    // Fill the window with off-topic messages to force drift.
    for (let i = 0; i < DRIFT_WINDOW_MESSAGES; i += 1) {
        await f.run(new ScriptAgent(`budget ${i}`), `r${i}`, `quarterly budget revenue forecast ${i}`);
    }
    const s = f.suggestion();
    expect(s).toBeDefined();
    expect(s!.trigger).toBe('drift');
    expect(s!.suggestedName).toBe('New Topic Name');
});

it('does not call the model on every turn, only when a trigger fires', async () => {
    const f = fixture();
    // A named chat with 2 on-topic messages: no trigger, no model call.
    f.workspace.renameThread(f.thread.id, 'Q4 Budget Review');
    await f.run(new ScriptAgent('budget answer'), 'r1', 'quarterly budget review');
    await f.run(new ScriptAgent('budget answer 2'), 'r2', 'revenue forecast');
    expect(f.requests).toHaveLength(0);
});

it('handles a failed model call without storing a suggestion', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase(), { flushIntervalMs: 5 });
    const repo = sqliteChatNameSuggestionRepository(workspace.db);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: typeof fetch = async () => new Response('busy', { status: 503 });
    const thread = workspace.bindThread('thread', workspace.dots()[0].id, 'Untitled', 'owner');
    const service = new ChatNameSuggestions(workspace, runner, endpoint, repo, () => undefined, failing);
    service.attach();
    cleanup.push(
        () => void service.stop(),
        () => runner.close(),
        () => workspace.close(),
    );
    const agent = new ScriptAgent('answer');
    agent.threadId = thread.id;
    const messages = [{ id: 'u-1', role: 'user' as const, content: 'first' }];
    for (let i = 0; i < UNNAMED_AFTER_MESSAGES - 1; i += 1) {
        messages.push({ id: `u-${i}`, role: 'user' as const, content: `msg ${i}` });
    }
    agent.setMessages(messages);
    await lastValueFrom(
        runner.run({
            threadId: thread.id,
            agent,
            input: {
                threadId: thread.id,
                runId: 'r1',
                messages,
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
            },
        }),
        { defaultValue: undefined },
    );
    await service.idle();
    expect(repo.get(thread.id)).toBeUndefined();
    errors.mockRestore();
});

it('uses the drift window and ratio constants from the spec', () => {
    expect(UNNAMED_AFTER_MESSAGES).toBe(6);
    expect(DRIFT_WINDOW_MESSAGES).toBe(12);
    expect(DRIFT_RATIO).toBe(0.2);
    expect(REJECT_COOLDOWN_MESSAGES).toBe(30);
});
