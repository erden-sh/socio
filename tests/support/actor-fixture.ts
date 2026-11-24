import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '@socio/data/open';
import { RuntimeSession } from '@socio/data/runtime-ownership';
import type { ActionTier, ActorScope, Audience } from '@socio/shared/actor-scopes';
import type { FlagKey } from '@socio/shared/flags';

import type { AudiencePolicy, ConversationState } from '../../src/server/actors/contract.js';
import { ActorAccess } from '../../src/server/actors/service.js';
import { testDatabaseFile } from '../helpers/test-database.js';

/**
 * Socio-actor access (CB-232) on a real SQLite file with fakes for the
 * world around it: who is active, which socios they may use, flags,
 * conversations and one app audience. Several runtimes can share one
 * file (CB-108) and one world.
 */

export const SECRET = 'actor-test-secret-0123456789abcdef';

export interface World {
    now: number;
    inactive: Set<string>;
    /** `person|socio` pairs that may NOT be used. */
    socioBlocked: Set<string>;
    flagsOff: Set<FlagKey>;
    conversations: Map<string, ConversationState>;
    /** An audience's current policy version; missing: not delegable. */
    versions: Map<string, string>;
    /** `person|audience` pairs that can't open it. */
    noAccess: Set<string>;
    tiers: Record<string, ActionTier>;
    deniedResources: Set<string>;
}

export function world(): World {
    return {
        now: 1_000_000,
        inactive: new Set(),
        socioBlocked: new Set(),
        flagsOff: new Set(),
        conversations: new Map([
            ['chat-1', 'private'],
            ['chat-2', 'private'],
            ['room-1', 'room'],
            ['tg-1', 'telegram-group'],
        ]),
        versions: new Map([
            ['app:crm', 'v1'],
            ['app:other', 'v1'],
            ['gateway:model', ''],
            ['gateway:git', ''],
        ]),
        noAccess: new Set(),
        tiers: {
            'dashboard.view': 'read',
            'deal.update': 'write',
            'sms.send': 'consequential',
            'settings.update': 'admin',
        },
        deniedResources: new Set(),
    };
}

export const appPolicy = (w: World): AudiencePolicy => ({
    policyVersion: (audience) => w.versions.get(audience),
    personMay: (personId, audience) => !w.noAccess.has(`${personId}|${audience}`),
    actionTier: (_audience, action) => w.tiers[action],
    resourceAllowed: ({ resource }) => !w.deniedResources.has(`${resource.kind}:${resource.id}`),
});

export interface Runtime {
    db: DatabaseSync;
    session: RuntimeSession;
    access: ActorAccess;
}

export function runtimeOn(path: string, w: World): Runtime {
    const db = openDatabase(path);
    const session = new RuntimeSession({
        heartbeat: false,
        leaseMs: 30_000,
        now: () => w.now,
    });
    const ownership = session.attach(db);
    const access = new ActorAccess(db, {
        ownership,
        secret: SECRET,
        now: () => w.now,
        deps: {
            personActive: (id) => !w.inactive.has(id),
            socioUsable: (person, socio) => !w.socioBlocked.has(`${person}|${socio}`),
            featureOn: (_person, flag) => !w.flagsOff.has(flag),
            conversation: (id) => w.conversations.get(id) ?? 'gone',
        },
    });
    const policy = appPolicy(w);
    access.audiences.register('app', policy);
    access.audiences.register('gateway:model', policy);
    access.audiences.register('gateway:git', policy);
    return { db, session, access };
}

export function fixture(runtimes = 1) {
    const dir = mkdtempSync(join(tmpdir(), 'actors-'));
    const path = testDatabaseFile(join(dir, 'app.sqlite'));
    const w = world();
    const list = Array.from({ length: runtimes }, () => runtimeOn(path, w));
    return {
        w,
        path,
        runtimes: list,
        a: list[0]!,
        b: list[1],
        advance(ms: number) {
            w.now += ms;
        },
        async close() {
            for (const runtime of list) {
                runtime.access.stop();
                if (runtime.db.isOpen) {
                    await runtime.session.detach(runtime.db).catch(() => undefined);
                    runtime.db.close();
                }
            }
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export const grantInput = (
    overrides: Partial<{
        personId: string;
        socioId: string;
        audiences: Audience[];
        scopes: ActorScope[];
        conversationId: string;
        conversationKind: 'private' | 'room' | 'schedule';
        minutes: number;
        policyVersion: string;
        replaces: string;
    }> = {},
) => ({
    personId: 'alice',
    socioId: 'rulo',
    audiences: ['app:crm'] as Audience[],
    scopes: ['app:read'] as ActorScope[],
    conversationId: 'chat-1',
    conversationKind: 'private' as const,
    task: 'Check why the pipeline chart is blank',
    policyVersion: 'v1',
    minutes: 60,
    approvedBy: 'alice',
    correlationId: 'corr-grant',
    ...overrides,
});

/** A grant with an open browser context and its `cbsa_`. */
export async function delegated(access: ActorAccess, overrides: Parameters<typeof grantInput>[0] = {}) {
    const grant = await access.grants.create(grantInput(overrides));
    const context = await access.contexts.open({
        grant,
        kind: 'browser',
        audience: grant.audiences[0]!,
        correlationId: 'corr-context',
    });
    const issued = await access.credentials.issue({
        grant,
        kind: 'cbsa',
        audiences: [grant.audiences[0]!],
        contextId: context.id,
        holder: { kind: 'context', id: context.id },
        correlationId: 'corr-credential',
    });
    return { grant, context, ...issued };
}
