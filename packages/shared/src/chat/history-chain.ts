import type { Message } from '@ag-ui/core';

import type { HistoryRun } from './chat-history.js';

/**
 * How a client keeps and shows a chat's history (CB-136), the same on the
 * web and in the app: the runs a store may show, where it keeps them, and
 * how the live turn is laid over them. The stores themselves are the
 * clients' own.
 */

/**
 * The shape of the runs kept. A release that changes it bumps this: what
 * older releases kept is then never read, and the bound clears it out.
 */
export const HISTORY_FORMAT = 1;
/** Where a chat's runs are kept in the store. */
export const historyScope = (threadId: string) => `chat:${HISTORY_FORMAT}:${threadId}`;

/**
 * The runs of `rows` that chain down from the newest without a gap,
 * oldest first: what a store may show.
 */
export function chained(rows: readonly HistoryRun[]): HistoryRun[] {
    const sorted = [...rows].sort((a, b) => b.seq - a.seq);
    const chain: HistoryRun[] = [];
    for (const run of sorted) {
        const last = chain.at(-1);
        if (last && last.prev !== run.seq) {
            break;
        }
        chain.push(run);
    }
    return chain.reverse();
}

/** Whether a run ended with a tool call that has no result yet. */
export function waitsOnTool(run: HistoryRun) {
    const answered = new Set(run.messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : [])));
    return run.messages.some(
        (message) => message.role === 'assistant' && (message.toolCalls ?? []).some((call) => !answered.has(call.id)),
    );
}

/**
 * The messages a chat shows (CB-136): its synced runs' messages in order,
 * each as the agent has it if it does (whole results), then what the
 * agent has that no run holds yet (the live turn, a run not yet pulled).
 * `light` is the tool results still shown as a preview, by call id.
 */
export function mergeHistory(
    runs: readonly HistoryRun[],
    live: readonly Message[],
): { messages: Message[]; light: Map<string, number> } {
    const light = new Map<string, number>();
    if (!runs.length) {
        return { messages: [...live], light };
    }
    const agent = new Map(live.map((message) => [message.id, message]));
    const messages: Message[] = [];
    const placed = new Set<string>();
    for (const run of runs) {
        for (const message of run.messages) {
            if (placed.has(message.id)) {
                continue;
            }
            placed.add(message.id);
            const shown = agent.get(message.id);
            messages.push(shown ?? message);
            if (!shown && message.role === 'tool' && run.light[message.toolCallId]) {
                light.set(message.toolCallId, run.light[message.toolCallId]);
            }
        }
    }
    for (const message of live) {
        if (!placed.has(message.id)) {
            messages.push(message);
        }
    }
    return { messages, light };
}
