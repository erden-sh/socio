import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface BotCall {
    method: string;
    body: Record<string, unknown>;
}

/** An uploaded file, in place of its `attach://<id>` field. */
export interface BotUpload {
    filename: string;
    size: number;
    bytes: Buffer;
}

/**
 * A `multipart/form-data` body as grammY sends an `InputFile` upload: plain
 * fields, then one part per file named by a random id, which a field
 * refers to as `attach://<id>`. Those fields get the file (`BotUpload`).
 */
export function parseMultipart(body: Buffer, contentType: string) {
    const boundary = contentType.match(/boundary=("?)([^";]+)\1/i)?.[2];
    if (!boundary) {
        throw new Error('A multipart body without a boundary.');
    }
    const delimiter = Buffer.from(`--${boundary}`);
    const fields: Record<string, unknown> = {};
    const files = new Map<string, BotUpload>();
    let start = body.indexOf(delimiter);
    while (start !== -1) {
        const from = start + delimiter.length;
        // The closing delimiter ends with "--".
        if (body.subarray(from, from + 2).toString() === '--') {
            break;
        }
        const next = body.indexOf(delimiter, from);
        if (next === -1) {
            break;
        }
        // A part: "\r\n<headers>\r\n\r\n<content>\r\n" before the next delimiter.
        const part = body.subarray(from + 2, next - 2);
        const split = part.indexOf('\r\n\r\n');
        const headers = part.subarray(0, split).toString('utf8');
        const content = part.subarray(split + 4);
        const name = headers.match(/name="([^"]*)"/i)?.[1] ?? '';
        const filename = headers.match(/filename="?([^";\r\n]+)"?/i)?.[1];
        if (filename) {
            files.set(name, {
                filename,
                size: content.length,
                bytes: Buffer.from(content),
            });
        } else {
            fields[name] = content.toString('utf8');
        }
        start = next;
    }
    for (const [key, value] of Object.entries(fields)) {
        const attached =
            typeof value === 'string' && value.startsWith('attach://')
                ? files.get(value.slice('attach://'.length))
                : undefined;
        if (attached) {
            fields[key] = attached;
        }
    }
    return fields;
}

/**
 * A local stand-in for api.telegram.org. Serves `getUpdates` from a queue
 * (long-polling until an update is pushed), records every other call, and
 * answers with plausible results (refusing blank message text, as Telegram
 * does). `pending` counts updates not yet fetched. Point grammY at `apiRoot`.
 * Files added with `file()` are served by `getFile` and downloaded from
 * `<apiRoot>/file/bot<token>/<path>`; `downloads` records those paths.
 * Uploads (`sendPhoto` with an `InputFile`) come as multipart: the call's
 * body has the fields, and the file as a `BotUpload` in place of `photo`.
 */
export async function fakeTelegram(bot = { id: 777, username: 'brain_bot' }) {
    const calls: BotCall[] = [];
    const rejected: Array<{
        method: string;
        when: (body: Record<string, unknown>) => boolean;
    }> = [];
    const held: Array<{
        method: string;
        when: (body: Record<string, unknown>) => boolean;
        until: Promise<void>;
    }> = [];
    const downloads: string[] = [];
    /** Telegram ids `getChatMember` answers as group admins (CB-214). */
    const admins = new Set<number>();
    const files = new Map<string, { path: string; bytes: Buffer }>();
    const queue: unknown[] = [];
    let updateId = 0;
    let messageId = 1000;
    let waiters: Array<() => void> = [];
    const wake = () => {
        const current = waiters;
        waiters = [];
        current.forEach((fn) => fn());
    };
    const readBody = async (request: IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks);
        const type = request.headers['content-type'] ?? '';
        if (type.includes('multipart/form-data')) {
            return parseMultipart(raw, type);
        }
        const text = raw.toString('utf8');
        if (!text) {
            return {};
        }
        if (type.includes('application/json')) {
            return JSON.parse(text) as Record<string, unknown>;
        }
        return Object.fromEntries(new URLSearchParams(text));
    };
    const result = (method: string, body: Record<string, unknown>) => {
        switch (method) {
            case 'getMe':
                return {
                    id: bot.id,
                    is_bot: true,
                    first_name: 'Brain',
                    username: bot.username,
                    can_join_groups: true,
                    can_read_all_group_messages: true,
                    supports_inline_queries: false,
                };
            case 'sendMessage':
                return {
                    message_id: ++messageId,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: Number(body.chat_id), type: 'private' },
                    text: body.text,
                    ...(body.message_thread_id ? { message_thread_id: Number(body.message_thread_id) } : {}),
                };
            case 'sendPhoto': {
                const photo = body.photo as BotUpload | undefined;
                return {
                    message_id: ++messageId,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: Number(body.chat_id), type: 'private' },
                    photo: [
                        {
                            file_id: `photo-${messageId}`,
                            file_unique_id: `unique-photo-${messageId}`,
                            width: 1,
                            height: 1,
                            file_size: photo?.size ?? 0,
                        },
                    ],
                    ...(body.caption ? { caption: body.caption } : {}),
                };
            }
            case 'getFile': {
                const file = files.get(String(body.file_id));
                return file
                    ? {
                          file_id: body.file_id,
                          file_unique_id: `unique-${body.file_id}`,
                          file_size: file.bytes.length,
                          file_path: file.path,
                      }
                    : undefined;
            }
            case 'getChatMember': {
                const id = Number(body.user_id);
                return {
                    status: admins.has(id) ? 'administrator' : 'member',
                    user: { id, is_bot: false, first_name: 'User' },
                };
            }
            case 'editMessageText':
                return {
                    message_id: Number(body.message_id),
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: Number(body.chat_id), type: 'private' },
                    text: body.text,
                };
            default:
                return true;
        }
    };
    const server = createServer(async (request, response) => {
        const download = request.url?.match(/^\/file\/bot[^/]+\/(.+)$/);
        if (download) {
            downloads.push(download[1]);
            const file = [...files.values()].find((entry) => entry.path === download[1]);
            response.statusCode = file ? 200 : 404;
            response.end(file?.bytes);
            return;
        }
        const method = request.url?.split('/').pop()?.split('?')[0] ?? '';
        const body = await readBody(request);
        if (method === 'getUpdates') {
            const offset = Number(body.offset ?? 0);
            while (queue.length && (queue[0] as { update_id: number }).update_id < offset) {
                queue.shift();
            }
            // A poll the bot gave up on (bot.stop() aborts it) takes nothing.
            let abandoned = false;
            response.on('close', () => (abandoned = !response.writableFinished));
            if (!queue.length) {
                const timeout = Math.min(Number(body.timeout ?? 0), 2) * 1000;
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, timeout || 10);
                    waiters.push(() => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
            if (abandoned) {
                return;
            }
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ ok: true, result: queue.splice(0) }));
            return;
        }
        calls.push({ method, body });
        const hold = held.find((rule) => rule.method === method && rule.when(body));
        if (hold) {
            await hold.until;
        }
        if (rejected.some((rule) => rule.method === method && rule.when(body))) {
            response.statusCode = 403;
            response.setHeader('content-type', 'application/json');
            response.end(
                JSON.stringify({
                    ok: false,
                    error_code: 403,
                    description: 'Forbidden: fixture rejected this request',
                }),
            );
            return;
        }
        response.setHeader('content-type', 'application/json');
        // As Telegram: a message's text can't be blank (CB-35).
        if (['sendMessage', 'editMessageText'].includes(method) && !String(body.text ?? '').trim()) {
            response.statusCode = 400;
            response.end(
                JSON.stringify({
                    ok: false,
                    error_code: 400,
                    description: 'Bad Request: text must be non-empty',
                }),
            );
            return;
        }
        response.end(JSON.stringify({ ok: true, result: result(method, body) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        apiRoot: `http://127.0.0.1:${port}`,
        bot,
        calls,
        /** Refuse matching outbound calls, without changing ingress or other calls. */
        reject(method: string, when: (body: Record<string, unknown>) => boolean) {
            rejected.push({ method, when });
        },
        /** Hold only matching egress while allowing all polling and other calls. */
        hold(method: string, when: (body: Record<string, unknown>) => boolean, until: Promise<void>) {
            held.push({ method, when, until });
        },
        /** Updates queued and not yet fetched by the bot. */
        get pending() {
            return queue.length;
        },
        downloads,
        /** Group admins, by Telegram id, as `getChatMember` tells (CB-214). */
        admins,
        /** Serve a file: `getFile` resolves `fileId` to `path`. */
        file(fileId: string, path: string, bytes: Buffer) {
            files.set(fileId, { path, bytes });
        },
        /** Queue a raw update; `update_id` is assigned. */
        push(update: Record<string, unknown>) {
            queue.push({ update_id: ++updateId, ...update });
            wake();
        },
        /** Queue a text message from a user in a chat. */
        message(options: {
            text: string;
            chat: { id: number; type: string; title?: string; is_forum?: boolean };
            from: { id: number; first_name?: string; username?: string };
            threadId?: number;
            entities?: unknown[];
            /** The message it replies to (a bot's, to address the bot). */
            replyTo?: { message_id: number; from: { id: number; is_bot: boolean } };
        }) {
            this.push({
                message: {
                    message_id: ++messageId,
                    date: Math.floor(Date.now() / 1000),
                    chat: options.chat,
                    from: { is_bot: false, first_name: 'User', ...options.from },
                    text: options.text,
                    ...(options.threadId ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
                    ...(options.entities ? { entities: options.entities } : {}),
                    ...(options.replyTo
                        ? {
                              reply_to_message: {
                                  date: Math.floor(Date.now() / 1000),
                                  chat: options.chat,
                                  text: 'earlier',
                                  ...options.replyTo,
                              },
                          }
                        : {}),
                },
            });
            return messageId;
        },
        async waitFor(predicate: (call: BotCall) => boolean, timeout = 5000): Promise<BotCall> {
            const deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                const found = calls.find(predicate);
                if (found) {
                    return found;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            throw new Error(`No matching Bot API call; saw: ${calls.map((c) => c.method).join(', ')}`);
        },
        close: () =>
            new Promise<void>((resolve) => {
                wake();
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
export type FakeTelegram = Awaited<ReturnType<typeof fakeTelegram>>;
