// Auth's tags from its layers (auth/layer.ts), over the other features' tags,
// and its config from the environment (composition/auth.ts).
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { User } from '@socio/shared/types';

import { Actors } from '../src/server/actors/contract.js';
import { Grants } from '../src/server/agents/contract.js';
import { Apps } from '../src/server/apps/contract.js';
import { writeStoredPolicy } from '../src/server/auth/access-policy-store.js';
import { AccessPolicyError } from '../src/server/auth/access-policy.js';
import { DEACTIVATED_SCHEDULE } from '../src/server/auth/accounts.js';
import {
    AccessPolicyReader,
    Auth,
    AuthConfig,
    AuthViews,
    RequestUsers,
    type AuthProvider,
} from '../src/server/auth/contract.js';
import { accountEvents, AuthServicesLive } from '../src/server/auth/layer.js';
import { signInView } from '../src/server/auth/sign-in-view.js';
import { authConfigOf, authLayers } from '../src/server/composition/auth.js';
import { LegacyConfig } from '../src/server/composition/base.js';
import { Inference } from '../src/server/inference/contract.js';
import { Connections } from '../src/server/mcp/contract.js';
import { Plugins } from '../src/server/plugins/contract.js';
import { Rooms } from '../src/server/rooms/contract.js';
import { DEACTIVATED_JOB_RUN, Jobs, Tasks } from '../src/server/schedules/contract.js';
import { Accounts } from '../src/server/service-accounts/contract.js';
import { Audit, type AuditShape } from '../src/server/workspace/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function workspace() {
    const store = new WorkspaceStore(testDatabase());
    cleanup.push(() => store.close());
    return store;
}

const carol: User = { id: 'carol', name: 'Carol', role: 'member' };

/** A provider that resolves every request to `user`, counting the calls. */
function provider(user: User | null): AuthProvider & { calls: number } {
    return {
        kind: 'test',
        calls: 0,
        async resolve() {
            this.calls++;
            return user;
        },
        users: () => (user ? [user] : []),
        routes: () => undefined,
        signInMethods: () => ({ passkey: true, password: false, oauth: [] }) as never,
    };
}

const run = <A, E>(
    effect: Effect.Effect<A, E, Auth | RequestUsers | AccessPolicyReader | AuthViews>,
    ws: WorkspaceStore,
    auth: AuthProvider,
) =>
    Effect.runPromise(
        effect.pipe(
            Effect.provide(
                AuthServicesLive({ provider: auth, secureCookies: false }, ws.db).pipe(
                    Layer.provide(WorkspaceLive(ws)),
                ),
            ),
        ),
    );

it('provides the boot step setup as Auth', async () => {
    const ws = workspace();
    const auth = provider(carol);
    const setup = await run(
        Effect.gen(function* () {
            return yield* Auth;
        }),
        ws,
        auth,
    );
    expect(setup).toEqual({ provider: auth, secureCookies: false });
    expect(setup.provider).toBe(auth);
});

it('resolves a request user and records them through the People slice, once per name and role', async () => {
    const ws = workspace();
    const recordUser = vi.spyOn(ws.slices.people, 'recordUser');
    let current: User = carol;
    const auth: AuthProvider = {
        kind: 'test',
        resolve: async () => current,
        users: () => [current],
        routes: () => undefined,
    };
    const request = new Request('http://localhost/api/state');
    const seen = await run(
        Effect.gen(function* () {
            const { resolve } = yield* RequestUsers;
            const once = () => Effect.promise(() => resolve(request, () => undefined));
            const users: (User | null)[] = [yield* once(), yield* once(), yield* once()];
            const identical = recordUser.mock.calls.length;
            current = { ...carol, name: 'Carol B.' };
            users.push(yield* once(), yield* once());
            const renamed = recordUser.mock.calls.length;
            current = { ...carol, name: 'Carol B.', role: 'admin' };
            users.push(yield* once(), yield* once());
            return { users, identical, renamed, promoted: recordUser.mock.calls.length };
        }),
        ws,
        auth,
    );
    expect(seen.users.map((user) => user && `${user.name}:${user.role}`)).toEqual([
        'Carol:member',
        'Carol:member',
        'Carol:member',
        'Carol B.:member',
        'Carol B.:member',
        'Carol B.:admin',
        'Carol B.:admin',
    ]);
    // Three identical resolutions record once; a new name, then a new role,
    // each record once more.
    expect([seen.identical, seen.renamed, seen.promoted]).toEqual([1, 2, 3]);
    expect(recordUser.mock.calls.map(([user]) => user)).toEqual([
        carol,
        { ...carol, name: 'Carol B.' },
        { ...carol, name: 'Carol B.', role: 'admin' },
    ]);
    expect(ws.users().find((user) => user.id === 'carol')).toMatchObject({ name: 'Carol B.', role: 'admin' });
});

it('resolves no user to null and records nothing', async () => {
    const ws = workspace();
    const before = ws.users().length;
    const user = await run(
        RequestUsers.use(({ resolve }) =>
            Effect.promise(() => resolve(new Request('http://localhost/api/state'), () => undefined)),
        ),
        ws,
        provider(null),
    );
    expect(user).toBeNull();
    expect(ws.users()).toHaveLength(before);
});

it('reads the saved access policy on every use', async () => {
    const ws = workspace();
    const read = await run(
        AccessPolicyReader.use((reader) => Effect.succeed(reader.read)),
        ws,
        provider(carol),
    );
    expect(read()).toMatchObject({ version: 0, saved: {}, unreadable: false });
    writeStoredPolicy(ws.db, 0, { codeUsers: ['carol'] }, 'alice');
    expect(read()).toMatchObject({ version: 1, saved: { codeUsers: ['carol'] }, updatedBy: 'alice' });
});

it('offers the sign-in view through AuthViews', async () => {
    const ws = workspace();
    const auth = provider(carol);
    const views = await run(
        Effect.gen(function* () {
            return yield* AuthViews;
        }),
        ws,
        auth,
    );
    expect(views.signInView).toBe(signInView);
    expect(views.signInView(auth)).toEqual(signInView(auth));
});

it('ends what acts for a deactivated person over the other features tags, in order', async () => {
    const calls: string[] = [];
    const audits: Parameters<AuditShape['audit']>[0][] = [];
    const tags = Layer.mergeAll(
        Layer.succeed(Audit, {
            audit: (entry) => void audits.push(entry),
            auditNow: async () => undefined,
            auditOf: () => [],
        } as AuditShape),
        Layer.succeed(Accounts, {
            revokeKeysMadeBy: (id: string) => {
                calls.push(`keys ${id}`);
                return [{ account: 'bot', name: 'ci' }];
            },
        } as never),
        Layer.succeed(Grants, {
            revokeAllOf: (id: string, by: string) => {
                calls.push(`grants ${id} by ${by}`);
                return 2;
            },
        } as never),
        Layer.succeed(Actors, {
            revokePerson: async (id: string) => {
                calls.push(`actors ${id}`);
                return 1;
            },
        } as never),
        Layer.succeed(Apps, {
            endSessionsOf: async (id: string) => {
                calls.push(`apps ${id}`);
                return 0;
            },
        } as never),
        Layer.succeed(Plugins, {
            endAccessOf: async (id: string) => {
                calls.push(`plugins ${id}`);
                return 3;
            },
        } as never),
        Layer.succeed(Tasks, {
            pauseOwnedBy: async (id: string, reason: string) => {
                calls.push(`tasks ${id} ${reason === DEACTIVATED_SCHEDULE}`);
                return 4;
            },
        } as never),
        Layer.succeed(Jobs, {
            stopOwnedBy: (id: string, reason: string) => {
                calls.push(`jobs ${id} ${reason === DEACTIVATED_JOB_RUN}`);
                return 5;
            },
        } as never),
        Layer.succeed(Inference, {
            forgetUser: async (id: string) => void calls.push(`inference ${id}`),
        } as never),
        Layer.succeed(Connections, {
            forgetUser: async (id: string) => void calls.push(`mcp ${id}`),
        } as never),
        Layer.succeed(Rooms, {
            handOver: async (id: string) => void calls.push(`rooms ${id}`),
        } as never),
    );
    const onEvent = await Effect.runPromise(accountEvents.pipe(Effect.provide(tags)));
    await onEvent({ action: 'deactivate', userId: 'carol', name: 'Carol', by: 'alice' });
    expect(calls).toEqual([
        'keys carol',
        'grants carol by alice',
        'actors carol',
        'apps carol',
        'plugins carol',
        'tasks carol true',
        'jobs carol true',
        'mcp carol',
        'inference carol',
        'rooms carol',
    ]);
    expect(audits).toEqual([
        {
            actor: 'alice',
            action: 'deactivate',
            targetKind: 'user',
            targetId: 'carol',
            detail: 'Carol; revoked keys they made: bot / ci; disconnected 2 agent(s); ended 1 socio access grant(s); ended 3 plugin session(s) and launch code(s); paused 4 scheduled task(s); stopped 5 job run(s)',
        },
    ]);
});

it('builds AuthConfig from the supplied config, not the environment', async () => {
    expect(authConfigOf({ codeUsers: ['alice', 'bob'] })).toEqual({ codeCeiling: ['alice', 'bob'] });
    expect(authConfigOf({})).toEqual({ codeCeiling: [] });
    const previous = process.env.CODE_USERS;
    process.env.CODE_USERS = 'mallory';
    try {
        const config = await Effect.runPromise(
            Effect.gen(function* () {
                return yield* AuthConfig;
            }).pipe(
                Effect.provide(
                    authLayers.config.pipe(
                        Layer.provide(Layer.succeed(LegacyConfig, { codeUsers: ['carol'] } as never)),
                    ),
                ),
            ),
        );
        expect(config).toEqual({ codeCeiling: ['carol'] });
    } finally {
        if (previous === undefined) {
            delete process.env.CODE_USERS;
        } else {
            process.env.CODE_USERS = previous;
        }
    }
});

it('answers an access policy failure with its message, status and impact', () => {
    const error = new AccessPolicyError({ message: 'No.', status: 409 });
    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe('AccessPolicyError');
    expect([error.message, error.status, error.impact]).toEqual(['No.', 409, undefined]);
});
