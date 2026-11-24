import { firstLine, harnessOutput, obj, outputLines, str, UUID } from './harness-output.js';
import type { CodingHarness, HarnessOutput } from './harness-port.js';

/**
 * What `claude -p --output-format stream-json --verbose` printed (CB-326),
 * read into progress lines, the agent's final message and the
 * Claude Code session id to continue with `--resume <id>`. Claude Code
 * prints one JSON message per line: `system` (`init` carries the
 * `session_id`), `assistant` (a `message` whose `content` holds `text`,
 * `thinking` and `tool_use` blocks), `user` (tool results) and, last,
 * `result` (`subtype`, `is_error`, the final `result` text). The shapes
 * are a live check, so this reads them tolerantly and never trusts them:
 * as for OpenCode, every string is the agent's, redacted and made inert.
 */

/** A tool use's line: the tool and the one input field that says most. */
function toolLine(block: Record<string, unknown>) {
    const input = obj(block.input);
    const detail =
        str(input.description) ||
        str(input.command) ||
        str(input.file_path) ||
        str(input.notebook_path) ||
        str(input.pattern) ||
        str(input.path) ||
        str(input.url) ||
        str(input.query);
    return `${str(block.name) || 'tool'}${detail ? `: ${firstLine(detail)}` : ''}`;
}

/** Reads an exec's stdout so far (the supervisor keeps its last 4 MB). */
export function readClaudeCode(stdout: string): HarnessOutput {
    const progress: string[] = [];
    const texts: string[] = [];
    let result: string | undefined;
    let sessionId: string | undefined;
    let errored = false;
    let lastError = '';
    for (const { event, line } of outputLines(stdout)) {
        if (!event) {
            progress.push(line);
            continue;
        }
        const session = str(event.session_id);
        if (UUID.test(session)) {
            sessionId = session;
        }
        const type = str(event.type);
        if (type === 'assistant') {
            const content = obj(event.message).content;
            for (const block of Array.isArray(content) ? content.map(obj) : []) {
                const kind = str(block.type);
                if (kind === 'text' && str(block.text).trim()) {
                    texts.push(str(block.text));
                    progress.push(firstLine(str(block.text)));
                } else if (kind === 'tool_use') {
                    progress.push(toolLine(block));
                }
            }
            continue;
        }
        if (type === 'result') {
            if (event.is_error === true || (str(event.subtype) && str(event.subtype) !== 'success')) {
                errored = true;
                lastError = `error: ${str(event.result) || str(event.subtype) || 'Claude Code reported an error'}`;
                progress.push(lastError);
            } else if (str(event.result).trim()) {
                result = str(event.result);
            }
            continue;
        }
        if (type === 'error') {
            errored = true;
            lastError = `error: ${str(obj(event.error).message) || str(event.message) || 'Claude Code reported an error'}`;
            progress.push(lastError);
        }
    }
    const summary = errored ? lastError || texts.at(-1) || '' : (result ?? texts.at(-1) ?? '');
    return harnessOutput(progress, summary, sessionId, errored);
}

/**
 * Claude Code as a coding harness (CB-326), on the gateway route:
 * the supervisor's `prompt` exec runs `claude -p` with
 * `ANTHROPIC_BASE_URL` at the gateway's Messages endpoint and the
 * session's token as `ANTHROPIC_AUTH_TOKEN`, no Anthropic login, its
 * telemetry, auto-updater and other non-essential traffic off, permission
 * prompts off (the sandbox container is the boundary), and the prompt on
 * stdin. A session's first prompt starts a Claude Code session; later ones
 * resume the session id its output named (a UUID).
 */
export const claudeCodeHarness: CodingHarness = {
    id: 'claude-code',
    label: 'Claude Code',
    image: { name: 'socio-coding', pin: 'deployment/coding/claude-code.pin' },
    modelRoute: 'gateway',
    // It speaks the Messages API; a person's plan takes the Responses API only.
    personalPlans: false,
    terms: {
        plans: 'Models through Socio’s gateway (the Messages API): no Anthropic sign-in, no Claude subscription in the sandbox.',
        checkedAt: null,
        url: 'https://code.claude.com/docs/en/legal-and-compliance',
    },
    command: (run) => ({
        kind: 'prompt',
        params: {
            harness: 'claude-code',
            ...(UUID.test(run.session) ? { session: run.session } : {}),
            model: run.model,
            prompt: run.prompt,
            seconds: run.seconds,
            identity: run.identity,
        },
    }),
    read: readClaudeCode,
};
