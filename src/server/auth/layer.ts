/**
 * Auth's layers: they implement `contract.ts`, and yield what auth needs of
 * other features through their tags. Only the composition root
 * (`composition/auth.ts`) and tests import this file.
 *
 * The provider itself is built at boot, before the database is opened
 * (`authFromEnv` validates the environment first, and Better Auth opens
 * its own connection lazily), so `AuthLive` takes the built setup rather
 * than building one.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import { Actors } from '../actors/contract.js';
import { Grants } from '../agents/contract.js';
import { Apps } from '../apps/contract.js';
import { Inference } from '../inference/contract.js';
import { Connections } from '../mcp/contract.js';
import { Plugins } from '../plugins/contract.js';
import { Rooms } from '../rooms/contract.js';
import { Jobs, Tasks } from '../schedules/contract.js';
import { Accounts } from '../service-accounts/contract.js';
import { Audit, People } from '../workspace/contract.js';

import { readStoredPolicy } from './access-policy-store.js';
import { accountLifecycle } from './accounts.js';
import { AccessPolicyReader, Auth, AuthViews, CodeAccess, RequestUsers, type AuthSetup } from './contract.js';
import { requestUserResolver } from './request-user.js';
import { signInView } from './sign-in-view.js';

/** The provider and its cookie setting, as the boot step built them. */
export const AuthLive = (setup: AuthSetup) => Layer.succeed(Auth, Auth.of(setup));

/**
 * A request's user, recorded through the `People` slice on `db` (the
 * connection the workspace's units of work run on), once per name and role.
 */
export const RequestUsersLive = (db: DatabaseSync) =>
    Layer.effect(
        RequestUsers,
        Effect.gen(function* () {
            const auth = yield* Auth;
            const people = yield* People;
            return RequestUsers.of({
                resolve: requestUserResolver(auth, {
                    workspace: { db, recordUser: (user) => people.recordUser(user) },
                }),
            });
        }),
    );

/** The saved access policy, read from `db` on every use. */
export const AccessPolicyReaderLive = (db: DatabaseSync) =>
    Layer.succeed(AccessPolicyReader, AccessPolicyReader.of({ read: () => readStoredPolicy(db) }));

/**
 * Who may run code (CB-376), from the boot step's provider: the gateways'
 * step reads it, so the root provides it before the graph (main.ts).
 */
export const CodeAccessLive = (setup: AuthSetup) =>
    Layer.succeed(
        CodeAccess,
        CodeAccess.of({
            mayRunCode: async (userId) => (await setup.provider.mayRunCode?.(userId)) ?? false,
        }),
    );

/** Auth's views (`sign-in-view.ts`). */
export const AuthViewsLive = Layer.succeed(AuthViews, AuthViews.of({ signInView }));

/**
 * What a deactivation or reactivation ends (`accountLifecycle`), over the
 * other features' tags: the audit, service account keys, agent grants,
 * socio access, mini app and plugin sessions, schedules, job runs,
 * subscription connections, MCP connections and room admins.
 */
export const accountEvents = Effect.gen(function* () {
    return accountLifecycle({
        workspace: yield* Audit,
        serviceAccounts: yield* Accounts,
        agentGrants: yield* Grants,
        actors: yield* Actors,
        apps: yield* Apps,
        plugins: yield* Plugins,
        store: yield* Tasks,
        jobs: yield* Jobs,
        inference: yield* Inference,
        mcpConnections: yield* Connections,
        rooms: yield* Rooms,
    });
});

/**
 * Every tag auth offers, over the setup the boot step built and the
 * workspace's connection: `Auth`, `RequestUsers`, `AccessPolicyReader`
 * and `AuthViews`.
 */
export const AuthServicesLive = (setup: AuthSetup, db: DatabaseSync) =>
    Layer.mergeAll(RequestUsersLive(db), AccessPolicyReaderLive(db), AuthViewsLive).pipe(
        Layer.provideMerge(AuthLive(setup)),
    );
