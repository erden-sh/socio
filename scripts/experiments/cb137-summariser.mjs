// CB-137: the chat's running notes written by the chat's own model or by
// the shared model, measured on synthetic long chats.
//
//   node --import tsx scripts/experiments/cb137-summariser.mjs --arm shared --seed 1
//   node --import tsx scripts/experiments/cb137-summariser.mjs --arm chat --seed 1
//
// Each turn of a synthetic thread (synthetic-thread.mjs) goes through the
// app's own `fitContext`, as a Dot turn's first round does, on a simulated
// chat model with a 32k window (`--window`): the chat's rounds get an
// instant canned answer, so the time until a round reaches the model is
// what fitting added. The notes' requests go to your own model
// (local-model.mjs), the only model this calls:
// - arm `shared`: as the app sends them to a shared backend, with its
//   one-shot options (no reasoning) and a 2,200-token cap;
// - arm `chat`: as the app sends them to the chat's own model, here the
//   same local model with reasoning on and a 16,384-token cap, standing in for
//   a slower, larger chat model (the same weights: quality differences are
//   the setting's, not a bigger model's).
// Then 20 questions about the planted facts are asked of the local model
// (no reasoning, the same for both arms) with the notes as the prompt
// would carry them, and scored automatically. Results go to --out as JSON.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { migrate } from '@socio/data/migrate';

import { contextBudget, fixedTokens, messageTokens } from '../../src/server/context/budget.ts';
import { fitContext } from '../../src/server/context/fit.ts';
import { chatSchema, ContextNotes, SUMMARY_PROMPT, notesMessage, trimNotes } from '../../src/server/context/notes.ts';

import { MODEL, NO_THINKING, complete, localModel, percentile, quietLogger, slotted } from './local-model.mjs';
import { QA_SYSTEM, SYSTEM, keptVerbatim, score, syntheticThread } from './synthetic-thread.mjs';

const { values } = parseArgs({
    options: {
        arm: { type: 'string', default: 'shared' },
        seed: { type: 'string', default: '1' },
        turns: { type: 'string', default: '80' },
        window: { type: 'string', default: '32768' },
        out: { type: 'string', default: '/tmp/cb-issues/experiments' },
        // The chat arm's completion cap: reasoning needs room (at 4,096 every
        // summary came back empty, the reasoning having used it all).
        'chat-cap': { type: 'string', default: '16384' },
        // A suffix for the result files (a variant of the summary prompt).
        tag: { type: 'string', default: '' },
    },
});
const arm = values.arm;
if (arm !== 'shared' && arm !== 'chat') {
    throw new Error('--arm shared|chat');
}
const seed = Number(values.seed);
const turnCount = Number(values.turns);
const contextWindow = Number(values.window);
mkdirSync(values.out, { recursive: true });
const name = `cb137-seed${seed}-${arm}${values.tag ? `-${values.tag}` : ''}`;
const dbFile = join(values.out, `${name}.sqlite`);
rmSync(dbFile, { force: true });
const db = new DatabaseSync(dbFile);
migrate(db, [chatSchema]);
const notes = new ContextNotes(db);

const local = localModel();
const localAdapter = slotted(local.adapter());
const CHAT_OPTIONS = { max_completion_tokens: Number(values['chat-cap']) };

/** The simulated chat model: notes' requests to the local model (arm chat), rounds answered at once. */
let arrived = 0;
const chat = {
    name: 'simulated-chat',
    chatStream: async function* (request) {
        if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
            yield* localAdapter.chatStream({
                ...request,
                model: MODEL,
                modelOptions: CHAT_OPTIONS,
            });
            return;
        }
        arrived = performance.now();
        yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
        yield { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' };
        yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Done.' };
        yield { type: 'TEXT_MESSAGE_END', messageId: 'm' };
        yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
    },
};
const summariser = {
    adapter: localAdapter,
    model: MODEL,
    modelOptions: { max_completion_tokens: 2200, ...NO_THINKING },
    capabilities: local.capabilities,
};

const threadId = `thread-${seed}`;
const capabilities = { acceptsImages: false, contextWindow };
const { turns, facts } = syntheticThread(seed, turnCount);
const updates = [];
const compactions = [];
const rounds = [];
const trace = {
    request: () => {},
    compaction: (info) => compactions.push(info),
    notes: (update) => updates.push(update),
};

/** One turn's first round through the app's fitting. */
async function round(messages, turn) {
    const fitted = fitContext(chat, {
        capabilities,
        key: `experiment:${name}`,
        threadId,
        notes,
        emit: () => {},
        trace,
        log: () => {},
        model: arm === 'chat' ? MODEL : 'simulated-chat',
        selection: 'age',
        ...(arm === 'shared' ? { summariser: async () => summariser } : {}),
    });
    const before = updates.length;
    const started = performance.now();
    for await (const chunk of fitted.chatStream({
        model: 'simulated-chat',
        messages,
        systemPrompts: [SYSTEM],
        tools: [],
        modelOptions: CHAT_OPTIONS,
        logger: quietLogger,
    })) {
        void chunk;
    }
    const entry = {
        turn,
        addedMs: arrived - started,
        updates: updates.length - before,
    };
    rounds.push(entry);
    if (entry.updates) {
        console.log(
            `${name}: turn ${turn + 1}, ${entry.updates} notes update(s), +${(entry.addedMs / 1000).toFixed(1)}s`,
        );
    }
}

const history = [];
for (let turn = 0; turn < turns.length; turn++) {
    await round([...history, turns[turn][0]], turn);
    history.push(...turns[turn]);
}
// The question's turn, so the notes are as a question many turns later sees them.
const QUESTION_TURN = {
    role: 'user',
    content: 'A question about our earlier work.',
};
await round([...history, QUESTION_TURN], turns.length);

const stored = notes.get(threadId);
const store = notes.facts(threadId).map((fact) => fact.fact);
const budget = contextBudget(capabilities);
const room = budget.target - fixedTokens([SYSTEM], []);
const allowance = Math.min(Math.floor(room * 0.2), 6_000);
const view = trimNotes(stored, allowance);
const context = notesMessage(view).content;

const answers = [];
for (const fact of facts) {
    const reply = await complete({
        messages: [
            { role: 'system', content: QA_SYSTEM },
            { role: 'user', content: `${context}\n\nQuestion: ${fact.question}` },
        ],
        max_tokens: 200,
        temperature: 0,
        ...NO_THINKING,
    });
    const answer = String(reply.message.content ?? '').trim();
    answers.push({ id: fact.id, answer, score: score(fact, answer) });
}

const folding = rounds.filter((entry) => entry.updates > 0);
const byModel = updates.filter((update) => update.fallback !== 'cap');
const sum = (key) => byModel.reduce((total, u) => total + (u[key] ?? 0), 0);
const results = {
    name,
    arm,
    seed,
    turns: turnCount,
    window: contextWindow,
    model: MODEL,
    method:
        arm === 'chat'
            ? `local model, reasoning on, ${CHAT_OPTIONS.max_completion_tokens}-token cap (stands in for the chat model)`
            : 'local model, no reasoning, 2,200-token cap (the shared backend with one-shot options)',
    latency: {
        foldingRounds: folding.length,
        p50Ms: percentile(
            folding.map((entry) => entry.addedMs),
            0.5,
        ),
        p95Ms: percentile(
            folding.map((entry) => entry.addedMs),
            0.95,
        ),
        otherRoundsP50Ms: percentile(
            rounds.filter((entry) => !entry.updates).map((entry) => entry.addedMs),
            0.5,
        ),
    },
    summaries: {
        requests: byModel.length,
        fallbacks: updates.filter((u) => u.fallback).map((u) => u.fallback),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        perRequestMs: percentile(
            byModel.map((u) => u.endedAt - u.startedAt),
            0.5,
        ),
    },
    notes: {
        turns: stored.turns,
        pinned: stored.pinned.length,
        stored: store.length,
        names: stored.names.length,
        promptTokens: messageTokens(notesMessage(view)),
        allowance,
    },
    quality: {
        keptInPinned: facts.filter((fact) => keptVerbatim(fact, stored.pinned)).length,
        keptInPinnedOrNames: facts.filter((fact) => keptVerbatim(fact, [...stored.pinned, ...stored.names])).length,
        keptInStore: facts.filter((fact) => keptVerbatim(fact, store)).length,
        keptInPrompt: facts.filter((fact) => keptVerbatim(fact, [context])).length,
        right: answers.filter((a) => a.score === 'right').length,
        wrong: answers.filter((a) => a.score === 'wrong').length,
        unknown: answers.filter((a) => a.score === 'unknown').length,
    },
    answers,
    rounds,
    updates,
};
writeFileSync(join(values.out, `${name}.json`), JSON.stringify(results, null, 2));
db.close();
console.log(
    JSON.stringify(
        {
            name,
            latency: results.latency,
            summaries: results.summaries,
            notes: results.notes,
            quality: results.quality,
        },
        null,
        2,
    ),
);
