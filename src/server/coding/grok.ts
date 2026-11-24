import { firstLine, harnessOutput, obj, outputLines, str, UUID } from './harness-output.js';
import type { CodingHarness, HarnessOutput } from './harness-port.js';

/**
 * What `grok --output-format streaming-json` printed (CB-326), read
 * into progress lines, the agent's final message and the Grok Build session
 * id to continue with `--resume <id>`. Grok Build prints one `type`-tagged
 * JSON object per line, from its agent's ACP session updates: `thought`
 * (reasoning, never shown), `text` (a piece of the agent's message, in
 * `data`), `tool_call` (`toolCallId`, `title`, `kind`, `status`,
 * `toolName`, `rawInput`), `tool_call_update` (`toolCallId`, `status`),
 * `usage`, `end` (`stopReason`, `sessionId`) and `error` (`message`). The
 * shapes are a live check, so this reads them tolerantly and never trusts
 * them: as for OpenCode, every string is the agent's, redacted and made
 * inert.
 */

/** A tool call's line: its title or tool, and the one input field that says most. */
function toolLine(event: Record<string, unknown>) {
    const input = obj(event.rawInput);
    const detail =
        str(input.description) ||
        str(input.command) ||
        str(input.cmd) ||
        str(input.file_path) ||
        str(input.target_file) ||
        str(input.path) ||
        str(input.pattern) ||
        str(input.query) ||
        str(input.url);
    const name = str(event.title) || str(event.toolName) || 'tool';
    return `${name}${detail && !name.includes(firstLine(detail)) ? `: ${firstLine(detail)}` : ''}`;
}

/** Reads an exec's stdout so far (the supervisor keeps its last 4 MB). */
export function readGrok(stdout: string): HarnessOutput {
    const progress: string[] = [];
    // Each tool call's line and what it said, by its id, for its updates.
    const calls = new Map<string, { at: number; line: string }>();
    const texts: string[] = [];
    // The agent's message being streamed; a tool call or the end ends it.
    let current = '';
    let sessionId: string | undefined;
    let errored = false;
    let lastError = '';
    const endMessage = () => {
        if (current.trim()) {
            texts.push(current);
            progress.push(firstLine(current));
        }
        current = '';
    };
    const failed = (status: string) => status === 'failed' || status === 'error';
    for (const { event, line } of outputLines(stdout)) {
        if (!event) {
            progress.push(line);
            continue;
        }
        const session = str(event.sessionId) || str(event.session_id);
        if (UUID.test(session)) {
            sessionId = session;
        }
        const type = str(event.type);
        if (type === 'text') {
            current += str(event.data);
            continue;
        }
        if (type === 'tool_call') {
            endMessage();
            const shown = toolLine(event);
            const id = str(event.toolCallId);
            const known = id ? calls.get(id) : undefined;
            const text = failed(str(event.status)) ? `${shown} (failed)` : shown;
            if (known) {
                progress[known.at] = text;
                known.line = shown;
            } else {
                if (id) {
                    calls.set(id, { at: progress.length, line: shown });
                }
                progress.push(text);
            }
            continue;
        }
        if (type === 'tool_call_update') {
            const known = calls.get(str(event.toolCallId));
            if (known && failed(str(event.status))) {
                progress[known.at] = `${known.line} (failed)`;
            }
            continue;
        }
        if (type === 'error') {
            errored = true;
            lastError = `error: ${str(event.message) || str(obj(event.error).message) || 'Grok Build reported an error'}`;
            progress.push(lastError);
            continue;
        }
        if (type === 'end') {
            endMessage();
            const reason = str(event.stopReason);
            if (reason === 'refusal' || reason === 'error') {
                errored = true;
                lastError = `error: Grok Build stopped (${reason})`;
                progress.push(lastError);
            }
        }
    }
    endMessage();
    const summary = errored ? lastError || texts.at(-1) || '' : (texts.at(-1) ?? '');
    return harnessOutput(progress, summary, sessionId, errored);
}

/**
 * Grok Build (`grok`, xAI's coding agent) as a coding harness (CB-326),
 * on the gateway route: the supervisor's `prompt` exec runs
 * `grok` headless through grok-socio, which writes its config.toml for the
 * run: one model on the gateway's Responses API (the wire API Grok Build
 * itself uses for xAI's models), its key the session's token; no xAI login, update checks, telemetry, feedback,
 * memory and web search off, every tool approved (the sandbox container is
 * the boundary), and the prompt read from stdin. A session's first prompt
 * starts a Grok Build session; later ones resume the session id its output
 * named (a UUID).
 */
export const grokHarness: CodingHarness = {
    id: 'grok',
    label: 'Grok Build',
    image: { name: 'socio-coding', pin: 'deployment/coding/grok.pin' },
    modelRoute: 'gateway',
    // It speaks Responses, but a person's plan takes only the Codex CLI's
    // request shape (through the ChatGPT plan's backend): not offered.
    personalPlans: false,
    terms: {
        plans: 'Models through Socio’s gateway (Responses API): no xAI sign-in, no Grok or SuperGrok plan in the sandbox.',
        checkedAt: null,
        url: 'https://x.ai/legal/terms-of-service',
    },
    command: (run) => ({
        kind: 'prompt',
        params: {
            harness: 'grok',
            ...(UUID.test(run.session) ? { session: run.session } : {}),
            model: run.model,
            prompt: run.prompt,
            seconds: run.seconds,
            identity: run.identity,
        },
    }),
    read: readGrok,
};
