// Small API client for the dev scripts: sign-in (mock, or Better Auth test
// accounts), JSON calls, runtime turns over the CopilotKit SSE protocol, and
// test users and cleanup.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function parseArgs(argv) {
    return Object.fromEntries(
        argv
            .join(' ')
            .split('--')
            .filter(Boolean)
            .map((part) => {
                const [key, ...value] = part.trim().split(/\s+/);
                return [key, value.join(' ') || 'true'];
            }),
    );
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];

/** The server's auth provider: `mock` or `betterauth`. */
export async function authProvider(base) {
    const response = await fetch(`${base}/api/auth/session`);
    if (!response.ok) {
        throw new Error(`Could not read the sign-in setup: ${response.status}`);
    }
    return (await response.json()).provider;
}

/**
 * The role a test user needs. An older server's retired `operator` passes
 * as the admin (CB-390).
 */
const hasRole = (user, role) =>
    role === 'admin' ? user?.role === 'admin' || user?.role === 'operator' : user?.role === role;

/**
 * The admin and member the scripts sign in as.
 *
 * Better Auth (every deployment): email-and-password test accounts an
 * admin created for this (`pnpm run auth create-user --email … --role
 * admin|member --link smoke-admin --password-file …`), named by
 * --admin-email and --member-email, with their password read from
 * --password-file (never on the command line). Users carry `email` and
 * `password` then.
 *
 * Mock auth (loopback only; the server refuses anything else): alice and
 * bob, or --admin-user and --member-user.
 *
 * Checks that both have the expected role before anything is created.
 */
export async function testUsers(base, args) {
    if ((await authProvider(base)) === 'betterauth') {
        const file = args['password-file'];
        if (!args['admin-email'] || !args['member-email'] || !file) {
            throw new Error(
                'This server uses Better Auth: pass --admin-email, --member-email and --password-file for test accounts (see docs/SETUP.md, "Test sign-in").',
            );
        }
        const password = readFileSync(file, 'utf8').trim();
        const pick = async (role) => {
            const email = args[`${role}-email`];
            const call = await signIn(base, { email, password });
            const { user } = await call('/auth/session');
            if (!hasRole(user, role)) {
                throw new Error(`${email} is ${user?.role ?? 'nobody'}, not ${role}.`);
            }
            return { ...user, email, password };
        };
        return { admin: await pick('admin'), member: await pick('member') };
    }
    if (!LOOPBACK.includes(new URL(base).hostname)) {
        throw new Error(
            `${base} uses mock auth, which works on loopback only. Use a Better Auth server with test accounts.`,
        );
    }
    const users = await mockUsers(base);
    const pick = (role) => {
        const wanted = args[`${role}-user`];
        // No default id: the first configured user with the role, never a
        // fixed name a deployment might also use.
        const user = wanted
            ? users.find((entry) => entry.id === wanted)
            : users.find((entry) => (role === 'member' ? entry.role === 'member' : hasRole(entry, role)));
        if (!user) {
            throw new Error(
                wanted
                    ? `User "${wanted}" is not configured on ${base}: add it to MOCK_USERS or pass --${role}-user.`
                    : `No ${role} is configured on ${base}: add one to MOCK_USERS or pass --${role}-user.`,
            );
        }
        if (!hasRole(user, role)) {
            throw new Error(`User "${user.id}" is ${user.role}, not ${role}.`);
        }
        return user;
    };
    return { admin: pick('admin'), member: pick('member') };
}

/** The users a local mock-auth server offers. */
export async function mockUsers(base) {
    const response = await fetch(`${base}/api/auth/mock/users`);
    if (!response.ok) {
        throw new Error(`Could not list users: ${response.status}`);
    }
    return response.json();
}

/** The id of the first mock user with `role`. */
export async function mockUserId(base, role) {
    const user = (await mockUsers(base)).find((entry) =>
        role === 'member' ? entry.role === 'member' : hasRole(entry, role),
    );
    if (!user) {
        throw new Error(`No ${role} is configured on ${base}: add one to MOCK_USERS.`);
    }
    return user.id;
}

/**
 * The admin the Platform scenarios sign in as (CB-390: the operator role
 * was retired; admins see Platform), or undefined when there is none to use
 * (the scenario then skips). Mock auth: --operator-user, else the first
 * admin. Better Auth: the test account --operator-email, else --admin-email
 * (password from --password-file), checked to be an admin.
 */
export async function operatorUser(base, args) {
    if ((await authProvider(base)) === 'betterauth') {
        const email = args['operator-email'] ?? args['admin-email'];
        if (!email || !args['password-file']) {
            return undefined;
        }
        const password = readFileSync(args['password-file'], 'utf8').trim();
        const call = await signIn(base, { email, password });
        const { user } = await call('/auth/session');
        if (!hasRole(user, 'admin')) {
            throw new Error(`${email} is ${user?.role ?? 'nobody'}, not admin.`);
        }
        return { ...user, email, password };
    }
    const response = await fetch(`${base}/api/auth/mock/users`);
    if (!response.ok) {
        throw new Error(`Could not list users: ${response.status}`);
    }
    const users = await response.json();
    const wanted = args['operator-user'];
    const user = wanted ? users.find((entry) => entry.id === wanted) : users.find((entry) => hasRole(entry, 'admin'));
    if (wanted && !hasRole(user, 'admin')) {
        throw new Error(`User "${wanted}" is ${user?.role ?? 'unknown'}, not admin.`);
    }
    return user;
}

/**
 * Deletes conversations a run created, with the tasks bound to them. A turn
 * that is still closing gets a few seconds. Returns what could not be deleted.
 */
export async function deleteConversations(user, ids) {
    const failures = [];
    for (const id of new Set(ids)) {
        for (let attempt = 1; ; attempt++) {
            try {
                await user(`/conversations/${id}`, 'DELETE');
                break;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (/: 404 /.test(message)) {
                    break;
                } // already gone
                if (attempt < 5 && /: 409 Stop the current run/.test(message)) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
                failures.push(`${id} (${message})`);
                break;
            }
        }
    }
    return failures;
}

/**
 * Signs in and returns a JSON caller for /api. `user` is a mock user id
 * (or a user from testUsers), or `{ email, password }` for Better Auth.
 */
export async function signIn(base, user) {
    const account = typeof user === 'object' && user.email ? user : undefined;
    // One API session per account and run: sign-ins are rate limited.
    if (!account) {
        return createSession(base, user);
    }
    const key = `${base} ${account.email}`;
    sessions[key] ??= createSession(base, user).catch((error) => {
        delete sessions[key];
        throw error;
    });
    return sessions[key];
}
const sessions = {};

async function createSession(base, user) {
    const account = typeof user === 'object' && user.email ? user : undefined;
    const userId = typeof user === 'object' ? user.id : user;
    const response = await fetch(`${base}/api/auth/${account ? 'sign-in/email' : 'mock/login'}`, {
        method: 'POST',
        // Better Auth wants the Origin a browser would send (CSRF check).
        headers: {
            'Content-Type': 'application/json',
            ...(account ? { Origin: new URL(base).origin } : {}),
        },
        body: JSON.stringify(account ? { email: account.email, password: account.password } : { userId }),
    });
    if (!response.ok) {
        throw new Error(`Sign-in failed for ${account?.email ?? userId}`);
    }
    const cookie = response.headers
        .getSetCookie()
        .find((header) => /^(__Host-|__Secure-)?(cb_session|cb\.session_token)=/.test(header))
        .split(';')[0];
    const headers = { cookie };
    const call = async (path, method = 'GET', body) => {
        const reply = await fetch(`${base}/api${path}`, {
            method,
            headers: {
                ...headers,
                ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await reply.json().catch(() => ({}));
        if (!reply.ok) {
            throw new Error(`${method} ${path}: ${reply.status} ${data.error ?? ''}`);
        }
        return data;
    };
    call.base = base;
    call.headers = headers;
    return call;
}

/** Starts one turn; resolves with its events once the stream ends. */
export function turn(user, dotId, threadId, history, text, onEvent) {
    const message = { id: randomUUID(), role: 'user', content: text };
    const runId = randomUUID();
    const done = (async () => {
        const response = await fetch(`${user.base}/api/copilotkit/agent/${dotId}/run`, {
            method: 'POST',
            headers: {
                ...user.headers,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            body: JSON.stringify({
                threadId,
                runId,
                messages: [...history, message],
                tools: [],
                context: [],
                state: {},
                forwardedProps: {},
            }),
        });
        if (!response.ok) {
            throw new Error(`Run failed: ${response.status}`);
        }
        const events = [];
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, index);
                buffer = buffer.slice(index + 2);
                for (const line of frame.split('\n')) {
                    if (line.startsWith('data:')) {
                        const event = JSON.parse(line.slice(5).trim());
                        events.push(event);
                        onEvent?.(event);
                    }
                }
            }
        }
        return events;
    })();
    return { runId, done };
}

/** Throws on a RUN_ERROR in a finished turn's events. */
export function assertFinished(events) {
    const error = events.find((event) => event.type === 'RUN_ERROR');
    if (error) {
        throw new Error(`Run error: ${error.message}`);
    }
    return events;
}
