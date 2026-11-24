import { redactSocioTokens } from '@socio/foundation/actors/redact';
import { inertText } from '@socio/shared/text/inert-text';

import type { HarnessOutput } from './harness-port.js';

/**
 * What every harness's reader shares (CB-326): a run's stdout is the
 * agent's, untrusted. Each reader reads its CLI's JSON lines tolerantly;
 * every string it keeps is stripped of anything shaped like a Socio
 * credential and made inert before it is stored or shown, and it keeps
 * the same few things: progress lines, the final message, the harness's
 * own session id.
 */

/** Progress lines kept per run, and each line's length. */
export const PROGRESS_LINES = 12;
export const LINE_MAX = 240;
/** The final message's length, for the person and the socio. */
export const SUMMARY_MAX = 8_000;
/** How much of the newest output is read for progress. */
export const TAIL_BYTES = 256 * 1024;

/** One line for people: redacted, inert, one line, at most `max`. */
export const clean = (text: string, max: number) =>
    inertText(redactSocioTokens(text, { envelopes: true }).trim(), {
        max,
        lines: false,
    });

export const str = (value: unknown) => (typeof value === 'string' ? value : '');
export const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A text's first non-blank line. */
export const firstLine = (text: string) => text.split('\n').find((line) => line.trim()) ?? '';

/** A UUID, the shape Codex's thread ids and Claude Code's session ids take. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The newest lines of stdout (the supervisor keeps its last 4 MB), each
 * parsed as a JSON object where it is one, else kept as plain text. A
 * line cut off at the start of the window is not an event.
 */
export function outputLines(stdout: string): Array<{ event?: Record<string, unknown>; line: string }> {
    const tail = stdout.length > TAIL_BYTES ? stdout.slice(stdout.length - TAIL_BYTES) : stdout;
    const lines = tail.split('\n');
    if (stdout.length > TAIL_BYTES) {
        lines.shift();
    }
    const out: Array<{ event?: Record<string, unknown>; line: string }> = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        let event: Record<string, unknown> | undefined;
        if (line.startsWith('{')) {
            try {
                event = obj(JSON.parse(line));
            } catch {
                event = undefined;
            }
        }
        out.push(event ? { event, line } : { line });
    }
    return out;
}

/** The reader's result: progress cleaned and capped, the summary redacted and inert. */
export function harnessOutput(
    progress: string[],
    summary: string,
    sessionId: string | undefined,
    errored: boolean,
): HarnessOutput {
    return {
        progress: progress
            .map((line) => clean(line, LINE_MAX))
            .filter(Boolean)
            .slice(-PROGRESS_LINES),
        summary: inertText(redactSocioTokens(summary, { envelopes: true }).trim(), {
            max: SUMMARY_MAX,
        }),
        ...(sessionId ? { sessionId } : {}),
        errored,
    };
}
