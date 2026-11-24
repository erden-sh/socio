// The web's half of the app's ways in, for servers.mjs's `--codes` and its
// control port: an SMTP sink and a fake Telegram the workspaces send sign-in
// codes to, and Ada on the web making Add a device QR codes, typing the 6
// digits, and signing a device out with erase. Made-up people only; nothing
// leaves the machine (the sink and the fake Bot API listen on 127.0.0.1).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

/**
 * A quoted-printable body read back (RFC 2045): soft line breaks dropped,
 * `=XX` bytes decoded, as UTF-8.
 * @param {string} text
 */
export function decodeQuotedPrintable(text) {
    const joined = text.replace(/=\r?\n/g, '');
    /** @type {number[]} */
    const bytes = [];
    for (let index = 0; index < joined.length; index++) {
        const hex = joined.slice(index + 1, index + 3);
        if (joined[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
            bytes.push(parseInt(hex, 16));
            index += 2;
        } else {
            bytes.push(...Buffer.from(joined[index], 'utf8'));
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

/**
 * One message as the sink received it (DATA, dot-stuffing undone): its To and
 * Subject headers and its plain-text body, decoded.
 * @param {string} raw
 */
export function readMail(raw) {
    const split = raw.indexOf('\r\n\r\n');
    const head = split === -1 ? raw : raw.slice(0, split);
    const body = split === -1 ? '' : raw.slice(split + 4);
    // Folded header lines continue with whitespace.
    const headers = new Map(
        head
            .replace(/\r\n[ \t]+/g, ' ')
            .split('\r\n')
            .map((line) => {
                const colon = line.indexOf(':');
                return /** @type {[string, string]} */ ([
                    line.slice(0, colon).trim().toLowerCase(),
                    line.slice(colon + 1).trim(),
                ]);
            }),
    );
    const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
    const text =
        encoding === 'quoted-printable'
            ? decodeQuotedPrintable(body)
            : encoding === 'base64'
              ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
              : body;
    return { to: headers.get('to') ?? '', subject: headers.get('subject') ?? '', text: text.trim() };
}

/**
 * A local SMTP sink: takes every message (no TLS, no auth, as nodemailer
 * talks to a loopback relay), keeps it in `mail`, and delivers nothing.
 */
export async function smtpSink() {
    /** @type {Array<{ to: string, subject: string, text: string, at: number }>} */
    const mail = [];
    const server = createServer((socket) => {
        let buffer = '';
        let data = false;
        socket.setEncoding('utf8');
        socket.write('220 sink.example.test ESMTP\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk;
            for (;;) {
                if (data) {
                    const end = buffer.indexOf('\r\n.\r\n');
                    if (end === -1) {
                        return;
                    }
                    const raw = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
                    buffer = buffer.slice(end + 5);
                    data = false;
                    mail.push({ ...readMail(raw), at: Date.now() });
                    socket.write('250 2.0.0 Kept\r\n');
                    continue;
                }
                const newline = buffer.indexOf('\r\n');
                if (newline === -1) {
                    return;
                }
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 2);
                const verb = line.slice(0, 4).toUpperCase();
                if (verb === 'EHLO') {
                    socket.write('250-sink.example.test\r\n250 8BITMIME\r\n');
                } else if (verb === 'DATA') {
                    data = true;
                    socket.write('354 End with <CRLF>.<CRLF>\r\n');
                } else if (verb === 'QUIT') {
                    socket.end('221 Bye\r\n');
                    return;
                } else {
                    socket.write('250 OK\r\n');
                }
            }
        });
        socket.on('error', () => {});
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
    const address = server.address();
    return {
        port: typeof address === 'object' && address ? address.port : 0,
        mail,
        close: () => new Promise((done) => server.close(() => done(undefined))),
    };
}

/** The made-up Bot API token the workspaces get with `--codes` (the fake Telegram takes any). */
export const FAKE_BOT_TOKEN = '123456:fake-bot-token-for-local-e2e-only-xyz';

/** Ada's made-up Telegram user (and private chat) id. */
export const ADA_TELEGRAM_ID = 900001;

/**
 * The repository's fake Bot API (tests/fixtures/fake-telegram.ts), loaded
 * with Node's own type stripping.
 * @param {string} root the repository root
 */
export async function fakeTelegramAt(root) {
    const { fakeTelegram } = await import(`${root}/tests/fixtures/fake-telegram.ts`);
    return /** @type {Promise<{ apiRoot: string, calls: Array<{ method: string, body: Record<string, unknown> }>, message: (options: object) => number, close: () => Promise<void> }>} */ (
        fakeTelegram({ id: 777, username: 'socio_e2e_bot' })
    );
}

/**
 * The sign-in code in a message: the code link's `code=` (`…/c#code=…&ws=…`),
 * else the first 8-symbol code with or without its dash. Null with none.
 * @param {string} text
 */
export function codeIn(text) {
    const linked = /[#&]code=([A-Za-z0-9-]+)/.exec(text);
    if (linked) {
        return decodeURIComponent(linked[1]);
    }
    return /\b([A-Z0-9]{4}-?[A-Z0-9]{4})\b/.exec(text)?.[1] ?? null;
}

/**
 * A web session that never throws on a refusal: each call answers its status
 * and JSON body (or null), as the web page reads them.
 * @param {{ port: number, origin: string }} server
 * @param {string} email
 * @param {string} password
 */
export async function webSession(server, email, password) {
    const base = `http://127.0.0.1:${server.port}`;
    let cookie = '';
    const call = async (
        /** @type {string} */ method,
        /** @type {string} */ path,
        /** @type {unknown} */ body = undefined,
    ) => {
        const response = await fetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                Origin: server.origin,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        /** @type {any} */
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return { status: response.status, body: json, text, headers: response.headers };
    };
    const signIn = await call('POST', '/api/auth/sign-in/email', { email, password });
    if (signIn.status !== 200) {
        throw new Error(`${email} couldn't sign in on ${server.port}: ${signIn.status}`);
    }
    cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
    return call;
}

/**
 * Sign-in codes on one workspace (`--codes`): Ada's Telegram linked through
 * the fake bot (`/start <code>`, as t.me's link sends it), and, with
 * `emailLinks`, an admin's "Sign-in links by email" saved on with a
 * password step-up, so codes go by email there instead.
 * @param {{ port: number, origin: string }} server
 * @param {{ ada: string, opal: string, password: string, emailLinks: boolean }} people
 * @param {{ message: (options: object) => number }} telegram
 */
export async function seedChannels(server, { ada, opal: opalEmail, password, emailLinks }, telegram) {
    const call = await webSession(server, ada, password);
    let link;
    for (let attempt = 0; attempt < 60 && !link; attempt++) {
        const made = await call('POST', '/api/telegram/link', {});
        if (made.status === 201) {
            link = made.body;
        } else {
            await new Promise((done) => setTimeout(done, 500));
        }
    }
    if (!link) {
        throw new Error(`Telegram didn't come online on ${server.port}.`);
    }
    const code = new URL(link.url).searchParams.get('start');
    telegram.message({
        text: `/start ${code}`,
        chat: { id: ADA_TELEGRAM_ID, type: 'private' },
        from: { id: ADA_TELEGRAM_ID, first_name: 'Ada', username: 'ada_example' },
    });
    let linked = false;
    for (let attempt = 0; attempt < 60 && !linked; attempt++) {
        linked = Boolean((await call('GET', '/api/telegram/link')).body?.linked);
        if (!linked) {
            await new Promise((done) => setTimeout(done, 250));
        }
    }
    if (!linked) {
        throw new Error(`Ada's Telegram didn't link on ${server.port}.`);
    }
    if (emailLinks) {
        const opal = await webSession(server, opalEmail, password);
        const view = (await opal('GET', '/api/access-policy')).body;
        const change = { policy: { ...view.saved, emailLinks: true }, version: view.version };
        const challenge = await opal('POST', '/api/access-policy/step-up', change);
        if (challenge.status !== 200) {
            throw new Error(
                `The step-up on ${server.port} answered ${challenge.status}: ${challenge.text.slice(0, 200)}`,
            );
        }
        const saved = await opal('PUT', '/api/access-policy', {
            ...change,
            stepUp: { id: challenge.body.id, password },
        });
        if (saved.status !== 200) {
            throw new Error(
                `Saving email links on ${server.port} answered ${saved.status}: ${saved.text.slice(0, 200)}`,
            );
        }
    }
}

/**
 * Everything the workspace sent by email and Telegram, newest last, with the
 * sign-in code each holds.
 * @param {{ mail: Array<{ to: string, subject: string, text: string, at: number }> }} sink
 * @param {{ calls: Array<{ method: string, body: Record<string, unknown> }> }} telegram
 */
export function outbox(sink, telegram) {
    return {
        mail: sink.mail.map((entry) => ({ ...entry, code: codeIn(entry.text) })),
        telegram: telegram.calls
            .filter((call) => call.method === 'sendMessage')
            .map((call) => {
                const text = String(call.body.text ?? '');
                return { chat: Number(call.body.chat_id), text, code: codeIn(text) };
            }),
    };
}

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** How often the web's Add a device page polls (the claim dies after 15 s without a poll). */
export const WEB_POLL_MS = 2_000;

/**
 * Ada's Add a device page on the web, for one workspace: `start` makes a QR
 * code (POST /api/auth/device/pair) and polls its state every 2 s as the page
 * does, `confirm` types 6 digits (the page's confirm), `other` is another
 * device claiming the QR code with the link alone. `seen` keeps every poll's
 * answer, so a flow can check the web never saw a device's digits.
 * @param {(method: string, path: string, body?: unknown) => Promise<{ status: number, body: any, text: string }>} call
 * @param {{ port: number, origin: string }} server
 */
export function webPairing(call, server) {
    /** @type {{ pairingId: string, link: string, timer: NodeJS.Timeout } | null} */
    let current = null;
    /** @type {string[]} */
    let seen = [];
    /** @type {string[]} */
    let states = [];
    const stop = () => {
        if (current) {
            clearInterval(current.timer);
        }
    };
    const poll = async () => {
        if (!current) {
            return;
        }
        const answer = await call('GET', `/api/auth/device/pair/${encodeURIComponent(current.pairingId)}`).catch(
            () => null,
        );
        if (answer) {
            seen.push(answer.text);
            const state = answer.body?.state ?? `http ${answer.status}`;
            if (states.at(-1) !== state) {
                states.push(state);
            }
            if (['allowed', 'denied', 'expired', 'redeemed'].includes(state)) {
                stop();
            }
        }
    };
    return {
        async start() {
            stop();
            const made = await call('POST', '/api/auth/device/pair', { variant: 'development' });
            if (made.status !== 200) {
                throw new Error(`POST /api/auth/device/pair answered ${made.status}: ${made.text.slice(0, 200)}`);
            }
            seen = [];
            states = [];
            current = { pairingId: made.body.pairingId, link: made.body.link, timer: setInterval(poll, WEB_POLL_MS) };
            await poll();
            return { link: made.body.link };
        },
        /** @param {string} digits */
        async confirm(digits) {
            if (!current) {
                throw new Error('No QR code: POST /web/pair first.');
            }
            const answer = await call(
                'POST',
                `/api/auth/device/pair/${encodeURIComponent(current.pairingId)}/confirm`,
                { digits },
            );
            await poll();
            return { status: answer.status, ...answer.body };
        },
        /** Another device claims the QR code first (it has only the link), then polls its redeem once. */
        async other() {
            if (!current) {
                throw new Error('No QR code: POST /web/pair first.');
            }
            const code = new URL(current.link).hash.match(/c=([^&]+)/)?.[1] ?? '';
            const { verifier, challenge } = pkce();
            const unauthed = async (/** @type {string} */ path, /** @type {unknown} */ body) => {
                const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
                    method: 'POST',
                    headers: { Origin: server.origin, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                return { status: response.status, body: await response.json().catch(() => null) };
            };
            const claim = await unauthed('/api/auth/device/pair/claim', {
                code: decodeURIComponent(code),
                challenge,
                label: 'Another phone',
                platform: 'android',
                variant: 'development',
            });
            if (claim.status !== 200) {
                throw new Error(`The other device's claim answered ${claim.status}.`);
            }
            const redeem = await unauthed('/api/auth/device/pair/redeem', {
                claimId: claim.body.claimId,
                verifier,
                installId: randomBytes(32).toString('base64url'),
            });
            await poll();
            // The other device's digits, so a flow can type everything but them.
            return { digits: claim.body.digits, redeem: redeem.body?.code ?? redeem.status };
        },
        /** The states the web saw, and whether any poll held these digits. @param {string} [digits] */
        status(digits) {
            return {
                states,
                polls: seen.length,
                digitsSeen: digits ? seen.some((text) => text.includes(digits)) : null,
            };
        },
        stop,
    };
}

/**
 * Ada on the web signs every device of hers out with erase (Settings →
 * Account → Sign out and erase): the app's next request gets 401
 * `device_revoked` and wipes its copy. Answers the ids it erased.
 * @param {(method: string, path: string, body?: unknown) => Promise<{ status: number, body: any }>} call
 */
export async function eraseDevices(call) {
    const list = await call('GET', '/api/auth/devices');
    const erased = [];
    for (const device of list.body?.devices ?? []) {
        if (device.current || device.state !== 'active') {
            continue;
        }
        // The server takes writes as JSON only, as the web sends them.
        const answer = await call('DELETE', `/api/auth/devices/${encodeURIComponent(device.id)}?erase=1`, {});
        if (answer.status === 200) {
            erased.push(device.id);
        }
    }
    return { erased };
}
