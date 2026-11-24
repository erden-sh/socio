import type { BaseEvent } from '@ag-ui/client';

/**
 * A long conversation shaped like the CRM Analyst's (CB-136): `turns`
 * finished runs of about 1.5 MB in all, each asking a question, reasoning,
 * calling the data tools and answering in Markdown. Every eighth turn's
 * query returns a large result (up to `largest` characters), as a report
 * pull does; the others return a few KB. Events carry times, as runs are
 * stored since CB-72. Deterministic: the same arguments give the same runs.
 */
export interface LongChatRun {
    runId: string;
    startedAt: number;
    finishedAt: number;
    events: BaseEvent[];
}

const row = (turn: number, index: number) => ({
    id: `opp-${turn}-${index}`,
    name: `Opportunity ${index} for account ${(turn * 7 + index) % 97}`,
    stage: ['lead', 'qualified', 'proposal', 'won', 'lost'][index % 5],
    value: ((turn + 3) * (index + 11) * 37) % 25_000,
    owner: `rep-${index % 9}`,
    updated: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
    note: 'Followed up by phone; waiting on the signed order form and the revised quote.',
});

/** Rows until the JSON is about `chars` long. */
const rowsOf = (turn: number, chars: number) => {
    const rows: ReturnType<typeof row>[] = [];
    for (let size = 0; size < chars; size += 220) {
        rows.push(row(turn, rows.length));
    }
    return rows;
};

export function longChatRuns({
    threadId,
    turns = 32,
    largest = 250_000,
    startedAt = Date.UTC(2026, 9, 1, 9),
}: {
    threadId: string;
    turns?: number;
    largest?: number;
    startedAt?: number;
}): LongChatRun[] {
    const runs: LongChatRun[] = [];
    for (let turn = 0; turn < turns; turn++) {
        const runId = `run-${turn}`;
        const start = startedAt + turn * 15 * 60_000;
        const events: Array<Record<string, unknown>> = [];
        let ms = 0;
        const at = (event: Record<string, unknown>, step = 400) => {
            ms += step;
            events.push({ ...event, timestamp: start + ms });
        };
        const reply = `reply-${turn}`;
        at(
            {
                type: 'RUN_STARTED',
                threadId,
                runId,
                input: {
                    threadId,
                    runId,
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                    messages: [
                        {
                            id: `user-${turn}`,
                            role: 'user',
                            content: `Question ${turn + 1}: how did the pipeline move for the accounts we reviewed, and which deals need a follow-up this week?`,
                        },
                    ],
                },
            },
            0,
        );
        at({ type: 'REASONING_START', messageId: `think-${turn}` });
        at({
            type: 'REASONING_MESSAGE_START',
            messageId: `think-${turn}`,
            role: 'reasoning',
        });
        at({
            type: 'REASONING_MESSAGE_CONTENT',
            messageId: `think-${turn}`,
            delta: 'I’ll pull the opportunities for these accounts, compare stages with last week, and list the deals that stalled.',
        });
        at({ type: 'REASONING_MESSAGE_END', messageId: `think-${turn}` });
        at({ type: 'REASONING_END', messageId: `think-${turn}` });
        const calls: Array<[string, unknown, unknown]> = [
            [
                'query_dataset',
                { sql: `SELECT * FROM opportunities WHERE batch = ${turn}` },
                {
                    status: 'ok',
                    title: `Opportunities, batch ${turn + 1}`,
                    rows: rowsOf(turn, turn % 8 === 7 ? largest : 9_000),
                },
            ],
            [
                'read_space_page',
                { id: `page-${turn}` },
                {
                    title: `Account notes ${turn + 1}`,
                    content: `# Account notes\n\n${'Weekly call notes and next steps. '.repeat(90)}`,
                },
            ],
        ];
        for (const [index, [name, args, result]] of calls.entries()) {
            const id = `call-${turn}-${index}`;
            at({
                type: 'TOOL_CALL_START',
                toolCallId: id,
                toolCallName: name,
                parentMessageId: reply,
            });
            at({
                type: 'TOOL_CALL_ARGS',
                toolCallId: id,
                delta: JSON.stringify(args),
            });
            at({ type: 'TOOL_CALL_END', toolCallId: id });
            at(
                {
                    type: 'TOOL_CALL_RESULT',
                    messageId: `${id}-result`,
                    toolCallId: id,
                    role: 'tool',
                    content: JSON.stringify(result),
                },
                1_200,
            );
        }
        at({ type: 'TEXT_MESSAGE_START', messageId: reply, role: 'assistant' });
        at({
            type: 'TEXT_MESSAGE_CONTENT',
            messageId: reply,
            delta: `## Pipeline, batch ${turn + 1}\n\n| Stage | Deals | Value |\n| --- | --- | --- |\n| Qualified | ${turn + 4} | $${(turn + 4) * 1200} |\n| Proposal | ${turn + 2} | $${(turn + 2) * 3400} |\n| Won | ${turn % 5} | $${(turn % 5) * 8100} |\n\n${'Three deals stalled at proposal: send the revised quote and book a call with each owner. '.repeat(6)}`,
        });
        at({ type: 'TEXT_MESSAGE_END', messageId: reply });
        at({ type: 'RUN_FINISHED', threadId, runId });
        runs.push({
            runId,
            startedAt: start,
            finishedAt: start + ms,
            events: events as unknown as BaseEvent[],
        });
    }
    return runs;
}
