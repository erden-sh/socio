import { firstLine, harnessOutput, obj, outputLines, str, UUID } from './harness-output.js';
import type { CodingHarness, HarnessOutput } from './harness-port.js';

/**
 * What `gemini --output-format stream-json` printed (CB-326), read
 * into progress lines, the agent's final message and the Gemini CLI session
 * id to continue with `--resume <id>`. Gemini CLI prints one JSON event per
 * line: `init` (`session_id`, `model`), `message` (`role` user or
 * assistant; an assistant's text comes as `delta: true` pieces),
 * `tool_use` (`tool_name`, `tool_id`, `parameters`), `tool_result`
 * (`tool_id`, `status` success or error, `output`, `error`), `error`
 * (`severity` warning or error, `message`: not fatal by itself) and, last,
 * `result` (`status` success or error, an `error` with its `message`, and
 * `stats`). The shapes are a live check, so this reads them tolerantly and
 * never trusts them: as for OpenCode, every string is the agent's, redacted
 * and made inert.
 */

/** A tool use's line: the tool and the one parameter that says most. */
function toolLine(event: Record<string, unknown>) {
    const input = obj(event.parameters);
    const detail =
        str(input.description) ||
        str(input.command) ||
        str(input.file_path) ||
        str(input.absolute_path) ||
        str(input.dir_path) ||
        str(input.path) ||
        str(input.pattern) ||
        str(input.query) ||
        str(input.url);
    return `${str(event.tool_name) || 'tool'}${detail ? `: ${firstLine(detail)}` : ''}`;
}

/** Reads an exec's stdout so far (the supervisor keeps its last 4 MB). */
export function readGeminiCli(stdout: string): HarnessOutput {
    const progress: string[] = [];
    // Each tool's line, by its id, to mark the ones that failed.
    const lineOf = new Map<string, number>();
    const texts: string[] = [];
    // The assistant's message being streamed, piece by piece; a tool use or
    // the result ends it.
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
    for (const { event, line } of outputLines(stdout)) {
        if (!event) {
            progress.push(line);
            continue;
        }
        const type = str(event.type);
        if (type === 'init') {
            const session = str(event.session_id);
            if (UUID.test(session)) {
                sessionId = session;
            }
            continue;
        }
        if (type === 'message') {
            if (str(event.role) !== 'assistant') {
                continue;
            }
            if (event.delta === true) {
                current += str(event.content);
            } else {
                endMessage();
                current = str(event.content);
                endMessage();
            }
            continue;
        }
        if (type === 'tool_use') {
            endMessage();
            const id = str(event.tool_id);
            if (id) {
                lineOf.set(id, progress.length);
            }
            progress.push(toolLine(event));
            continue;
        }
        if (type === 'tool_result') {
            const at = lineOf.get(str(event.tool_id));
            if (str(event.status) === 'error' && at !== undefined) {
                progress[at] = `${progress[at]} (failed)`;
            }
            continue;
        }
        if (type === 'error') {
            const message = str(event.message) || 'Gemini CLI reported an error';
            const severity = str(event.severity) === 'warning' ? 'warning' : 'error';
            progress.push(`${severity}: ${message}`);
            if (severity === 'error') {
                lastError = `error: ${message}`;
            }
            continue;
        }
        if (type === 'result') {
            endMessage();
            if (str(event.status) && str(event.status) !== 'success') {
                errored = true;
                const message = str(obj(event.error).message);
                lastError = message ? `error: ${message}` : lastError || 'error: Gemini CLI reported an error';
                progress.push(lastError);
            }
        }
    }
    endMessage();
    const summary = errored ? lastError || texts.at(-1) || '' : (texts.at(-1) ?? lastError);
    return harnessOutput(progress, summary, sessionId, errored);
}

/**
 * Gemini CLI as a coding harness (CB-326), on the gateway route:
 * the supervisor's `prompt` exec runs `gemini` headless with
 * `GOOGLE_GEMINI_BASE_URL` at the gateway, which serves the Gemini API's
 * `generateContent` and `streamGenerateContent` for coding sessions, and
 * the session's token as its API key; no Google login, its telemetry,
 * usage statistics, updates, MCP servers and web tools off by a root-owned
 * system settings file, every tool approved (the sandbox container is the
 * boundary), and the prompt on stdin. A session's first prompt starts a
 * Gemini CLI session; later ones resume the session id its output named
 * (a UUID).
 */
export const geminiCliHarness: CodingHarness = {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    image: { name: 'socio-coding', pin: 'deployment/coding/gemini-cli.pin' },
    modelRoute: 'gateway',
    // It speaks the Gemini API; a person's plan takes the Responses API only.
    personalPlans: false,
    terms: {
        plans: 'Models through Socio’s gateway (the Gemini API): no Google sign-in, no Gemini or Code Assist plan in the sandbox.',
        checkedAt: null,
        url: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md',
    },
    command: (run) => ({
        kind: 'prompt',
        params: {
            harness: 'gemini-cli',
            ...(UUID.test(run.session) ? { session: run.session } : {}),
            model: run.model,
            prompt: run.prompt,
            seconds: run.seconds,
            identity: run.identity,
        },
    }),
    read: readGeminiCli,
};
