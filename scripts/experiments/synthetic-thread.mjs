// Synthetic long Dot chats for the context experiments (CB-137, CB-134).
// Shaped like a real long analysis chat (CB-129;
// tests/fixtures/long-thread-shape.ts: each turn's message and answer sizes
// and its tool calls, cycled), with made-up content: data rows, ids, and
// decisions scattered through every turn, and 20 planted facts (ids,
// decisions, preferences) early on, four of them changed later. Nothing
// here is real data. Deterministic for a seed.
import { LONG_THREAD_SHAPE } from '../../tests/fixtures/long-thread-shape.ts';

/** The Dot's system prompt in the experiments. */
export const SYSTEM =
    'You are Ada, a specialist Dot in Socio. You help the person analyse their CRM data: datasets, jobs, pages and schedules.';
/** The question-answering prompt: the notes as context, nothing else. */
export const QA_SYSTEM =
    'You answer questions about earlier work in a long conversation, using only the notes given. Answer in one short sentence, giving ids, names, numbers and values exactly as the notes write them. When the notes have a newer value than an older one, give the newer. If the notes do not say, answer "not in the notes".';

/** A small seeded random generator (mulberry32). */
export function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pickOf = (rand, items) => items[Math.floor(rand() * items.length)];
const hex = (rand, length) => Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join('');

/**
 * The 20 planted facts: where each is said, the words that must survive,
 * a question about it, and what a right and a wrong answer contain. A
 * `changed` fact is said again later with a new value; the old one is then
 * the wrong answer.
 */
export function plantedFacts(seed) {
    const rand = random(seed * 7919);
    const n = (min, max) => min + Math.floor(rand() * (max - min));
    const job = `job-${n(1000, 9999)}`;
    const page = `pg_board_${hex(rand, 4)}`;
    const sched = `sched-${n(100, 999)}`;
    const app = `app_rev_${hex(rand, 3)}`;
    const region = pickOf(rand, ['latam', 'emea', 'apac']);
    const owner = pickOf(rand, ['Marta', 'Ingrid', 'Tomasz', 'Keiko']);
    const q2 = `${n(4, 9)}.${n(1, 9)}%`;
    const seats = pickOf(rand, ['150', '200', '250']);
    const cut = pickOf(rand, ['12%', '15%', '18%']);
    const v1 = `ds_churn_q3_v${n(1, 4)}`;
    const v2 = `ds_churn_q3_v${n(5, 9)}`;
    const t1 = `0.${n(60, 75)}`;
    const t2 = `0.${n(80, 92)}`;
    return [
        {
            id: 'dataset',
            turn: 2,
            said: 'user',
            text: `The churn data lives in dataset ${v1}; use that for everything churn.`,
            changed: {
                turn: 34,
                said: 'user',
                text: `Switch to dataset ${v2} for churn from now on: ${v1} has duplicate rows.`,
            },
            keep: v2,
            question: 'Which dataset should the churn analysis use now?',
            right: [v2],
            wrong: [new RegExp(`\\b${v1}\\b`)],
        },
        {
            id: 'page',
            turn: 3,
            said: 'dot',
            text: `I saved the board summary to the page ${page}.`,
            keep: page,
            question: 'What is the id of the page with the board summary?',
            right: [page],
            wrong: [/pg_board_[0-9a-f]{4}/],
        },
        {
            id: 'job',
            turn: 4,
            said: 'dot',
            text: `The nightly CRM sync runs as job ${job} at 02:00.`,
            keep: job,
            question: 'What is the id of the nightly CRM sync job?',
            right: [job],
            wrong: [/job-[0-9a-f]{4}/],
        },
        {
            id: 'url',
            turn: 5,
            said: 'user',
            text: `Pull the marketplace list from https://marketplace.example.test/apps?sort=installs&region=${region}`,
            keep: `region=${region}`,
            question: 'From which URL do we pull the marketplace list?',
            right: [`region=${region}`],
            wrong: [/region=\w+/],
        },
        {
            id: 'path',
            turn: 6,
            said: 'dot',
            text: 'The dashboard is written to reports/q3/churn-dashboard.html.',
            keep: 'reports/q3/churn-dashboard.html',
            question: 'Which file is the churn dashboard written to?',
            right: ['reports/q3/churn-dashboard.html'],
            wrong: [/reports\/(?!q3\/churn-dashboard\.html)[\w/.-]+\.html/],
        },
        {
            id: 'cadence',
            turn: 7,
            said: 'user',
            text: 'Decision: the churn report goes out weekly, on Mondays.',
            changed: {
                turn: 38,
                said: 'user',
                text: 'Change of plan: the churn report now goes out daily at 07:00, not weekly.',
            },
            keep: 'daily',
            question: 'How often does the churn report go out now?',
            right: [/daily/i],
            wrong: [/weekly|monday/i],
        },
        {
            id: 'trials',
            turn: 8,
            said: 'user',
            text: 'Decision: exclude trial accounts from every churn number.',
            keep: 'trial',
            question: 'Which accounts are left out of the churn numbers?',
            right: [/trial/i],
            wrong: [],
        },
        {
            id: 'currency',
            turn: 9,
            said: 'user',
            text: 'All amounts are in USD, never BRL.',
            keep: 'USD',
            question: 'In which currency are amounts reported?',
            right: [/\bUSD\b/],
            wrong: [/\bBRL\b/],
        },
        {
            id: 'charts',
            turn: 10,
            said: 'user',
            text: 'I prefer bar charts; never use pie charts.',
            keep: 'bar chart',
            question: 'What kind of chart does the person prefer?',
            right: [/\bbar\b/i],
            wrong: [/\bpie\b/i],
        },
        {
            id: 'threshold',
            turn: 11,
            said: 'user',
            text: `Flag accounts whose churn risk is above ${t1}.`,
            changed: {
                turn: 42,
                said: 'user',
                text: `Raise the churn risk flag to ${t2}; ${t1} flags too many.`,
            },
            keep: t2,
            question: 'Above which churn risk score are accounts flagged now?',
            right: [t2],
            wrong: [new RegExp(`(?<![\\d.])${t1.replace('.', '\\.')}(?!\\d)`)],
        },
        {
            id: 'channel',
            turn: 12,
            said: 'user',
            text: 'Send me summaries on Telegram, not by email.',
            keep: 'Telegram',
            question: 'Where should summaries be sent?',
            right: [/telegram/i],
            wrong: [/e-?mail/i],
        },
        {
            id: 'goal',
            turn: 13,
            said: 'user',
            text: `Goal: cut churn in ${region.toUpperCase()} by ${cut} by the end of Q4.`,
            keep: cut,
            question: 'By how much do we want to cut churn, and by when?',
            right: [cut],
            wrong: [/\b(?:10|20|25)%/],
        },
        {
            id: 'app',
            turn: 14,
            said: 'dot',
            text: `The revenue tracker app is ${app}.`,
            keep: app,
            question: 'What is the id of the revenue tracker app?',
            right: [app],
            wrong: [/app_rev_[0-9a-f]{3}/],
        },
        {
            id: 'schedule',
            turn: 15,
            said: 'dot',
            text: `The weekly digest runs on schedule ${sched}.`,
            keep: sched,
            question: 'Which schedule runs the weekly digest?',
            right: [sched],
            wrong: [/sched-\d{3}/],
        },
        {
            id: 'timezone',
            turn: 16,
            said: 'user',
            text: 'Decision: every schedule uses the America/Sao_Paulo time zone.',
            keep: 'America/Sao_Paulo',
            question: 'Which time zone do the schedules use?',
            right: [/sao[_ ]paulo/i],
            wrong: [/\bUTC\b|new[_ ]york/i],
        },
        {
            id: 'owner',
            turn: 17,
            said: 'user',
            text: `${owner} owns the ${region.toUpperCase()} segment; ask her before changing it.`,
            keep: owner,
            question: `Who owns the ${region.toUpperCase()} segment?`,
            right: [owner],
            wrong: [/\b(?:Marta|Ingrid|Tomasz|Keiko)\b/],
        },
        {
            id: 'q2',
            turn: 18,
            said: 'dot',
            text: `Result: Q2 churn was ${q2}.`,
            keep: q2,
            question: 'What was churn in Q2?',
            right: [q2],
            // Another Q2 figure; not any percentage the notes mention.
            wrong: [/Q2[^.\d]*\d\.\d%/i],
        },
        {
            id: 'enterprise',
            turn: 19,
            said: 'user',
            text: `Decision: "enterprise" means accounts with ${seats}+ seats.`,
            keep: `${seats}+ seats`,
            question: 'What counts as an enterprise account?',
            right: [seats],
            wrong: [/\b(?:150|200|250)\b/],
        },
        {
            id: 'refunds',
            turn: 20,
            said: 'user',
            text: 'Open question: do refunds count as churn? Check with finance.',
            keep: 'refunds',
            question: 'What open question is there about refunds?',
            right: [/refund/i],
            wrong: [],
        },
        {
            id: 'column',
            turn: 21,
            said: 'user',
            text: 'Use the installs column for the adoption chart.',
            changed: {
                turn: 46,
                said: 'user',
                text: 'Use active_installs instead of installs for the adoption chart.',
            },
            keep: 'active_installs',
            question: 'Which column does the adoption chart use now?',
            right: ['active_installs'],
            wrong: [/(?<![_\w])installs\b/],
        },
    ];
}

const TOOLS_ARGS = {
    data_query: (rand, segment) =>
        JSON.stringify({
            sql: `SELECT account_id, mrr, risk FROM seg_${segment}_accounts WHERE risk > 0.${Math.floor(rand() * 90 + 10)} ORDER BY mrr DESC LIMIT 200`,
        }),
    read_space_page: (rand) => JSON.stringify({ pageId: `pg_${hex(rand, 6)}` }),
    edit_space_page: (rand, segment) =>
        JSON.stringify({
            pageId: `pg_seg_${segment}`,
            markdown: `# Segment ${segment}\n`,
        }),
    job_logs: (rand) => JSON.stringify({ jobId: `job-${hex(rand, 4)}` }),
    job_run: (rand) => JSON.stringify({ jobId: `job-${hex(rand, 4)}` }),
    files_get: (rand, segment) => JSON.stringify({ path: `exports/seg_${segment}/${hex(rand, 6)}.csv` }),
    http_json: (rand) => JSON.stringify({ url: `https://api.example.test/v2/apps/${hex(rand, 8)}` }),
};

/** A tool result of about `chars` characters: rows of made-up data. */
function result(rand, tool, chars, segment) {
    if (!chars) {
        return '{}';
    }
    const rows = [];
    let size = 0;
    while (size < chars) {
        const row = JSON.stringify({
            account_id: `acc_${hex(rand, 8)}`,
            segment: `seg_${segment}`,
            mrr: Math.round(rand() * 900000) / 100,
            risk: Math.round(rand() * 1000) / 1000,
            installs: Math.floor(rand() * 5000),
            updated: `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}`,
        });
        rows.push(row);
        size += row.length + 1;
    }
    return `{"tool":"${tool}","rows":[${rows.join(',')}]}`.slice(0, chars);
}

/** A sentence of plausible filler for the person or the Dot. */
const FILLER = [
    'Can you look at the latest numbers and tell me what moved',
    'Refine the chart so the trend is easier to read',
    'Check the job logs and see whether the last run finished',
    'Compare this segment with the previous quarter',
    'Update the page with what you found',
    'Break it down by plan and region',
    'Look for outliers in the accounts with the highest MRR',
    'Summarise what changed since the last run',
];

/** A routine decision or id the Dot mentions in passing (noise the notes pin too). */
function noise(rand, turn, segment) {
    return pickOf(rand, [
        `Decision: segment ${segment} charts use a log scale.`,
        `I saved the query as q_seg${segment}_${hex(rand, 3)}.`,
        `Result: segment ${segment} MRR moved ${(rand() * 10 - 5).toFixed(1)}% week on week.`,
        `The export is at exports/seg_${segment}/summary_${turn}.csv.`,
        `Decision: segment ${segment} keeps accounts with risk above 0.${30 + Math.floor(rand() * 20)} in the watch list.`,
        `I updated the page pg_seg_${segment} with the new table.`,
        `Open: segment ${segment} has ${Math.floor(rand() * 40)} accounts without a region.`,
        `The job job-${hex(rand, 4)} rebuilt segment ${segment} in ${Math.floor(rand() * 90)}s.`,
    ]);
}

const pad = (rand, text, chars, words) => {
    let out = text;
    while (out.length < chars) {
        out += ` ${pickOf(rand, words)}.`;
    }
    return out;
};

/**
 * A thread of `turns` turns as model messages, each turn a person's message,
 * the Dot's tool rounds and its answer, with the planted facts said where
 * they belong. Returns the turns separately, so a run can grow the thread
 * one turn at a time.
 */
export function syntheticThread(seed, turns) {
    const rand = random(seed);
    const facts = plantedFacts(seed);
    const said = new Map();
    for (const fact of facts) {
        said.set(fact.turn, [...(said.get(fact.turn) ?? []), fact]);
        if (fact.changed) {
            said.set(fact.changed.turn, [...(said.get(fact.changed.turn) ?? []), { ...fact.changed, id: fact.id }]);
        }
    }
    const out = [];
    for (let index = 0; index < turns; index++) {
        const shape = LONG_THREAD_SHAPE[index % LONG_THREAD_SHAPE.length];
        const segment = 1 + (index % 37);
        const here = said.get(index) ?? [];
        const userFacts = here.filter((fact) => fact.said === 'user');
        const dotFacts = here.filter((fact) => fact.said === 'dot');
        const userText = pad(
            rand,
            [
                `Turn ${index + 1}, segment ${segment}:`,
                ...userFacts.map((fact) => fact.text),
                `${pickOf(rand, FILLER)}.`,
            ].join(' '),
            Math.min(shape.user, 600),
            FILLER,
        );
        const messages = [{ role: 'user', content: userText }];
        shape.calls.slice(0, 8).forEach(([tool, args, chars], call) => {
            const id = `call_${seed}_${index}_${call}`;
            const argsText = (TOOLS_ARGS[tool] ?? (() => JSON.stringify({ segment })))(rand, segment);
            messages.push(
                {
                    role: 'assistant',
                    content: null,
                    toolCalls: [
                        {
                            id,
                            type: 'function',
                            function: {
                                name: tool,
                                arguments: args > 2_000 ? argsText.padEnd(args, ' ') : argsText,
                            },
                        },
                    ],
                },
                {
                    role: 'tool',
                    toolCallId: id,
                    content: result(rand, tool, chars, segment),
                },
            );
        });
        const answer = pad(
            rand,
            [...dotFacts.map((fact) => fact.text), noise(rand, index, segment), noise(rand, index, segment)].join(' '),
            Math.max(200, Math.min(shape.text, 1_200)),
            [
                'The numbers are in the table above',
                'Nothing else stood out',
                'I left the rest as it was',
                'Tell me if you want a deeper cut',
            ],
        );
        messages.push({ role: 'assistant', content: answer });
        out.push(messages);
    }
    return { turns: out, facts };
}

/**
 * An answer's score for a planted fact: `right` when it has the current
 * value, else `wrong` when it has a wrong one (a superseded value, or
 * another id of the same kind), else `unknown` (it said it doesn't know).
 */
export function score(fact, answer) {
    const has = (pattern) =>
        typeof pattern === 'string' ? answer.toLowerCase().includes(pattern.toLowerCase()) : pattern.test(answer);
    if (fact.right.some(has)) {
        return 'right';
    }
    return fact.wrong.some(has) ? 'wrong' : 'unknown';
}

/** Whether a fact's words survive in a list of pinned lines, word for word. */
export const keptVerbatim = (fact, lines) => lines.some((line) => line.toLowerCase().includes(fact.keep.toLowerCase()));
