// The results tables of the context selection experiments, from the JSON
// the experiment scripts wrote:
//
//   node --import tsx scripts/experiments/report.mjs [/tmp/cb-issues/experiments]
//
// Answers are scored again with synthetic-thread.mjs's patterns, so a fix
// to a pattern applies to earlier runs too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { plantedFacts, score } from './synthetic-thread.mjs';

const dir = process.argv[2] ?? '/tmp/cb-issues/experiments';
/** A run's answers scored again; `right`, `wrong` and `unknown` counted. */
function rescore(seed, answers) {
    const facts = new Map(plantedFacts(seed).map((fact) => [fact.id, fact]));
    for (const answer of answers) {
        answer.score = score(facts.get(answer.id), answer.answer);
    }
    const count = (kind) => answers.filter((a) => a.score === kind).length;
    return {
        right: count('right'),
        wrong: count('wrong'),
        unknown: count('unknown'),
    };
}
const read = (name) => {
    const file = join(dir, name);
    if (!existsSync(file)) {
        return undefined;
    }
    const result = JSON.parse(readFileSync(file, 'utf8'));
    if (result.quality) {
        Object.assign(result.quality, rescore(result.seed, result.answers));
    }
    for (const arm of result.arms ?? []) {
        Object.assign(arm, rescore(result.seed, arm.answers));
    }
    return result;
};
const seconds = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '–');
const ms = (value) => (Number.isFinite(value) ? `${Math.round(value)} ms` : '–');
const k = (value) => (value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)));
const seeds = [1, 2, 3, 4].filter((seed) => read(`cb137-seed${seed}-shared.json`));
// Variants of the summary prompt, by the scripts' --tag ('' the first).
const TAGS = ['', '-v2'];

console.log('### CB-137: the notes by the shared model or the chat’s\n');
console.log(
    '| Seed | Arm | Folding rounds | Added latency p50 | p95 | Summary requests | Fallbacks | Tokens in / out | Facts stored | Planted facts kept word for word (of 20): pinned / pinned or names / store / prompt | QA right / wrong / unknown |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const seed of seeds) {
    for (const arm of ['shared', 'chat', 'shared-v2', 'chat-v2']) {
        const r = read(`cb137-seed${seed}-${arm}.json`);
        if (!r) {
            continue;
        }
        const fallbacks = r.summaries.fallbacks.length
            ? Object.entries(
                  r.summaries.fallbacks.reduce((count, kind) => ({ ...count, [kind]: (count[kind] ?? 0) + 1 }), {}),
              )
                  .map(([kind, count]) => `${count} ${kind}`)
                  .join(', ')
            : '0';
        console.log(
            `| ${seed} | ${arm} | ${r.latency.foldingRounds} | ${seconds(r.latency.p50Ms)} | ${seconds(r.latency.p95Ms)} | ${r.summaries.requests} | ${fallbacks} | ${k(r.summaries.inputTokens)} / ${k(r.summaries.outputTokens)} | ${r.notes.stored} | ${r.quality.keptInPinned} / ${r.quality.keptInPinnedOrNames} / ${r.quality.keptInStore} / ${r.quality.keptInPrompt} | ${r.quality.right} / ${r.quality.wrong} / ${r.quality.unknown} |`,
        );
    }
}

console.log('\n### CB-134: which pinned facts a prompt carries\n');
console.log(
    '| Seed | Selection | Right / wrong / unknown (of 20) | Facts shown of stored (p50) | Notes tokens (p50) | Selection time p50 / p95 | Tool rounds (recall + search_notes) | Tokens of those rounds | First round prompt (p50) | Prefix reused |',
);
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const tag of TAGS) {
    for (const seed of [1, 2, 3, 4]) {
        const r = read(`cb134-seed${seed}${tag}.json`);
        if (!r) {
            continue;
        }
        for (const arm of r.arms) {
            console.log(
                `| ${seed}${tag ? ` (prompt ${tag.slice(1)})` : ''} | ${arm.arm} | ${arm.right} / ${arm.wrong} / ${arm.unknown} | ${arm.pinnedShown} of ${arm.pinnedStored} | ${k(arm.notesTokens)} | ${ms(arm.selectP50Ms)} / ${ms(arm.selectP95Ms)} | ${arm.extraRounds} (${arm.recallCalls} + ${arm.searchNotesCalls}) | ${k(arm.extraPromptTokens)} | ${k(arm.firstRoundPromptTokensP50)} | ${Math.round((arm.firstRoundCachedShare ?? 0) * 100)}% |`,
            );
        }
    }
}
