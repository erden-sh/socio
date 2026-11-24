import type { OutboxState } from './outbox';

// The outbox's rows counted by state, and the refused writes: what
// Diagnostics shows on one line for perf/kill-send.mjs, which reads it after
// a run. A row only counts here, so nothing the person wrote shows. The
// harness parses the line itself (`parseOutboxTally`); the two are held
// together by tests/perf/kill-send.test.ts.

export interface OutboxTally {
    readonly queued: number;
    readonly inflight: number;
    readonly unknown: number;
    readonly held: number;
    readonly sent: number;
    /** Refused writes, in the Unsent list. */
    readonly unsent: number;
}

const STATES: readonly OutboxState[] = ['queued', 'inflight', 'unknown', 'held', 'sent'];

/** The rows by state; a state this build doesn't know counts as `unknown`. */
export function outboxTally(rows: readonly { readonly state: string }[], unsent: number): OutboxTally {
    const counts: Record<OutboxState, number> = { queued: 0, inflight: 0, unknown: 0, held: 0, sent: 0 };
    for (const row of rows) {
        const state = (STATES as readonly string[]).includes(row.state) ? (row.state as OutboxState) : 'unknown';
        counts[state] += 1;
    }
    return { ...counts, unsent };
}

/** Diagnostics' line: "Outbox: queued 0 · inflight 0 · unknown 0 · held 0 · sent 0 · unsent 0". */
export function outboxTallyLine(tally: OutboxTally): string {
    return `Outbox: ${[...STATES, 'unsent' as const].map((key) => `${key} ${tally[key]}`).join(' · ')}`;
}
