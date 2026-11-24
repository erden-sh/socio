// Spaces' services are layers over the tags of other features' contracts.
// `Access` is the workspace's access once this runtime records the private-
// and deleted-Space contracts on its ownership; `Creation` is a socio's
// `create_space` over the workspace's slices, the approvals and the settings;
// in the server's graph the tags hold the instances `Platform` holds.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';

import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { RuntimeIdentity, type RuntimeIdentityShape } from '../src/server/runtime/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import {
    Access,
    Creation,
    SPACE_DELETE_CONTRACT,
    SPACE_DELETE_CONTRACT_NAME,
    SPACE_PRIVACY_CONTRACT,
    SPACE_PRIVACY_CONTRACT_NAME,
    SpaceAccessError,
} from '../src/server/spaces/contract.js';
import { SpaceCreation } from '../src/server/spaces/create.js';
import { AccessLive, CreationLive } from '../src/server/spaces/layer.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
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
};

function workspace() {
    const db = testDatabase();
    const store = new WorkspaceStore(db);
    cleanup.push(() => store.close());
    store.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    store.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    return { db, workspace: store };
}

/** A runtime identity whose ownership says whether a live runtime is behind. */
function identity(behind: { value: boolean }) {
    const calls: string[] = [];
    const attached: unknown[] = [];
    const shape = {
        attach: (db: unknown) => {
            attached.push(db);
            return {
                recordContract: (name: string, version: number) => calls.push(`record ${name} ${version}`),
                contractBehind: () => behind.value,
            };
        },
    } as unknown as RuntimeIdentityShape;
    return { shape, calls, attached };
}

it('Access records both contracts on the runtime, in order, and asks it before a Space is made private or deleted', async () => {
    const { db, workspace: store } = workspace();
    const behind = { value: true };
    const runtime = identity(behind);
    const access = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* Access;
        }).pipe(
            Effect.provide(
                AccessLive(Effect.succeed({ db, spaceAccess: store.spaceAccess })).pipe(
                    Layer.provide(Layer.succeed(RuntimeIdentity, runtime.shape)),
                ),
            ),
        ),
    );
    expect(access).toBe(store.spaceAccess);
    expect(runtime.attached).toEqual([db]);
    expect(runtime.calls).toEqual([
        `record ${SPACE_PRIVACY_CONTRACT_NAME} ${SPACE_PRIVACY_CONTRACT}`,
        `record ${SPACE_DELETE_CONTRACT_NAME} ${SPACE_DELETE_CONTRACT}`,
    ]);
    // A live runtime behind: a Space isn't made private (409).
    expect(() => access.requirePrivacyEnforced()).toThrow(SpaceAccessError);
    behind.value = false;
    expect(() => access.requirePrivacyEnforced()).not.toThrow();
});

it('Creation is a SpaceCreation over the slices, the approvals and the settings, and registers its capability', async () => {
    const { workspace: store } = workspace();
    const register = vi.fn();
    const approvals = { register } as unknown as ApprovalsShape;
    let spaceCreators: 'everyone' | 'admins' = 'everyone';
    const settings = { settings: () => ({ spaceCreators }) } as unknown as WorkspaceSettingsShape;
    const creation = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* Creation;
        }).pipe(
            Effect.provide(
                CreationLive.pipe(
                    Layer.provide(
                        Layer.mergeAll(
                            WorkspaceLive(store),
                            Layer.succeed(Access, store.spaceAccess),
                            Layer.succeed(Approvals, approvals),
                            Layer.succeed(WorkspaceSettings, settings),
                        ),
                    ),
                ),
            ),
        ),
    );
    expect(creation).toBeInstanceOf(SpaceCreation);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toMatchObject({
        capability: APPROVAL_CAPABILITIES.spaceCreate,
        manualOnly: true,
    });
    // The one rule, through the slices: a member's Space is private, theirs.
    const made = await creation.createAs({ id: 'bob', role: 'member' }, { name: 'Notes', description: '' });
    expect(store.spaceAccess.membersOnly(made.id)).toBe(true);
    expect(store.spaceAccess.canEdit(made.id, 'bob')).toBe(true);
    // The settings are read on every create.
    spaceCreators = 'admins';
    expect(() => creation.createAs({ id: 'bob', role: 'member' }, { name: 'More', description: '' })).toThrow(
        SpaceAccessError,
    );
});

it('in the server’s graph, the tags hold the workspace’s access and `Platform.spaceCreation`', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testDatabase();
    const store = new WorkspaceStore(db);
    const settings = new Store(db);
    const { runtime, platform } = await startWithTestPlatform({
        db,
        store: settings,
        workspace: store,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
    });
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
        settings.close();
        store.close();
    });
    const context = await runtime.context();
    expect(Context.get(context, Access)).toBe(store.spaceAccess);
    expect(Context.get(context, Creation)).toBe(platform.spaceCreation);
    expect(platform.spaceCreation).toBeInstanceOf(SpaceCreation);
    // This runtime recorded both contracts, so private Spaces may be made.
    expect(() => store.spaceAccess.requirePrivacyEnforced()).not.toThrow();
});
