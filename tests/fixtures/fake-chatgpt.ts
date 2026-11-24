import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An unsigned JWT-shaped token: only its payload matters to the client. */
export function fakeJwt(payload: Record<string, unknown>) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.${randomBytes(16).toString('base64url')}`;
}

export const FAKE_EMAIL = 'someone@example.test';
export const FAKE_NAME = 'Fake Person';
export const FAKE_ACCOUNT = 'acct-fixture-0001';

export interface RecordedRequest {
    path: string;
    headers: IncomingHttpHeaders;
    body: string;
    /** When it arrived (ms). */
    at: number;
}

/** A scripted reply from the Responses endpoint, with headers (`Retry-After`). */
export type ResponsesReply =
    | { events: Record<string, unknown>[] }
    | { status: number; body: unknown; headers?: Record<string, string> };

const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/**
 * An in-process stand-in for auth.openai.com and chatgpt.com's Codex
 * backend on loopback: the device-code endpoints, the token endpoint
 * (authorization code and rotating, single-use refresh tokens), revoke, and
 * `/backend-api/codex/responses`, which accepts only the current access
 * token and replays scripted SSE replies. Every request is recorded.
 * `port` fixes the port (local smoke runs, `serve-fake-chatgpt.ts`).
 */
export async function startFakeChatGpt(options: { port?: number } = {}) {
    const requests: RecordedRequest[] = [];
    const state = {
        /** What the device token poll answers. */
        device: 'pending' as 'pending' | 'approved' | 'denied',
        deviceCode: 'device-auth-fixture',
        userCode: 'ABCD-1234',
        authorizationCode: 'authz-code-fixture',
        codeVerifier: 'verifier-fixture',
        planType: 'plus',
        /** Access token lifetime in seconds. */
        accessTtl: 3600,
        /** The refresh tokens that still work (each works once). */
        refreshTokens: new Set<string>(),
        accessTokens: new Set<string>(),
        refreshCount: 0,
        /** Delay refresh answers, to overlap concurrent callers. */
        refreshDelayMs: 0,
        /** Answer the next refreshes with this error body (400). */
        refreshError: undefined as string | undefined,
        /** Account in the ID token of the next refreshes. */
        refreshAccount: FAKE_ACCOUNT,
        revoked: [] as string[],
        replies: [] as ResponsesReply[],
        /** Answers the Responses endpoint when no reply is scripted (smoke runs). */
        autoReply: undefined as (() => ResponsesReply) | undefined,
    };

    const issue = (account = FAKE_ACCOUNT) => {
        const auth = {
            chatgpt_account_id: account,
            chatgpt_plan_type: state.planType,
            chatgpt_user_id: 'user-fixture',
        };
        const accessToken = fakeJwt({
            exp: Math.floor(Date.now() / 1000) + state.accessTtl,
            'https://api.openai.com/auth': auth,
        });
        const refreshToken = `rt_${randomBytes(24).toString('base64url')}`;
        state.accessTokens.add(accessToken);
        state.refreshTokens.add(refreshToken);
        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            id_token: fakeJwt({
                email: FAKE_EMAIL,
                name: FAKE_NAME,
                'https://api.openai.com/profile': { email: FAKE_EMAIL },
                'https://api.openai.com/auth': auth,
            }),
        };
    };

    const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
    };

    const server = createServer(async (req, res) => {
        const body = await read(req);
        const path = new URL(req.url ?? '/', 'http://fake').pathname;
        requests.push({ path, headers: req.headers, body, at: Date.now() });
        if (req.method !== 'POST') {
            return json(res, 405, {});
        }

        if (path === '/api/accounts/deviceauth/usercode') {
            // Each sign-in gets an authorization code of its own.
            if (state.authorizationCode === 'spent') {
                state.authorizationCode = 'authz-code-fixture';
            }
            return json(res, 200, {
                device_auth_id: state.deviceCode,
                user_code: state.userCode,
                interval: '1',
            });
        }

        if (path === '/api/accounts/deviceauth/token') {
            if (state.device === 'pending') {
                return json(res, 403, { error: 'authorization_pending' });
            }
            if (state.device === 'denied') {
                return json(res, 400, { error: 'access_denied' });
            }
            return json(res, 200, {
                authorization_code: state.authorizationCode,
                code_challenge: 'challenge-fixture',
                code_verifier: state.codeVerifier,
            });
        }

        if (path === '/oauth/token') {
            const form = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded');
            const params: Record<string, string> = form
                ? Object.fromEntries(new URLSearchParams(body))
                : (JSON.parse(body) as Record<string, string>);
            if (params.grant_type === 'authorization_code') {
                if (params.code !== state.authorizationCode || params.code_verifier !== state.codeVerifier) {
                    return json(res, 400, { error: 'invalid_grant' });
                }
                state.authorizationCode = 'spent';
                return json(res, 200, issue());
            }
            if (params.grant_type === 'refresh_token') {
                state.refreshCount += 1;
                if (state.refreshDelayMs) {
                    await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
                }
                if (state.refreshError) {
                    return json(res, 400, {
                        error: state.refreshError,
                        error_description: 'refresh rejected',
                    });
                }
                if (!state.refreshTokens.delete(params.refresh_token)) {
                    return json(res, 400, { error: 'refresh_token_reused' });
                }
                return json(res, 200, issue(state.refreshAccount));
            }
            return json(res, 400, { error: 'unsupported_grant_type' });
        }

        if (path === '/oauth/revoke') {
            const params = JSON.parse(body) as Record<string, string>;
            state.revoked.push(params.token);
            state.refreshTokens.delete(params.token);
            return json(res, 200, {});
        }

        if (path === '/backend-api/codex/responses') {
            const token = req.headers.authorization?.replace(/^Bearer /, '');
            if (!token || !state.accessTokens.has(token)) {
                return json(res, 401, { error: { code: 'token_expired' } });
            }
            const reply = state.replies.shift() ?? state.autoReply?.();
            if (!reply) {
                return json(res, 500, { error: { code: 'no_reply' } });
            }
            if ('status' in reply) {
                return json(res, reply.status, reply.body, reply.headers);
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const event of reply.events) {
                res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
            }
            return res.end();
        }

        json(res, 404, {});
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    return {
        state,
        requests,
        issue,
        endpoints: { issuer: base, codexBaseUrl: `${base}/backend-api/codex` },
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/**
 * SSE events for a reasoning item with a readable summary (output 0); a
 * summary in several parts (`string[]`) streams each as its own part.
 */
const summaryParts = (summary: string | string[]) => (Array.isArray(summary) ? summary : [summary]);
/** The finished reasoning item of `summaryEvents`. */
const summaryItem = (summary: string | string[]) => ({
    type: 'reasoning',
    id: 'rs_1',
    summary: summaryParts(summary).map((text) => ({
        type: 'summary_text',
        text,
    })),
    encrypted_content: 'enc-fake-reasoning',
});
function summaryEvents(summary: string | string[]) {
    const parts = summaryParts(summary);
    const item = summaryItem(summary);
    return [
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_1', summary: [] },
        },
        ...parts.flatMap((text, index) => [
            {
                type: 'response.reasoning_summary_part.added',
                item_id: 'rs_1',
                output_index: 0,
                summary_index: index,
                part: { type: 'summary_text', text: '' },
            },
            {
                type: 'response.reasoning_summary_text.delta',
                item_id: 'rs_1',
                output_index: 0,
                summary_index: index,
                delta: text,
            },
            {
                type: 'response.reasoning_summary_text.done',
                item_id: 'rs_1',
                output_index: 0,
                summary_index: index,
                text,
            },
        ]),
        { type: 'response.output_item.done', output_index: 0, item },
    ];
}

/**
 * SSE events for one plain text answer, as the Responses API streams it;
 * with `summary`, a reasoning summary streams first.
 */
export function textReply(text: string, id = 'resp_1', options: { summary?: string | string[] } = {}) {
    const at = options.summary ? 1 : 0;
    const message = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
    const half = Math.ceil(text.length / 2);
    return {
        events: [
            { type: 'response.created', response: { id, model: 'gpt-6.1-sol' } },
            ...(options.summary ? summaryEvents(options.summary) : []),
            {
                type: 'response.output_item.added',
                output_index: at,
                item: { ...message, status: 'in_progress', content: [] },
            },
            {
                type: 'response.content_part.added',
                output_index: at,
                content_index: 0,
                item_id: 'msg_1',
                part: { type: 'output_text', text: '' },
            },
            {
                type: 'response.output_text.delta',
                output_index: at,
                content_index: 0,
                item_id: 'msg_1',
                delta: text.slice(0, half),
            },
            {
                type: 'response.output_text.delta',
                output_index: at,
                content_index: 0,
                item_id: 'msg_1',
                delta: text.slice(half),
            },
            { type: 'response.output_item.done', output_index: at, item: message },
            {
                type: 'response.completed',
                response: {
                    id,
                    model: 'gpt-6.1-sol',
                    status: 'completed',
                    output: options.summary ? [summaryItem(options.summary), message] : [message],
                    usage: {
                        input_tokens: 42,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens: 7,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 49,
                    },
                },
            },
        ],
    };
}

/** SSE events for one function call. */
export function toolCallReply(name: string, args: unknown, callId = 'call_1') {
    const item = {
        type: 'function_call',
        id: 'fc_1',
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
        status: 'completed',
    };
    return {
        events: [
            {
                type: 'response.created',
                response: { id: 'resp_tool', model: 'gpt-6.1-sol' },
            },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...item, arguments: '', status: 'in_progress' },
            },
            {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                item_id: 'fc_1',
                delta: item.arguments,
            },
            {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: 'fc_1',
                arguments: item.arguments,
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_tool',
                    model: 'gpt-6.1-sol',
                    status: 'completed',
                    output: [item],
                    usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
                },
            },
        ],
    };
}

/**
 * SSE events for a function call the backend's output limit cut off: its
 * arguments stop part way and the response ends `incomplete` for
 * `max_output_tokens` (CB-126).
 */
export function cutOffReply(name: string, partialArgs: string, callId = 'call_cut') {
    const item = {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: partialArgs,
        status: 'incomplete',
    };
    return {
        events: [
            {
                type: 'response.created',
                response: { id: 'resp_cut', model: 'gpt-6.1-sol' },
            },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...item, arguments: '', status: 'in_progress' },
            },
            {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                item_id: item.id,
                delta: partialArgs,
            },
            {
                type: 'response.incomplete',
                response: {
                    id: 'resp_cut',
                    model: 'gpt-6.1-sol',
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    output: [item],
                    usage: { input_tokens: 30, output_tokens: 128, total_tokens: 158 },
                },
            },
        ],
    };
}
