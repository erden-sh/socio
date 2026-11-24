import { createHash } from 'node:crypto';

import type { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { DEVICE_REFUSAL_WORDS, type StepUpSession, type StepUpVerifier, type AuthProvider } from './contract.js';
import {
    clearedSessionCookie,
    cookieValue,
    createSessionValue,
    readSessionValue,
    SESSION_COOKIE,
    sessionCookie,
} from './session.js';
import { signInView } from './sign-in-view.js';
import { expiredStepUp, StepUpChallenges } from './step-up.js';

/**
 * Development sign-in: pick one of a fixed set of users. Anyone who can reach
 * the server can sign in as any of them, so it is for this machine only: it
 * refuses a non-loopback HOST or APP_ORIGIN (authFromEnv) and requests from
 * elsewhere (`localRequest`, in createApp). There is no gate in front of it.
 */
export class MockAuthProvider implements AuthProvider {
    readonly kind = 'mock';
    constructor(
        private list: User[],
        private secret: string,
        private secure = false,
    ) {}
    private challenges = new StepUpChallenges();
    /**
     * Step-up (CB-124) is a confirmation here: anyone at this machine can
     * pick any user, so a password would prove nothing. It still binds the
     * change, works once and expires, like Better Auth's.
     */
    readonly stepUp: StepUpVerifier = {
        begin: async (request, user, digest) => {
            const session = await this.sessionOf(request);
            if (!session || session.accountId !== user.id) {
                return null;
            }
            return {
                ...this.challenges.create({ session, userId: user.id, digest }),
                methods: ['confirm'],
            };
        },
        finish: async (request, user, digest, proof) => {
            const session = await this.sessionOf(request);
            if (!session || !('confirm' in proof)) {
                return expiredStepUp();
            }
            const challenge = this.challenges.take(proof.id, {
                session,
                userId: user.id,
                digest,
            });
            if (!challenge) {
                return expiredStepUp();
            }
            return { ok: true, method: 'confirm', session };
        },
    };
    users() {
        return this.list;
    }
    /** Code access (CB-376): mock auth has no groups, so admins may run code and nobody else. */
    async mayRunCode(userId: string) {
        return isAdmin(this.list.find((user) => user.id === userId));
    }
    async sessionOf(request: Request): Promise<StepUpSession | null> {
        const value = cookieValue(request, SESSION_COOKIE);
        const id = readSessionValue(this.secret, value);
        if (!id || !value) {
            return null;
        }
        return {
            sessionId: createHash('sha256').update(value).digest('base64url'),
            accountId: id,
        };
    }
    async resolve(request: Request): Promise<User | null> {
        const id = readSessionValue(this.secret, cookieValue(request, SESSION_COOKIE));
        return this.list.find((user) => user.id === id) ?? null;
    }
    routes(app: Hono<AppEnv>) {
        app.get('/api/auth/mock/users', (c) => c.json(this.list.map(({ id, name, role }) => ({ id, name, role }))));
        app.post('/api/auth/mock/login', async (c) => {
            const parsed = z
                .object({ userId: z.string() })
                .strict()
                .safeParse(await c.req.json().catch(() => null));
            const user = parsed.success ? this.list.find((entry) => entry.id === parsed.data.userId) : undefined;
            if (!user) {
                return c.json({ error: 'Unknown user.' }, 400);
            }
            c.header('Set-Cookie', sessionCookie(createSessionValue(this.secret, user.id), this.secure));
            return c.json(user);
        });
    }
}

/** Provider-independent session endpoints. */
export function sessionRoutes(
    app: Hono<AppEnv>,
    provider: AuthProvider,
    secure: boolean,
    branding?: () => import('@socio/shared/branding').Branding,
) {
    app.get('/api/auth/session', async (c) => {
        const view = {
            ...signInView(provider, branding?.()),
            user: await provider.resolve(c.req.raw, (name, value) => c.header(name, value, { append: true })),
        };
        // The app's request (with an install id) whose device was refused
        // learns why, as from the session check's 401 (CB-379), with the
        // sign-in view beside it. The web's answer, and the app's with no
        // refusal (signed in, or an install id this server doesn't know), is
        // the view with `user` as before.
        const refusal = view.user ? null : (provider.deviceRefusal?.(c.req.raw) ?? null);
        return refusal ? c.json({ ...view, error: DEVICE_REFUSAL_WORDS[refusal], code: refusal }, 401) : c.json(view);
    });
    app.post('/api/auth/logout', async (c) => {
        const cookies = provider.logout ? await provider.logout(c.req.raw) : [clearedSessionCookie(secure)];
        for (const cookie of cookies) {
            c.header('Set-Cookie', cookie, { append: true });
        }
        return c.json({ ok: true });
    });
}
