import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { vi } from 'vitest';

import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { AppEnv } from '@socio/foundation/http/app-env';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { User } from '@socio/shared/types';

import type { AudiencePolicy } from '../../src/server/actors/contract.js';
import { actorRoutes } from '../../src/server/actors/routes.js';
import { actorTools } from '../../src/server/actors/tools.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

/**
 * CB-232 on the real platform: mini apps on, the flag on, three
 * people, a company socio and Alice's own, and apps whose delegation
 * contract a fake `app` audience policy answers for (what the apps module registers).
 */

export const SECRET = 'actor-consent-secret-0123456789abcdef';
export const RLO = String.fromCodePoint(0x202e);
export const ZWSP = String.fromCodePoint(0x200b);

export const cleanup: Array<() => unknown> = [];

export const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'member' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'olga', name: 'Olga', role: 'admin' },
];

export interface AppWorld {
    /** An app's current policy version; missing: no delegation contract. */
    versions: Map<string, string>;
    alwaysAsk: Set<string>;
}

export async function setup(options: { flag?: boolean; register?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-consent-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { platform, workspace, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: SECRET,
            appOrigin: 'http://localhost:4310',
            data: { userDataDir: dir },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': options.flag ?? true },
        },
    });
    cleanup.push(dispose);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const company = workspace.dots()[0]!;
    const personal = workspace.createDot(
        company.spaceId,
        'Alice’s own',
        '',
        true,
        true,
        company.spaceIds,
        null,
        false,
        null,
        false,
        'alice',
    );
    const chat = workspace.bindThread('chat-1', company.id, 'Pipeline', 'alice');
    const other = workspace.bindThread('chat-2', company.id, 'Other', 'alice');
    const bobChat = workspace.bindThread('chat-b', company.id, 'Bob', 'bob');
    const mine = workspace.bindThread('chat-p', personal.id, 'Mine', 'alice');
    const now = Date.now();
    const app = (id: string, owner: string, dotId: string, status: 'promoted' | 'ephemeral', name = id.toUpperCase()) =>
        workspace.db
            .prepare(
                'INSERT INTO apps(id, slug, name, dotId, ownerUserId, port, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 3000, ?, ?, ?)',
            )
            .run(id, id, name, dotId, owner, status, now, now);
    app('crm', 'alice', company.id, 'promoted', 'CRM Dashboard');
    app('hr', 'alice', company.id, 'promoted', 'HR');
    app('legacy', 'alice', company.id, 'promoted', 'Legacy');
    app('devshared', 'alice', company.id, 'ephemeral', 'Dev shared');
    app('devmine', 'alice', personal.id, 'ephemeral', 'Dev mine');
    app('bobs', 'bob', company.id, 'promoted', 'Bob’s');
    const w: AppWorld = {
        versions: new Map([
            ['app:crm', 'v1'],
            ['app:hr', 'v1'],
            ['app:devshared', 'v1'],
            ['app:devmine', 'v1'],
            ['app:bobs', 'v1'],
        ]),
        alwaysAsk: new Set(['app:hr']),
    };
    // What the apps module registers from AppsService; here a fake over `w`.
    const policy: AudiencePolicy = {
        policyVersion: (audience) => w.versions.get(audience),
        personMay: (personId, audience) => {
            const record = platform.apps.get(audience.slice(4));
            return !!record && !!platform.apps.access(personId, record);
        },
        actionTier: (_audience, action) =>
            (
                {
                    'dashboard.view': 'read',
                    'deal.update': 'write',
                    'sms.send': 'consequential',
                    'settings.update': 'admin',
                } as const
            )[action as 'sms.send'],
        alwaysAsk: (audience) => w.alwaysAsk.has(audience),
    };
    // Through the registry's lookup, so the fake stands whether or not the apps
    // module's own `app` policy is registered on this platform.
    const lookup = platform.actors.audiences.for.bind(platform.actors.audiences);
    vi.spyOn(platform.actors.audiences, 'for').mockImplementation((audience) =>
        audience.startsWith('app:') ? (options.register === false ? undefined : policy) : lookup(audience),
    );
    const turn = (userId: string, threadId: string, dotId = company.id): DotTurn => ({
        dot: workspace.dot(dotId)!,
        userId,
        threadId,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    });
    const tool = (name: string, at: DotTurn) => {
        const found = actorTools(platform, at).find((item) => item.name === name);
        if (!found) {
            throw new Error(`No tool ${name}`);
        }
        return (input: Record<string, unknown>) => found.execute!(input as never) as Promise<Record<string, unknown>>;
    };
    const ask = (input: Record<string, unknown>, at = turn('alice', chat.id)) =>
        tool('request_app_access', at)({ task: 'Check the chart', ...input });
    return {
        platform,
        workspace,
        company,
        personal,
        chat,
        other,
        bobChat,
        mine,
        w,
        turn,
        tool,
        ask,
    };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

export const pendingId = (result: Record<string, unknown>) => {
    if (result.status !== 'pending_approval') {
        throw new Error(`Not pending: ${JSON.stringify(result)}`);
    }
    return (result.approval as { id: string }).id;
};

export function api(f: Setup) {
    const app = new Hono<AppEnv>();
    let as = 'alice';
    app.use('*', async (c, next) => {
        c.set('user', USERS.find((user) => user.id === as)! as never);
        await next();
    });
    app.route('/api', actorRoutes(f.platform));
    return async (user: string, path: string, method = 'GET') => {
        as = user;
        const response = await app.request(`/api${path}`, { method });
        return { status: response.status, body: (await response.json()) as never };
    };
}
