import type { Message } from '@ag-ui/core';

import type { HistoryPage, HistoryRun } from '@socio/shared/chat/chat-history';

/**
 * A conversation's history as the server serves it (CB-136), for client
 * tests: finished runs by sequence number, each naming the one before,
 * paged as `GET /conversations/:id/history` pages them (by `page` runs).
 */
export class FakeHistory {
    runs: HistoryRun[] = [];
    /** The queries asked, in order (`''`, `after=3`, `before=2`). */
    asked: string[] = [];
    /** Full results by call id, for `/tool-results/:id`. */
    results = new Map<string, string>();
    constructor(public page = 3) {}

    /** Adds a finished run with these messages (a turn: question, answer). */
    add(messages: Message[], extra: Partial<HistoryRun> = {}) {
        const seq = (this.runs.at(-1)?.seq ?? 0) + 10;
        const run: HistoryRun = {
            seq,
            prev: this.runs.at(-1)?.seq ?? null,
            runId: `run-${seq}`,
            status: 'finished',
            startedAt: seq * 1000,
            finishedAt: seq * 1000 + 500,
            messages,
            times: { messages: [], tools: [], reasoning: [] },
            light: {},
            size: JSON.stringify(messages).length,
            ...extra,
        };
        this.runs.push(run);
        return run;
    }

    /** A question and its answer, `n`. */
    turn(n: number, extra: Partial<HistoryRun> = {}) {
        return this.add(
            [
                { id: `u${n}`, role: 'user', content: `Question ${n}` },
                { id: `a${n}`, role: 'assistant', content: `Answer ${n}` },
            ],
            extra,
        );
    }

    answer(query: string): HistoryPage {
        this.asked.push(query);
        const params = new URLSearchParams(query);
        const after = params.get('after');
        const before = params.get('before');
        if (after !== null) {
            const next = this.runs.filter((run) => run.seq > Number(after));
            return { runs: next.slice(0, this.page), more: next.length > this.page };
        }
        const older = this.runs.filter((run) => before === null || run.seq < Number(before));
        return { runs: older.slice(-this.page), more: false };
    }

    /** Answers `/api/conversations/<thread>/…` paths; undefined for others. */
    respond(url: string, thread: string): Response | undefined {
        const parsed = new URL(url, 'http://app.test');
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
        if (parsed.pathname === `/api/conversations/${thread}/history`) {
            return json(this.answer(parsed.search.slice(1)));
        }
        const result = new RegExp(`^/api/conversations/${thread}/tool-results/([^/]+)$`).exec(parsed.pathname);
        if (result) {
            const content = this.results.get(decodeURIComponent(result[1]));
            return content === undefined ? json({ error: 'Not stored.' }, 404) : json({ content });
        }
        return undefined;
    }
}
