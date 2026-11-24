import { redactSocioTokens } from '@socio/foundation/actors/redact';
import { inertText } from '@socio/shared/text/inert-text';

import { clean, LINE_MAX, obj, PROGRESS_LINES, str, SUMMARY_MAX, TAIL_BYTES } from './harness-output.js';
import type { CodingHarness, HarnessOutput } from './harness-port.js';

/**
 * What `opencode run --format json` printed (CB-239), read
 * into the few things Socio shows: progress lines while it runs, the
 * agent's final message once it ends, and the OpenCode session id to
 * continue next time. OpenCode prints one JSON event per line (text
 * parts, tool uses, step ends, errors); anything else is a plain line.
 * The exact event shapes are a live check, so this reads them tolerantly
 * and never trusts them: every string is the agent's, untrusted, made
 * inert and stripped of anything shaped like a Socio credential before it
 * is stored or shown.
 */

export { PROGRESS_LINES, SUMMARY_MAX } from './harness-output.js';

/** OpenCode's output, read; `sessionId` is the OpenCode session. */
export type OpenCodeOutput = HarnessOutput;

/** One event's line for people, or undefined for events not worth one. */
function eventLine(event: Record<string, unknown>): string | undefined {
    const part = obj(event.part);
    const type = str(event.type) || str(part.type);
    if (type === 'text') {
        return undefined;
    }
    if (type === 'tool_use' || type === 'tool') {
        const state = obj(part.state);
        const tool = str(part.tool) || str(event.tool) || 'tool';
        const title = str(state.title) || str(part.title);
        const status = str(state.status);
        return `${tool}${title ? `: ${title}` : ''}${status && status !== 'completed' ? ` (${status})` : ''}`;
    }
    if (type === 'error') {
        const error = obj(event.error);
        return `error: ${str(error.message) || str(obj(error.data).message) || str(event.message) || 'OpenCode reported an error'}`;
    }
    return undefined;
}

/** Reads an exec's stdout so far (the supervisor keeps its last 4 MB). */
export function readOpenCode(stdout: string): OpenCodeOutput {
    const tail = stdout.length > TAIL_BYTES ? stdout.slice(stdout.length - TAIL_BYTES) : stdout;
    const lines = tail.split('\n');
    // A cut-off first line is not an event.
    if (stdout.length > TAIL_BYTES) {
        lines.shift();
    }
    const progress: string[] = [];
    const texts: string[] = [];
    let sessionId: string | undefined;
    let errored = false;
    let lastError = '';
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
        if (!event) {
            progress.push(clean(line, LINE_MAX));
            continue;
        }
        const part = obj(event.part);
        const session = str(event.sessionID) || str(part.sessionID);
        if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(session)) {
            sessionId = session;
        }
        const type = str(event.type) || str(part.type);
        if (type === 'text') {
            const text = str(part.text) || str(event.text);
            if (text.trim()) {
                texts.push(text);
                progress.push(clean(text.split('\n').find((l) => l.trim()) ?? '', LINE_MAX));
            }
            continue;
        }
        if (type === 'error') {
            errored = true;
            lastError = eventLine(event) ?? 'error';
        }
        const shown = eventLine(event);
        if (shown) {
            progress.push(clean(shown, LINE_MAX));
        }
    }
    const summary = texts.length ? texts.at(-1)! : lastError;
    return {
        progress: progress.filter(Boolean).slice(-PROGRESS_LINES),
        summary: inertText(redactSocioTokens(summary, { envelopes: true }).trim(), {
            max: SUMMARY_MAX,
        }),
        ...(sessionId ? { sessionId } : {}),
        errored,
    };
}

/**
 * OpenCode as a coding harness (CB-326): the port's first adapter
 * (harness.ts), with the behavior coding sessions always had. Its models
 * go through Socio's gateway; the supervisor's `prompt` exec runs
 * `opencode run --standalone --format json --session <id> --model
 * <provider>/<model> --auto` with the prompt on stdin.
 */
export const opencodeHarness: CodingHarness = {
    id: 'opencode',
    label: 'OpenCode',
    image: { name: 'socio-coding', pin: 'deployment/coding/opencode.pin' },
    modelRoute: 'gateway',
    personalPlans: true,
    terms: {
        plans: 'Models through Socio’s gateway (Chat Completions), and a person’s own ChatGPT plan through the gateway where allowed (the Responses API).',
        checkedAt: null,
        url: 'https://github.com/anomalyco/opencode/blob/dev/LICENSE',
    },
    command: (run) => ({
        kind: 'prompt',
        params: {
            session: run.session,
            model: run.model,
            prompt: run.prompt,
            seconds: run.seconds,
            identity: run.identity,
            // A person's own plan speaks the Responses API only.
            ...(run.plan ? { api: 'responses' as const } : {}),
        },
    }),
    read: readOpenCode,
};

/** `git diff --name-status` lines into paths (renames: the new path). */
export function changedPaths(output: string, max = 200): string[] {
    const paths: string[] = [];
    for (const line of output.split('\n')) {
        const fields = line.split('\t');
        if (fields.length < 2 || !/^[ACDMRTUX]\d*$/.test(fields[0]!)) {
            continue;
        }
        const path = fields.at(-1)!;
        if (path) {
            paths.push(clean(path, 400));
        }
        if (paths.length >= max) {
            break;
        }
    }
    return paths;
}

/** `git status --porcelain=v2 --branch`'s ahead and behind counts. */
export function aheadBehind(output: string) {
    const match = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(output);
    return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : undefined;
}
