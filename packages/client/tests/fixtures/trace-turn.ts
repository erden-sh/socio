import type { BaseEvent } from '@ag-ui/client';

/**
 * The stored events of one scripted Dot turn (CB-72), as the runner keeps
 * them: it reasons, searches the board and the pages, reads a page, runs a
 * script in its computer, has a query fail, reasons again and answers. Text
 * and tool calls share one assistant message, as the runtime streams them.
 * `timed` stamps each event with a time from `startedAt`, as runs are
 * stored since CB-72; without it, the events carry none (older runs).
 */
export function traceTurnEvents({
    threadId,
    runId,
    startedAt,
    timed = true,
}: {
    threadId: string;
    runId: string;
    startedAt: number;
    timed?: boolean;
}): BaseEvent[] {
    const reply = `reply-${runId}`;
    const events: Array<[number, Record<string, unknown>]> = [];
    const at = (ms: number, event: Record<string, unknown>) => events.push([ms, event]);
    const reasoning = (id: string, from: number, to: number, text: string) => {
        at(from, { type: 'REASONING_START', messageId: id });
        at(from, {
            type: 'REASONING_MESSAGE_START',
            messageId: id,
            role: 'reasoning',
        });
        at(from + 100, {
            type: 'REASONING_MESSAGE_CONTENT',
            messageId: id,
            delta: text,
        });
        at(to, { type: 'REASONING_MESSAGE_END', messageId: id });
        at(to, { type: 'REASONING_END', messageId: id });
    };
    const tool = (
        id: string,
        name: string,
        args: unknown,
        result: unknown,
        [start, end, done]: [number, number, number],
    ) => {
        at(start, {
            type: 'TOOL_CALL_START',
            toolCallId: id,
            toolCallName: name,
            parentMessageId: reply,
        });
        at(start + 50, {
            type: 'TOOL_CALL_ARGS',
            toolCallId: id,
            delta: JSON.stringify(args),
        });
        at(end, { type: 'TOOL_CALL_END', toolCallId: id });
        at(done, {
            type: 'TOOL_CALL_RESULT',
            messageId: `${id}-result`,
            toolCallId: id,
            role: 'tool',
            content: JSON.stringify(result),
        });
    };
    at(0, {
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
                    id: `user-${runId}`,
                    role: 'user',
                    content: 'How does the CSV export work, and what were last week’s numbers?',
                },
            ],
        },
    });
    reasoning(
        `think-1-${runId}`,
        400,
        12_600,
        'The person wants two things: how the export works, and last week’s numbers. The board may already track export problems, so I’ll search it first, then the pages for how the export is set up.',
    );
    tool(
        `call-board-${runId}`,
        'search_improvements',
        { query: 'export' },
        {
            matches: [
                {
                    issue: 'CB-41',
                    title: 'CSV export drops the header row',
                    status: 'open',
                    votes: 3,
                    excerpt: 'The weekly **export** leaves out the header row…',
                },
                {
                    issue: 'CB-58',
                    title: 'Export a Space as Markdown',
                    status: 'done',
                    votes: 5,
                    excerpt: 'Download a whole Space as a zip of Markdown files.',
                },
            ],
        },
        [12_800, 13_000, 13_300],
    );
    tool(
        `call-pages-${runId}`,
        'search_space_pages',
        { query: 'CSV export' },
        {
            results: [
                {
                    id: 'page-exports',
                    spaceId: 'space-ops',
                    title: 'Data exports',
                    excerpt: 'The nightly **CSV** **export** writes one file per week…',
                    edited: 'Edited 3 days ago',
                },
            ],
            total: 1,
        },
        [13_500, 13_700, 14_100],
    );
    tool(
        `call-read-${runId}`,
        'read_space_page',
        { id: 'page-exports' },
        {
            id: 'page-exports',
            title: 'Data exports',
            revision: 7,
            content:
                '# Data exports\n\nThe nightly CSV export writes one file per week to `reports/`, from the orders table. Run `reports/export_week.py --week N` to build one by hand.\n\n## Columns\n\n- date\n- orders\n- revenue',
        },
        [14_300, 14_500, 14_700],
    );
    reasoning(
        `think-2-${runId}`,
        14_900,
        18_900,
        'The page says the script builds a week’s file by hand. I’ll run it for week 41 in my computer and read the output.',
    );
    tool(
        `call-exec-${runId}`,
        'computer_exec',
        {
            command: 'cd reports\npython3 export_week.py --week 41 --format csv\nwc -l week-41.csv',
            timeoutMs: 30000,
        },
        {
            stdout: 'date,orders,revenue\n2026-10-05,38,2890.00\n2026-10-06,41,3120.50\n2026-10-07,35,2604.25\n2026-10-08,44,3398.00\n2026-10-09,52,4011.75\n2026-10-10,29,2187.00\n2026-10-11,24,1802.50\nWrote 7 rows to week-41.csv\n8 week-41.csv\n',
            stderr: '',
            exitCode: 0,
        },
        [19_000, 19_600, 27_400],
    );
    tool(
        `call-query-${runId}`,
        'data_query',
        {
            sql: 'SELECT week, SUM(revenue) AS revenue\nFROM weekly_sales\nGROUP BY week\nORDER BY week DESC\nLIMIT 4',
        },
        { error: 'no such table: weekly_sales' },
        [27_600, 27_900, 28_000],
    );
    reasoning(
        `think-3-${runId}`,
        28_200,
        31_200,
        'There is no weekly history to compare with. I’ll give the week’s numbers and say so.',
    );
    at(31_400, {
        type: 'TEXT_MESSAGE_START',
        messageId: reply,
        role: 'assistant',
    });
    at(31_500, {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: reply,
        delta: [
            'The CSV export runs every night and writes one file per week to `reports/` (see **Data exports**). The board already tracks one problem with it: CB-41, the header row going missing.',
            '',
            'Last week (week 41):',
            '',
            '| Day | Orders | Revenue |',
            '|---|---:|---:|',
            '| Mon | 38 | 2,890.00 |',
            '| Tue | 41 | 3,120.50 |',
            '| Wed | 35 | 2,604.25 |',
            '| Thu | 44 | 3,398.00 |',
            '| Fri | 52 | 4,011.75 |',
            '| Sat | 29 | 2,187.00 |',
            '| Sun | 24 | 1,802.50 |',
            '',
            'I couldn’t compare it with earlier weeks: your scratch dataset has no weekly_sales table yet.',
        ].join('\n'),
    });
    at(40_800, { type: 'TEXT_MESSAGE_END', messageId: reply });
    at(41_000, { type: 'RUN_FINISHED', threadId, runId });
    return events.map(([ms, event]) => (timed ? { ...event, timestamp: startedAt + ms } : event) as BaseEvent);
}
