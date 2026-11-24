import { firstLine, harnessOutput, obj, outputLines, str, UUID } from './harness-output.js';
import type { CodingHarness, HarnessOutput } from './harness-port.js';

/**
 * What `codex exec --json` printed (CB-326), read into progress
 * lines, the agent's final message and the Codex thread id to continue
 * with `codex exec resume <id>`. Codex prints one JSON event per line:
 * `thread.started` (its `thread_id`), `turn.started`, `item.started`,
 * `item.updated` and `item.completed` (an `item` with an `id` and a
 * `type`: `agent_message`, `reasoning`, `command_execution`,
 * `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`),
 * `turn.completed`, `turn.failed` and `error`. The shapes are a live
 * check, so this reads them tolerantly and never trusts them: as for
 * OpenCode, every string is the agent's, redacted and made inert.
 */

const statusNote = (item: Record<string, unknown>) => {
    const status = str(item.status);
    const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    if (status === 'failed' || status === 'declined') {
        return ` (${status}${exit !== undefined ? `, exit ${exit}` : ''})`;
    }
    if (status === 'in_progress') {
        return ' (running)';
    }
    return exit !== undefined && exit !== 0 ? ` (exit ${exit})` : '';
};

/** One item's line for people, or undefined for items not worth one. */
function itemLine(item: Record<string, unknown>): string | undefined {
    switch (str(item.type)) {
        case 'command_execution':
            return `$ ${str(item.command) || 'command'}${statusNote(item)}`;
        case 'file_change': {
            const changes = Array.isArray(item.changes) ? item.changes.map(obj) : [];
            const paths = changes.map(
                (change) => `${str(change.path)}${str(change.kind) ? ` (${str(change.kind)})` : ''}`,
            );
            return `edit: ${paths.filter(Boolean).join(', ') || 'files'}${statusNote(item)}`;
        }
        case 'mcp_tool_call':
            return `${[str(item.server), str(item.tool)].filter(Boolean).join('.') || 'tool'}${statusNote(item)}`;
        case 'web_search':
            return `search: ${str(item.query)}`;
        case 'todo_list': {
            const items = Array.isArray(item.items) ? item.items.map(obj) : [];
            return `plan: ${items.filter((entry) => entry.completed === true).length} of ${items.length} done`;
        }
        case 'error':
            return `error: ${str(item.message) || 'Codex reported an error'}`;
        default:
            return undefined;
    }
}

/** Reads an exec's stdout so far (the supervisor keeps its last 4 MB). */
export function readCodex(stdout: string): HarnessOutput {
    // Items in the order they started; a later event for the same id
    // replaces its line (a command that ran, then finished).
    const progress: string[] = [];
    const lineOf = new Map<string, number>();
    const texts: string[] = [];
    let sessionId: string | undefined;
    let errored = false;
    let lastError = '';
    for (const { event, line } of outputLines(stdout)) {
        if (!event) {
            progress.push(line);
            continue;
        }
        const type = str(event.type);
        if (type === 'thread.started') {
            const thread = str(event.thread_id);
            if (UUID.test(thread)) {
                sessionId = thread;
            }
            continue;
        }
        if (type === 'turn.failed' || type === 'error') {
            errored = true;
            lastError = `error: ${str(obj(event.error).message) || str(event.message) || 'Codex reported an error'}`;
            progress.push(lastError);
            continue;
        }
        if (!type.startsWith('item.')) {
            continue;
        }
        const item = obj(event.item);
        if (str(item.type) === 'agent_message') {
            const text = str(item.text);
            if (type === 'item.completed' && text.trim()) {
                texts.push(text);
                progress.push(firstLine(text));
            }
            continue;
        }
        const shown = itemLine(item);
        if (!shown) {
            continue;
        }
        const id = str(item.id);
        const at = id ? lineOf.get(id) : undefined;
        if (at !== undefined) {
            progress[at] = shown;
        } else {
            if (id) {
                lineOf.set(id, progress.length);
            }
            progress.push(shown);
        }
    }
    return harnessOutput(progress, texts.length ? texts.at(-1)! : lastError, sessionId, errored);
}

/**
 * Codex as a coding harness (CB-326), on the gateway route: the
 * supervisor's `prompt` exec runs `codex exec --json` with the gateway as
 * its only model provider (the Responses API, the session's token as the
 * provider's key), no OpenAI login, approvals and Codex's own sandbox off
 * (the sandbox container is the boundary), and the prompt on stdin. A
 * session's first prompt starts a thread; later ones resume the thread id
 * its output named (a UUID), so the placeholder a session starts with
 * means "new".
 */
export const codexHarness: CodingHarness = {
    id: 'codex',
    label: 'Codex',
    image: { name: 'socio-coding', pin: 'deployment/coding/codex.pin' },
    modelRoute: 'gateway',
    // Codex speaks the Responses API, which is all a person's plan takes.
    personalPlans: true,
    terms: {
        plans: 'Models through Socio’s gateway (the Responses API): no OpenAI sign-in, no ChatGPT plan in the sandbox. A person’s own ChatGPT plan, where allowed, is used through the gateway too.',
        checkedAt: null,
        url: 'https://openai.com/policies/terms-of-use/',
    },
    command: (run) => ({
        kind: 'prompt',
        params: {
            harness: 'codex',
            ...(UUID.test(run.session) ? { session: run.session } : {}),
            model: run.model,
            prompt: run.prompt,
            seconds: run.seconds,
            identity: run.identity,
        },
    }),
    read: readCodex,
};
