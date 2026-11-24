// Testing only: a scripted OpenAI-compatible model for the `data` smoke
// scenario (`ui-smoke.mjs --scenario data`). Loopback only, no key checked.
//
//   node --import tsx tests/fixtures/serve-fake-model.ts [port]
//
// Then start the app with OPENAI_BASE_URL=http://127.0.0.1:<port>/v1,
// OPENAI_MODEL=fake-model and OPENAI_API_KEY=unused (a fresh database, so
// the backend is seeded from them). A turn whose first user message
// mentions "smoke data" creates a table in the Dot's scratch dataset,
// inserts three rows, asks to create a dataset (an approval card) and then
// answers. A turn whose first user message mentions "smoke view" and a
// page (`page <spaceId>/<pageId>`) fills a smoke_sales table and embeds a
// bar chart of it in that page (`insert_dataset_view`, the `views`
// scenario). One that mentions "smoke schedule" saves a job and
// proposes a daily schedule (two approval cards), then answers. An auto
// approval review (the `auto` scenario) is approved at low risk. One
// that mentions "smoke phases" answers slowly, with reasoning first (the
// phase line). One that mentions "smoke media" (CB-54, the `media`
// scenario) says how many images and file notes its last user message
// brought (start the app with MODEL_ACCEPTS_IMAGES=true to get images).
// One that mentions "smoke hold" answers after 20 s (the chat menu's
// Delete is disabled while it runs).
// For the transcript (CB-66, the `chat` scenario): a turn whose last user
// message mentions "smoke long" gets a long Markdown answer at once (a
// transcript taller than the screen); "smoke stream" streams a long
// answer over about 6 s; "smoke wait" waits 20 s before answering (the
// status line while waiting); "smoke think" reasons for 20 s first. A
// turn whose first user message mentions "smoke approvals" asks to create
// two datasets (two approval cards, the composer's approval bar), then
// answers; so does one whose last user message mentions it. One whose
// last user message mentions "smoke cards" (CB-104) links CB-1 to CB-3
// mid-sentence, on their own line, before a lone "." and in a list, and
// alone with an arrow after it (CB-118; issue cards: create the issues
// first). One whose first user message mentions "smoke goal" (CB-131)
// proposes a goal (an approval card), then answers. One whose first user
// message mentions "smoke wide" (CB-107) asks to create a dataset described with long unbreakable lines (an
// approval card), then answers with a long URL and a long code line.
// A turn whose first user message mentions "smoke trace" (CB-72, to watch
// the trace) reasons, lists its Spaces, searches the pages, runs a query
// that fails and answers, about 2 s per round: the trace shows it live.
// For long chats (CB-129): with FAKE_CONTEXT_WINDOW=<tokens> set, a request
// over that many tokens (its body at four characters a token) is refused
// with OpenAI's 400 `context_length_exceeded`, as a real server's would be;
// a turn whose last user message mentions "smoke context" reads the
// capabilities twice (big tool results), recalls a result set aside when
// it sees one, then answers; and a running-notes request is answered after
// FAKE_NOTES_DELAY_MS (3 s by default) with pinned facts and a summary.
// A turn whose last message asks to "reply with exactly the word: X" or to
// "mention the word "X"" (the chat scenario) gets X in its answer, and its
// conversation is titled "Smoke X". Any other turn gets a short answer.
// For the native app's chats (fake-model-chats.ts): a turn whose
// last user message mentions "smoke review" calls review_space_page and
// answers once the review's result comes; "smoke 20k" streams a 20,000
// character Markdown answer at a fixed rate; "smoke slow-stream" streams
// one line a second for 60 s.
import { createServer, type ServerResponse } from 'node:http';

import {
    SMOKE_20K_INTERVAL_MS,
    SMOKE_SLOW_INTERVAL_MS,
    smoke20kParts,
    smokeReviewAnswer,
    smokeReviewDraft,
    smokeSlowParts,
} from './fake-model-chats.js';

type Message = { role: string; content?: unknown };
const port = Number(process.argv[2] ?? 4513);
const contextWindow = Number(process.env.FAKE_CONTEXT_WINDOW ?? 0);
const notesDelayMs = Number(process.env.FAKE_NOTES_DELAY_MS ?? 3_000);

const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, unknown>) =>
    `data: ${JSON.stringify({
        id: 'fake',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fake-model',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
    })}\n\n`;
const cardsAnswer = [
    'Your observation was added to [CB-1](/issues/CB-1). [CB-2](/issues/CB-2) is about something else.',
    '',
    '[CB-2](/issues/CB-2)',
    '',
    '[CB-3](/issues/CB-3).',
    '',
    '- [CB-1](/issues/CB-1)',
    '- [CB-2](/issues/CB-2).',
    '- [CB-3](/issues/CB-3), the follow-up.',
    '',
    'Filed it and attached your screenshot.',
    '',
    '[Open CB-1](/issues/CB-1) ↗',
].join('\n');
const toolCall = (name: string, args: unknown, step: number) =>
    chunk(
        {
            role: 'assistant',
            tool_calls: [
                {
                    index: 0,
                    id: `call-${step}-${name}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                },
            ],
        },
        null,
    ) + chunk({}, 'tool_calls');
const text = (content: string) => chunk({ role: 'assistant', content }, null) + chunk({}, 'stop');

/** The scripted reply for a data turn, by how many tool results it has. */
function dataStep(results: number) {
    switch (results) {
        case 0:
            return toolCall(
                'data_create_table',
                {
                    table: 'smoke_prices',
                    ifNotExists: true,
                    columns: [
                        { name: 'sku', type: 'TEXT', primaryKey: true },
                        { name: 'price', type: 'REAL' },
                        { name: 'seen_at', type: 'DATETIME' },
                    ],
                },
                results,
            );
        case 1:
            return toolCall(
                'data_upsert',
                {
                    table: 'smoke_prices',
                    key: ['sku'],
                    rows: [
                        { sku: 'apple', price: 1.25, seen_at: '2026-10-08' },
                        { sku: 'pear', price: 2.5, seen_at: '2026-10-08' },
                        { sku: 'plum', price: 0.75, seen_at: '2026-10-08' },
                    ],
                },
                results,
            );
        case 2:
            return toolCall(
                'data_create_dataset',
                {
                    name: 'Smoke watchlist',
                    description: 'Created by the UI smoke test.',
                },
                results,
            );
        default:
            return text(
                'Saved 3 prices in smoke_prices, in your scratch dataset. I also asked to create the Smoke watchlist dataset: approve it in the card.',
            );
    }
}

/** The scripted reply for a view turn: a table, rows, then the view. */
function viewStep(results: number, target: { spaceId: string; pageId: string }) {
    switch (results) {
        case 0:
            return toolCall(
                'data_create_table',
                {
                    table: 'smoke_sales',
                    ifNotExists: true,
                    columns: [
                        { name: 'month', type: 'TEXT', primaryKey: true },
                        { name: 'total', type: 'REAL' },
                    ],
                },
                results,
            );
        case 1:
            return toolCall(
                'data_upsert',
                {
                    table: 'smoke_sales',
                    key: ['month'],
                    rows: [
                        { month: '2026-07', total: 120 },
                        { month: '2026-08', total: 95.5 },
                        { month: '2026-09', total: 143 },
                        { month: '2026-10', total: 160 },
                    ],
                },
                results,
            );
        case 2:
            return toolCall(
                'insert_dataset_view',
                {
                    ...target,
                    query: 'SELECT month, total FROM smoke_sales ORDER BY month',
                    display: 'bar',
                    x: 'month',
                    y: 'total',
                    title: 'Smoke sales',
                    afterHeading: 'Sales',
                },
                results,
            );
        default:
            return text('Added the Smoke sales view to the page.');
    }
}

/** The scripted reply for a schedules turn, by tool results so far. */
function scheduleStep(results: number) {
    switch (results) {
        case 0:
            return toolCall(
                'job_save',
                {
                    name: 'Smoke prices',
                    entry: 'main.sh',
                    files: {
                        'main.sh':
                            'echo "fetched 3 prices"\ncurl -s -H "Authorization: Bearer $CB_DATA_TOKEN" "$CB_DATA_URL/datasets/scratch" > /dev/null\n',
                    },
                    timeoutSeconds: 60,
                },
                results,
            );
        case 1:
            return toolCall(
                'schedule_create',
                {
                    title: 'Smoke morning digest',
                    cadence: 'every day at 09:00',
                    timezone: 'Europe/Paris',
                    action: {
                        kind: 'turn',
                        prompt: 'Summarise the smoke prices collected so far.',
                    },
                },
                results,
            );
        default:
            return text(
                'I asked to save the Smoke prices job and to schedule a morning digest: approve both in the cards.',
            );
    }
}

/** A goal proposal (CB-131): one approval card, then an answer. */
function goalStep(results: number) {
    if (!results) {
        return toolCall(
            'goal_set',
            {
                title: 'Keep the onboarding doc current',
                detail: 'Check it against the latest release notes.',
                cadence: 'every day at 09:00',
            },
            results,
        );
    }
    return text('I asked to take on the goal: approve it in the card.');
}

/**
 * Long unbreakable lines (CB-107, the `mobile-fit` scenario): a dataset
 * request whose description has a long URL (an approval card that shows
 * it), then an answer with a long URL in its prose and a long line in a
 * code block.
 */
const wideUrl =
    'https://services.example-crm.test/marketplace/public/app/0123456789abcdef0123456789abcdef/installations?locationId=abcdefghijklmnopqrstuvwxyz';
function wideStep(results: number) {
    if (!results) {
        return toolCall(
            'data_create_dataset',
            {
                name: 'Smoke wide',
                description: `Reads ${wideUrl} with process.env.CB_DATA_URL_WITH_A_VERY_LONG_NAME_THAT_DOES_NOT_BREAK_ANYWHERE.`,
            },
            results,
        );
    }
    return text(
        [
            `Smoke wide: the app's page is ${wideUrl} and it reads process.env.CB_DATA_URL_WITH_A_VERY_LONG_NAME_THAT_DOES_NOT_BREAK_ANYWHERE.`,
            '',
            '```ts',
            `const response = await fetch('${wideUrl}', { headers: { Authorization: \`Bearer \${process.env.CB_DATA_TOKEN}\` } });`,
            '```',
            '',
            `Inline: \`${wideUrl}\`.`,
        ].join('\n'),
    );
}

/** Two dataset requests in a row, then an answer (the approval bar). */
function approvalsStep(results: number) {
    if (results < 2) {
        return toolCall(
            'data_create_dataset',
            {
                name: results ? 'Smoke second' : 'Smoke first',
                description: 'Created by the UI smoke test.',
            },
            results,
        );
    }
    return text('I asked to create two datasets: decide them when you can.');
}

/** A long Markdown answer: a heading, paragraphs, a list and some code. */
function longAnswer(paragraphs: number) {
    const body = Array.from(
        { length: paragraphs },
        (_, index) =>
            `Paragraph ${index + 1}. SQLite keeps the whole database in one file, so a backup is a copy and a test can start from an empty file in a moment.`,
    );
    return [
        '## A long answer',
        ...body.slice(0, paragraphs / 2),
        '- one point\n- **another** point\n- a third point',
        '```sql\nSELECT name FROM dots ORDER BY name;\n```',
        ...body.slice(paragraphs / 2),
        'That is the end of the long answer.',
    ].join('\n\n');
}

/** Streams these parts, one every intervalMs, and finishes with the last. */
function paced(response: ServerResponse, parts: string[], intervalMs: number) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let index = 0;
    const timer = setInterval(() => {
        response.write(chunk({ role: 'assistant', content: parts[index++] }, null));
        if (index >= parts.length) {
            clearInterval(timer);
            response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
        }
    }, intervalMs);
    response.on('close', () => clearInterval(timer));
}

const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] }));
        return;
    }
    let body = '';
    request.on('data', (part) => (body += part));
    request.on('end', () => {
        let parsed: { messages?: Message[]; stream?: boolean } = {};
        try {
            parsed = JSON.parse(body);
        } catch {
            // Answer anything; the app never sends invalid JSON.
        }
        const messages = parsed.messages ?? [];
        const system = JSON.stringify(messages.find((message) => message.role === 'system')?.content ?? '');
        const promptTokens = Math.ceil(body.length / 4);
        if (contextWindow && promptTokens > contextWindow) {
            response.writeHead(400, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    error: {
                        message: `This model's maximum context length is ${contextWindow} tokens. However, your messages resulted in ${promptTokens} tokens.`,
                        type: 'invalid_request_error',
                        param: 'messages',
                        code: 'context_length_exceeded',
                    },
                }),
            );
            return;
        }
        if (system.includes('You keep the running notes')) {
            const turns = (JSON.stringify(messages.at(-1)?.content ?? '').match(/Person:/g) ?? []).length;
            const timer = setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(
                    text(
                        `PINNED:\n- Working on: the context smoke\n- The person wants every turn answered\nSUMMARY:\nThe person ran context smoke turns; ${turns} more were folded into these notes. Each read the capabilities.`,
                    ) +
                        chunk({}, 'stop', {
                            prompt_tokens: promptTokens,
                            completion_tokens: 40,
                            total_tokens: promptTokens + 40,
                        }) +
                        'data: [DONE]\n\n',
                );
            }, notesDelayMs);
            response.on('close', () => clearTimeout(timer));
            return;
        }
        if (system.includes('You review one action')) {
            const verdict = JSON.stringify({
                decision: 'approve',
                risk: 'low',
                reason: 'A new private dataset, as the smoke test’s guidance allows.',
            });
            if (parsed.stream) {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(text(verdict) + 'data: [DONE]\n\n');
            } else {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        id: 'fake',
                        object: 'chat.completion',
                        created: 1,
                        model: 'fake-model',
                        choices: [
                            {
                                index: 0,
                                message: { role: 'assistant', content: verdict },
                                finish_reason: 'stop',
                            },
                        ],
                    }),
                );
            }
            return;
        }
        const firstUser = messages.find((message) => message.role === 'user');
        const original = JSON.stringify(firstUser?.content ?? '');
        const asked = original.toLowerCase();
        const target = /page ([\w-]+)\/([\w-]+)/.exec(original);
        const results = messages.filter((message) => message.role === 'tool').length;
        if (!parsed.stream) {
            // Titles and other one-shot requests. A chat scenario conversation is
            // titled after its word, so two users' chats get different titles
            // (the users scenario tells them apart by title).
            const word =
                /reply with exactly the word: (\w+)/i.exec(original)?.[1] ??
                /mention the word \\?"(\w+)/i.exec(original)?.[1];
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    id: 'fake',
                    object: 'chat.completion',
                    created: 1,
                    model: 'fake-model',
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: word ? `Smoke ${word}` : 'Smoke data',
                            },
                            finish_reason: 'stop',
                        },
                    ],
                }),
            );
            return;
        }
        if (asked.includes('smoke phases')) {
            // A slow model (the phase line): 3 s before the first byte, as a long
            // prefill would be, then 6 s of reasoning (long enough for the smoke
            // to see it stream on a loaded host), then the answer.
            setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.write(chunk({ role: 'assistant', reasoning_content: 'Weighing it… ' }, null));
                setTimeout(() => response.write(chunk({ reasoning_content: 'the answer is short.' }, null)), 3_000);
                setTimeout(() => {
                    // Usage on the finish chunk, as TensorFold sends it (the
                    // response-time samples need the prompt's size).
                    const prompt = Math.ceil(body.length / 4);
                    response.end(
                        chunk({ role: 'assistant', content: 'Phases done.' }, null) +
                            chunk({}, 'stop', {
                                prompt_tokens: prompt,
                                completion_tokens: 12,
                                total_tokens: prompt + 12,
                            }) +
                            'data: [DONE]\n\n',
                    );
                }, 6_000);
            }, 3_000);
            return;
        }
        if (asked.includes('smoke trace')) {
            // One round every 2 s; reasoning first in the first and last.
            const round = [
                toolCall('list_authorized_spaces', {}, results),
                toolCall('search_space_pages', { query: 'export' }, results),
                toolCall(
                    'data_query',
                    {
                        sql: 'SELECT week, SUM(revenue)\nFROM weekly_sales\nGROUP BY week',
                    },
                    results,
                ),
                text('Traced: two lookups, and a query that failed.'),
            ][Math.min(results, 3)];
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (results === 0 || results >= 3) {
                response.write(chunk({ role: 'assistant', reasoning_content: 'Working out the steps. ' }, null));
            }
            const timer = setTimeout(() => response.end(round + 'data: [DONE]\n\n'), 2_000);
            response.on('close', () => clearTimeout(timer));
            return;
        }
        if (asked.includes('smoke hold')) {
            // A turn that keeps running for 20 s (CB-66: the chat menu's Delete
            // waits for it), then answers.
            setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(text('Held.') + 'data: [DONE]\n\n');
            }, 20_000);
            return;
        }
        const latest = JSON.stringify(
            messages.filter((message) => message.role === 'user').at(-1)?.content ?? '',
        ).toLowerCase();
        if (latest.includes('smoke context')) {
            // Tool results of this turn: those after its user message.
            const lastUser = messages.findLastIndex((message) => message.role === 'user');
            const round = messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length;
            const setAside = JSON.stringify(messages).match(/call recall with ref ([\w:-]+)/)?.[1];
            // The turn's number, from the message ("smoke context 12: …"):
            // older turns may be folded into notes.
            const turn = Number(/smoke context (\d+)/.exec(latest)?.[1] ?? 0);
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(
                (round === 0
                    ? toolCall('capabilities', {}, turn * 10)
                    : round === 1 && setAside
                      ? toolCall('recall', { ref: setAside }, turn * 10 + 1)
                      : round === 1
                        ? toolCall('capabilities', {}, turn * 10 + 1)
                        : text(`Context smoke turn ${turn}: done, ${round} tool results read.`)) +
                    // Usage last, with no choices, as OpenAI streams it.
                    `data: ${JSON.stringify({
                        id: 'fake',
                        object: 'chat.completion.chunk',
                        created: 1,
                        model: 'fake-model',
                        choices: [],
                        usage: {
                            prompt_tokens: promptTokens,
                            completion_tokens: 20,
                            total_tokens: promptTokens + 20,
                        },
                    })}\n\n` +
                    'data: [DONE]\n\n',
            );
            return;
        }
        if (latest.includes('smoke cards')) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(text(cardsAnswer) + 'data: [DONE]\n\n');
            return;
        }
        if (latest.includes('smoke long')) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(text(longAnswer(12)) + 'data: [DONE]\n\n');
            return;
        }
        if (latest.includes('smoke stream')) {
            // A long answer, one paragraph every 300 ms: the transcript grows
            // while the reader may scroll up.
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const parts = longAnswer(20).split(/(?<=\n\n)/);
            let index = 0;
            const timer = setInterval(() => {
                if (index >= parts.length) {
                    clearInterval(timer);
                    response.end(chunk({}, 'stop') + 'data: [DONE]\n\n');
                    return;
                }
                response.write(chunk({ role: 'assistant', content: parts[index++] }, null));
            }, 300);
            response.on('close', () => clearInterval(timer));
            return;
        }
        if (latest.includes('smoke wait')) {
            const timer = setTimeout(() => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(text('Done waiting.') + 'data: [DONE]\n\n');
            }, 20_000);
            response.on('close', () => clearTimeout(timer));
            return;
        }
        if (latest.includes('smoke think')) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.write(
                chunk(
                    {
                        role: 'assistant',
                        reasoning_content: 'Looking at the question from a few sides. ',
                    },
                    null,
                ),
            );
            const timer = setTimeout(() => {
                response.write(chunk({ reasoning_content: 'The short answer will do.' }, null));
                response.end(text('Done thinking.') + 'data: [DONE]\n\n');
            }, 20_000);
            response.on('close', () => clearTimeout(timer));
            return;
        }
        if (latest.includes('smoke review')) {
            // The review's result is the tool message after this turn's
            // user message; until it comes, ask for the review.
            const lastUser = messages.findLastIndex((message) => message.role === 'user');
            const result = messages.slice(lastUser + 1).find((message) => message.role === 'tool');
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(
                (result
                    ? text(smokeReviewAnswer(result.content))
                    : toolCall('review_space_page', smokeReviewDraft, results)) + 'data: [DONE]\n\n',
            );
            return;
        }
        if (latest.includes('smoke 20k')) {
            paced(response, smoke20kParts(), SMOKE_20K_INTERVAL_MS);
            return;
        }
        if (latest.includes('smoke slow-stream')) {
            paced(response, smokeSlowParts(), SMOKE_SLOW_INTERVAL_MS);
            return;
        }
        if (asked.includes('smoke media')) {
            const last = messages.filter((message) => message.role === 'user').at(-1);
            const parts = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : [];
            const images = parts.filter((part) => part.type === 'image_url').length;
            const notes = parts.filter((part) => part.text?.startsWith('[Attachment ')).length;
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end(text(`Smoke media: I see ${images} image(s) and ${notes} file note(s).`) + 'data: [DONE]\n\n');
            return;
        }
        // The chat scenario's prompts: "reply with exactly the word: X" and
        // "mention the word "X"" get X back.
        const lastUser = JSON.stringify(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
        const word =
            /reply with exactly the word: (\w+)/i.exec(lastUser)?.[1] ??
            /mention the word \\?"(\w+)/i.exec(lastUser)?.[1];
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(
            (asked.includes('smoke data')
                ? dataStep(results)
                : asked.includes('smoke approvals') || latest.includes('smoke approvals')
                  ? approvalsStep(results)
                  : asked.includes('smoke view') && target
                    ? viewStep(results, { spaceId: target[1], pageId: target[2] })
                    : asked.includes('smoke schedule')
                      ? scheduleStep(results)
                      : asked.includes('smoke goal')
                        ? goalStep(results)
                        : asked.includes('smoke wide')
                          ? wideStep(results)
                          : text(word ? `${word}, from the fake model.` : 'Hello from the fake model.')) +
                'data: [DONE]\n\n',
        );
    });
});
server.listen(port, '127.0.0.1', () =>
    console.log(`fake model: OPENAI_BASE_URL=http://127.0.0.1:${port}/v1 OPENAI_MODEL=fake-model`),
);
