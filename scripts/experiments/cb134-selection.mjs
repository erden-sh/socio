// CB-134: which pinned facts a long chat's prompt carries, by age (CB-129),
// by relevance (by words, or ranked by the notes' model) or as a pointer to
// `search_notes`, measured on synthetic long chats.
//
//   node --import tsx scripts/experiments/cb134-selection.mjs --seed 1
//
// Starts from the notes and fact store the CB-137 run's shared arm built
// for the same seed (cb137-seed<seed>-shared.sqlite: 80 turns, notes
// written by your own model), so every selection sees the same store.
// For each of the 20 planted facts, the question is the next turn: the
// app's `fitContext` fits it on the simulated 32k chat model as each
// selection says (a copy of the store each time), and your own model
// (local-model.mjs, no reasoning, the only model this calls) answers from
// exactly the prompt the chat model would get, with `recall` over the
// stored thread as every Dot has it, and with `pointer` `search_notes` on
// the copy too, for up to 3 tool rounds. Answers are scored
// automatically; the run records the selection's time, the notes' size,
// and the extra rounds and tokens. Results go to --out as JSON.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { fitContext } from '../../src/server/context/fit.ts';
import { ContextNotes, SUMMARY_PROMPT } from '../../src/server/context/notes.ts';
import { recallTool } from '../../src/server/context/recall.ts';
import { searchNotesTool } from '../../src/server/context/search-notes.ts';

import { MODEL, NO_THINKING, complete, localModel, percentile, quietLogger, slotted } from './local-model.mjs';
import { SYSTEM, score, syntheticThread } from './synthetic-thread.mjs';

const { values } = parseArgs({
    options: {
        seed: { type: 'string', default: '1' },
        turns: { type: 'string', default: '80' },
        window: { type: 'string', default: '32768' },
        out: { type: 'string', default: '/tmp/cb-issues/experiments' },
        only: { type: 'string' },
        limit: { type: 'string', default: '20' },
        // The CB-137 run's tag whose store to start from (a prompt variant).
        tag: { type: 'string', default: '' },
    },
});
const seed = Number(values.seed);
const contextWindow = Number(values.window);
const tag = values.tag ? `-${values.tag}` : '';
const source = join(values.out, `cb137-seed${seed}-shared${tag}.sqlite`);
const scratch = join(values.out, `cb134-seed${seed}${tag}-scratch`);
mkdirSync(scratch, { recursive: true });

const ANSWER_SYSTEM = `${SYSTEM}\nAnswer the person's question about earlier work in one short sentence, giving ids, names, numbers and values exactly as this conversation or its notes write them. When there is a newer value than an older one, give the newer. If you can't find it, answer "not in the notes".`;
const ARMS = [
    { name: 'age', selection: 'age' },
    { name: 'relevance (words)', selection: 'relevance', rankWithModel: false },
    { name: 'relevance (model)', selection: 'relevance', rankWithModel: true },
    { name: 'pointer', selection: 'pointer' },
].filter((arm) => !values.only || arm.name.startsWith(values.only));

const local = localModel();
const localAdapter = slotted(local.adapter());
const summariser = {
    adapter: localAdapter,
    model: MODEL,
    modelOptions: { max_completion_tokens: 2200, ...NO_THINKING },
    capabilities: local.capabilities,
};
const threadId = `thread-${seed}`;
const { turns, facts } = syntheticThread(seed, Number(values.turns));
const history = turns.flat();

/** A model message as Chat Completions takes it. */
function wire(message) {
    if (message.role === 'tool') {
        return {
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: String(message.content ?? ''),
        };
    }
    if (message.role === 'assistant') {
        return {
            role: 'assistant',
            content: message.content ?? '',
            ...(message.toolCalls?.length
                ? {
                      tool_calls: message.toolCalls.map((call) => ({
                          id: call.id,
                          type: 'function',
                          function: call.function,
                      })),
                  }
                : {}),
        };
    }
    return { role: 'user', content: String(message.content ?? '') };
}

const SEARCH_NOTES = {
    type: 'function',
    function: {
        name: 'search_notes',
        description:
            'Search the pinned facts kept from earlier in this conversation (what the person is working on, their goals, decisions and preferences, results) and the names, ids, paths and links it mentioned. Use words from what you need ("report cadence", "dataset for churn"). Returns matching facts word for word, newest last; recall reads the original messages.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
    },
};
const RECALL = {
    type: 'function',
    function: {
        name: 'recall',
        description:
            'Re-read earlier parts of this conversation that were set aside to keep it within the model’s limits. With a ref (from a "call recall with ref …" note, or a search hit), returns that tool result, arguments or message in full, a page at a time (pass offset for the next page). With a query, searches the older messages and tool results by words and returns refs with snippets.',
        parameters: {
            type: 'object',
            properties: {
                ref: { type: 'string' },
                query: { type: 'string' },
                offset: { type: 'integer' },
            },
        },
    },
};
/** The thread as the runner stores it (AG-UI messages), for `recall`. */
const stored = history.map((message, index) =>
    message.role === 'tool'
        ? {
              id: `m${index}`,
              role: 'tool',
              toolCallId: message.toolCallId,
              content: message.content,
          }
        : message.role === 'assistant'
          ? {
                id: `m${index}`,
                role: 'assistant',
                content: message.content ?? '',
                ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
            }
          : { id: `m${index}`, role: 'user', content: message.content },
);

async function ask(arm, fact, index) {
    const file = join(scratch, `${arm.selection}-${index}.sqlite`);
    rmSync(file, { force: true });
    copyFileSync(source, file);
    const db = new DatabaseSync(file);
    const notes = new ContextNotes(db);
    let captured;
    let arrived = 0;
    const compactions = [];
    const notesRequests = [];
    const chat = {
        name: 'simulated-chat',
        chatStream: async function* (request) {
            if (request.systemPrompts?.[0] === SUMMARY_PROMPT) {
                throw new Error('Summaries go to the shared model here.');
            }
            arrived = performance.now();
            captured = request;
            yield { type: 'RUN_STARTED', runId: 'r', threadId: 't' };
            yield { type: 'RUN_FINISHED', runId: 'r', threadId: 't' };
        },
    };
    const fitted = fitContext(chat, {
        capabilities: { acceptsImages: false, contextWindow },
        key: `experiment:cb134:${seed}`,
        threadId,
        notes,
        emit: () => {},
        trace: {
            request: () => notesRequests.push(performance.now()),
            compaction: (info) => compactions.push(info),
            notes: () => {},
        },
        log: () => {},
        model: 'simulated-chat',
        selection: arm.selection,
        rankWithModel: arm.rankWithModel,
        summariser: async () => summariser,
    });
    const started = performance.now();
    for await (const chunk of fitted.chatStream({
        model: 'simulated-chat',
        messages: [...history, { role: 'user', content: fact.question }],
        systemPrompts: [SYSTEM],
        tools: [],
        modelOptions: {},
        logger: quietLogger,
    })) {
        void chunk;
    }
    const fitMs = arrived - started;
    const info = compactions.at(-1) ?? {};

    // Every Dot has recall; with `pointer`, search_notes too.
    const tools = arm.selection === 'pointer' ? [RECALL, SEARCH_NOTES] : [RECALL];
    const search = searchNotesTool({ threadId, check: () => {} }, notes);
    const recall = recallTool({ threadId, check: () => {} }, async () => stored);
    const messages = [{ role: 'system', content: ANSWER_SYSTEM }, ...captured.messages.map(wire)];
    const rounds = [];
    const toolCalls = {};
    let answer = '';
    for (let round = 0; round < 4; round++) {
        const reply = await complete({
            messages,
            tools,
            max_tokens: 300,
            temperature: 0,
            ...NO_THINKING,
        });
        rounds.push({
            ms: reply.ms,
            promptTokens: reply.usage.prompt_tokens,
            completionTokens: reply.usage.completion_tokens,
            cachedTokens: reply.usage.prompt_tokens_details?.cached_tokens ?? 0,
        });
        const calls = reply.message.tool_calls ?? [];
        if (!calls.length || round === 3) {
            answer = String(reply.message.content ?? '').trim();
            break;
        }
        messages.push({
            role: 'assistant',
            content: reply.message.content ?? '',
            tool_calls: calls,
        });
        for (const call of calls) {
            let args = {};
            try {
                args = JSON.parse(call.function?.arguments || '{}');
            } catch {
                // Unreadable arguments: an empty request.
            }
            const name = call.function?.name;
            const output =
                name === 'search_notes'
                    ? await search.execute({
                          query: String(args.query ?? '').slice(0, 300) || fact.question,
                      })
                    : name === 'recall'
                      ? await recall.execute({
                            ...(args.ref ? { ref: String(args.ref).slice(0, 200) } : {}),
                            ...(args.query ? { query: String(args.query).slice(0, 300) } : {}),
                            ...(Number.isInteger(args.offset) ? { offset: args.offset } : {}),
                        })
                      : { error: 'This tool is not available here.' };
            toolCalls[name] ??= 0;
            toolCalls[name] += 1;
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(output),
            });
        }
    }
    db.close();
    rmSync(file, { force: true });
    return {
        id: fact.id,
        answer,
        score: score(fact, answer),
        fitMs,
        selectMs: info.selectMs ?? 0,
        notesTokens: info.notesTokens ?? 0,
        pinnedShown: info.pinnedShown ?? 0,
        pinnedStored: info.pinnedStored ?? 0,
        notesRequests: notesRequests.length,
        toolCalls,
        rounds,
    };
}

const results = { seed, window: contextWindow, model: MODEL, arms: [] };
for (const arm of ARMS) {
    const answers = [];
    for (const [index, fact] of facts.slice(0, Number(values.limit)).entries()) {
        const result = await ask(arm, fact, index);
        answers.push(result);
        console.log(
            `${arm.name}: ${fact.id} ${result.score} (${result.rounds.length} round(s)) ${result.answer.slice(0, 100)}`,
        );
    }
    const extra = answers.flatMap((a) => a.rounds.slice(1));
    const calls = (name) => answers.reduce((sum, a) => sum + (a.toolCalls[name] ?? 0), 0);
    const summary = {
        arm: arm.name,
        right: answers.filter((a) => a.score === 'right').length,
        wrong: answers.filter((a) => a.score === 'wrong').length,
        unknown: answers.filter((a) => a.score === 'unknown').length,
        pinnedShown: percentile(
            answers.map((a) => a.pinnedShown),
            0.5,
        ),
        pinnedStored: percentile(
            answers.map((a) => a.pinnedStored),
            0.5,
        ),
        notesTokens: percentile(
            answers.map((a) => a.notesTokens),
            0.5,
        ),
        selectP50Ms: percentile(
            answers.map((a) => a.selectMs),
            0.5,
        ),
        selectP95Ms: percentile(
            answers.map((a) => a.selectMs),
            0.95,
        ),
        extraRounds: extra.length,
        recallCalls: calls('recall'),
        searchNotesCalls: calls('search_notes'),
        extraRoundMsP50: percentile(
            extra.map((r) => r.ms),
            0.5,
        ),
        extraPromptTokens: extra.reduce((s, r) => s + (r.promptTokens ?? 0), 0),
        // The server's prefix cache: how much of each first round it reused.
        firstRoundCachedShare:
            answers.reduce((sum, a) => sum + a.rounds[0].cachedTokens, 0) /
            Math.max(
                1,
                answers.reduce((sum, a) => sum + (a.rounds[0].promptTokens ?? 0), 0),
            ),
        firstRoundPromptTokensP50: percentile(
            answers.map((a) => a.rounds[0].promptTokens),
            0.5,
        ),
    };
    console.log(JSON.stringify(summary));
    results.arms.push({ ...summary, answers });
}
writeFileSync(join(values.out, `cb134-seed${seed}${tag}.json`), JSON.stringify(results, null, 2));
rmSync(scratch, { recursive: true, force: true });
console.log(
    JSON.stringify(
        results.arms.map(({ answers: _answers, ...rest }) => rest),
        null,
        2,
    ),
);
