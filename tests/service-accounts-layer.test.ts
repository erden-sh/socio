import { Context, Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { Accounts, ServiceAccountError } from '../src/server/service-accounts/contract.js';
import {
    ServiceAccountsDatabase,
    ServiceAccountsLive,
    ServiceAccountsService,
} from '../src/server/service-accounts/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// Service accounts' layer: one service on the connection it is given, under
// `Accounts` and whole as `ServiceAccountsService`; its refusals are the
// tagged `ServiceAccountError`.

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn());
});

async function built() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const live = ServiceAccountsLive.pipe(Layer.provide(Layer.succeed(ServiceAccountsDatabase, workspace.db)));
    return Effect.runPromise(Layer.build(live).pipe(Effect.scoped));
}

describe('the service accounts layer', () => {
    it('offers one service under Accounts and ServiceAccountsService, on the given connection', async () => {
        const context = await built();
        const service = Context.get(context, ServiceAccountsService);
        expect(Context.get(context, Accounts)).toBe(service);
        const account = service.create({ name: 'Robot', role: 'member' }, 'alice');
        expect(Context.get(context, Accounts).isService(account.id)).toBe(true);
        const { token } = service.createKey(account.id, { name: 'ci', scopes: ['issues:read'], days: 30 }, 'alice');
        expect(Context.get(context, Accounts).resolve(token)?.user.id).toBe(account.id);
    });

    it('refuses with a tagged ServiceAccountError carrying the message and status', async () => {
        const service = Context.get(await built(), ServiceAccountsService);
        let caught: unknown;
        try {
            service.get('svc_missing');
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(ServiceAccountError);
        expect(caught).toMatchObject({
            _tag: 'ServiceAccountError',
            message: 'Service account not found.',
            status: 404,
        });
    });
});
