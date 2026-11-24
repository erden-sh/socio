import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { nonPersonOwnerId } from '@socio/shared/data-types';
import { isAdmin, normalizeRole, ROLES } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { BetterAuthProvider, type AgentAuthorization, type PasswordHasher } from './better-auth.js';
import type { AuthSetup as BaseAuthSetup } from './contract.js';
import { smtpMailer, type Mailer } from './mailer.js';
import { MockAuthProvider } from './mock.js';
import { betterAuthSettingsFromEnv, firstAdminWarnings } from './settings.js';

// alice is the first admin, as the first account is in production.
export const DEFAULT_MOCK_USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const usersSchema = z
    .array(
        z
            .object({
                id: z
                    .string()
                    .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
                    // Never a non-person owner id: a socio's area, a plugin, the workspace (CB-224, CB-451).
                    .refine((id) => !nonPersonOwnerId(id)),
                name: z.string().trim().min(1).max(80),
                // `operator` was retired (CB-390): an older MOCK_USERS still
                // starts, its operators as admins.
                role: z.enum([...ROLES, 'operator']).transform(normalizeRole),
            })
            .strict(),
    )
    .min(1)
    .refine((users) => new Set(users.map((u) => u.id)).size === users.length, {
        message: 'duplicate id',
    })
    .refine((users) => users.some(isAdmin), {
        message: 'at least one admin',
    });

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface AuthSetup extends BaseAuthSetup {
    warnings: string[];
}

export interface AuthOptions {
    /** The SQLite file (Better Auth keeps its tables in the app database). */
    database?: string;
    /** Reads `<NAME>_FILE` secrets of OAuth providers. */
    read?: (path: string) => string;
    /** Replaces SMTP mail (tests). */
    mailer?: Mailer;
    /** Replaces password hashing (tests). */
    hasher?: PasswordHasher;
}

/**
 * What Better Auth takes of other features, which the composition hands in
 * (`composition/auth.ts`, `authFromEnv`): connected agents' side of it, and
 * the connected-agent scopes of the plugin catalog the environment sets.
 */
export interface AuthSetupOptions extends AuthOptions {
    agents: AgentAuthorization;
    pluginScopes: Parameters<typeof betterAuthSettingsFromEnv>[4];
}

/**
 * Auth from the environment: `AUTH_PROVIDER=mock` (the default) or
 * `betterauth`. Fails with a clear message on unusable settings, before the
 * database is opened.
 */
export function authSetupFromEnv(
    env: Record<string, string | undefined>,
    host: string,
    options: AuthSetupOptions,
): AuthSetup {
    const kind = env.AUTH_PROVIDER?.trim() || 'mock';
    if (kind !== 'mock' && kind !== 'betterauth') {
        throw new Error(`AUTH_PROVIDER "${kind}" is not supported (use mock or betterauth).`);
    }
    const loopback = LOOPBACK.includes(host);
    const warnings: string[] = [];
    const origins = (env.APP_ORIGIN ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    // Mock auth has no gate in front of it (the owner token is gone), so it
    // never listens beyond this machine.
    if (kind === 'mock' && !loopback) {
        throw new Error(
            'Mock auth lets anyone sign in as any user, so it runs only on a loopback HOST (127.0.0.1, ::1 or localhost). Use AUTH_PROVIDER=betterauth for a server other machines reach.',
        );
    }
    if (kind === 'mock' && origins.some((o) => !LOOPBACK_ORIGIN.test(o))) {
        throw new Error(
            'Mock auth runs only on loopback: APP_ORIGIN must be http://localhost, 127.0.0.1 or [::1] origins. Use AUTH_PROVIDER=betterauth behind a proxy or domain.',
        );
    }
    // Removed settings: say so rather than silently ignoring them.
    if (env.OWNER_TOKEN?.trim() || env.OWNER_TOKEN_FILE?.trim()) {
        warnings.push(
            'OWNER_TOKEN is no longer used (the owner token was removed; everyone signs in for themselves); remove it.',
        );
    }
    if (env.AUTH_MOCK_ALLOW_REMOTE?.trim()) {
        warnings.push('AUTH_MOCK_ALLOW_REMOTE was removed: mock auth runs on loopback only; remove it.');
    }
    let secret = env.SESSION_SECRET?.trim() ?? '';
    if (secret && secret.length < 24) {
        throw new Error('SESSION_SECRET must be at least 24 characters.');
    }
    if (!secret) {
        if (!loopback) {
            throw new Error('SESSION_SECRET (24+ characters) is required on a non-loopback HOST.');
        }
        secret = randomBytes(32).toString('base64url');
        warnings.push('SESSION_SECRET is not set; using a per-process secret, so sign-ins reset on restart.');
    }
    const secureCookies = origins.length > 0 && origins.every((o) => o.startsWith('https://'));
    if (kind === 'betterauth') {
        const settings = betterAuthSettingsFromEnv(
            env,
            origins,
            secret,
            options.read ?? ((path) => readFileSync(path, 'utf8')),
            options.pluginScopes,
        );
        if (!options.database) {
            throw new Error('Better Auth needs the database path.');
        }
        if (env.MOCK_USERS?.trim()) {
            warnings.push('MOCK_USERS is ignored with AUTH_PROVIDER=betterauth.');
        }
        warnings.push(...firstAdminWarnings(env));
        if (!settings.secure && !loopback) {
            warnings.push(
                'APP_ORIGIN is not https: passwords and session cookies cross the network unencrypted, and browsers allow passkeys only on https (or localhost).',
            );
        }
        const mailer = options.mailer ?? (settings.smtp ? smtpMailer(settings.smtp) : undefined);
        return {
            provider: new BetterAuthProvider(settings, options.database, mailer, options.hasher, options.agents),
            secureCookies: settings.secure,
            warnings,
        };
    }
    const firstAdmin = ['AUTH_FIRST_ADMIN_EMAIL', 'AUTH_OPERATOR_EMAIL'].find((name) => env[name]?.trim());
    if (firstAdmin) {
        warnings.push(
            `${firstAdmin} is used with AUTH_PROVIDER=betterauth only; with mock auth, give a MOCK_USERS entry the admin role.`,
        );
    }
    let users = DEFAULT_MOCK_USERS;
    if (env.MOCK_USERS?.trim()) {
        let raw: unknown;
        try {
            raw = JSON.parse(env.MOCK_USERS);
        } catch {
            raw = undefined;
        }
        const parsed = usersSchema.safeParse(raw);
        if (!parsed.success) {
            throw new Error(
                'MOCK_USERS must be a JSON array of {"id","name","role"} (role admin or member) with unique lowercase ids and at least one admin.',
            );
        }
        users = parsed.data;
    }
    return {
        provider: new MockAuthProvider(users, secret, secureCookies),
        secureCookies,
        warnings,
    };
}
