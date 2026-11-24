// The app runtime (main.ts) provides auth's tags over the very setup the boot
// step built and started (index.ts: `authFromEnv`, then
// `startAppRuntime({ ..., auth })`), on the boot step's connection.
import { Context, Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { User } from '@socio/shared/types';

import { writeStoredPolicy } from '../src/server/auth/access-policy-store.js';
import { AccessPolicyReader, Auth, AuthConfig, AuthViews, RequestUsers } from '../src/server/auth/contract.js';
import { signInView } from '../src/server/auth/sign-in-view.js';
import { authFromEnv } from '../src/server/composition/auth.js';
import type { AppBoot } from '../src/server/main.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
    codeUsers: ['carol'],
};

const carol: User = { id: 'carol', name: 'Carol', role: 'member' };

/** The boot step as index.ts runs it: auth from the environment, both stores on one connection. */
function boot(): AppBoot & { auth: ReturnType<typeof authFromEnv> } {
    const auth = authFromEnv({ AUTH_PROVIDER: 'mock' }, '127.0.0.1');
    const db = testDatabase();
    const store = new Store(db);
    const workspace = new WorkspaceStore(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return { db, store, workspace, config, runner: new LocalAgentRunner(testDatabase()), auth };
}

it("provides auth's tags in the app runtime over the boot step's setup and connection", async () => {
    const app = boot();
    const resolve = vi.spyOn(app.auth.provider, 'resolve').mockResolvedValue(carol);
    const { runtime, platform } = await startWithTestPlatform(app);
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    const context = await runtime.context();
    // The very setup index.ts hands createApp and the pages: not a copy.
    const setup = Context.get(context, Auth);
    expect(setup).toBe(app.auth);
    expect(setup.provider).toBe(app.auth.provider);

    // A request's user comes from that provider and is recorded on the boot
    // step's connection, through the workspace the runtime holds.
    const request = new Request('http://localhost/api/state');
    const user = await runtime.runPromise(
        RequestUsers.use(({ resolve }) => Effect.promise(() => resolve(request, () => undefined))),
    );
    expect(user).toEqual(carol);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(request);
    expect(app.workspace.users().find((u) => u.id === 'carol')).toMatchObject({ name: 'Carol', role: 'member' });

    // The access policy is read from the same connection, on every use.
    const read = Context.get(context, AccessPolicyReader).read;
    expect(read()).toMatchObject({ version: 0, saved: {} });
    writeStoredPolicy(app.db, 0, { codeUsers: ['carol'] }, 'alice');
    expect(read()).toMatchObject({ version: 1, saved: { codeUsers: ['carol'] }, updatedBy: 'alice' });

    expect(Context.get(context, AuthViews).signInView).toBe(signInView);
    // From the config the boot step built (`codeUsers`), as the platform holds it.
    expect(Context.get(context, AuthConfig)).toEqual({ codeCeiling: ['carol'] });
    expect(platform.config.codeUsers).toEqual(['carol']);
});

it('builds auth without starting it or reading the provider', async () => {
    const app = boot();
    const start = vi.fn(async () => []);
    Object.assign(app.auth.provider, { start });
    const resolve = vi.spyOn(app.auth.provider, 'resolve');
    const users = vi.spyOn(app.auth.provider, 'users');
    const { runtime, platform } = await startWithTestPlatform(app);
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    // index.ts starts the provider and syncs accounts before the stores
    // open; building the runtime adds no call of its own.
    expect(start).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
});
