// The flags' layer and the composition's step build one `FlagService`, offered
// under every tag, from `FlagsConfig` and the people's roles.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { User } from '@socio/shared/types';

import { LegacyConfig, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { flagsLayers, LegacyFlags } from '../src/server/composition/flags.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { FlagAdmin, FlagRoles, Flags, FlagsConfig, FlagsWorkspace } from '../src/server/flags/contract.js';
import { FlagsLive } from '../src/server/flags/layer.js';
import { FlagService } from '../src/server/flags/service.js';
import { Audit, People, type AuditShape, type PeopleShape } from '../src/server/workspace/contract.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

const users: User[] = [
    { id: 'carol', name: 'Carol', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

/** People with Bob deactivated. */
const people = {
    users: () => users,
    isDeactivated: (id: string) => id === 'bob',
} as unknown as PeopleShape;
const audited: unknown[] = [];
const audit = { audit: (entry: unknown) => audited.push(entry) } as unknown as AuditShape;

it('offers one service as Flags and FlagAdmin, from FlagsConfig and FlagRoles', async () => {
    const layer = FlagsLive(database()).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(FlagsConfig, { env: { 'web-reads': false }, internal: false, tenantId: 'acme' }),
                Layer.succeed(FlagRoles, { role: (id) => (id === 'carol' ? 'admin' : undefined) }),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const flags = Context.get(context, FlagAdmin);
    expect(flags).toBeInstanceOf(FlagService);
    expect(Context.get(context, Flags)).toBe(flags);
    expect(flags.tenantId).toBe('acme');
    expect(flags.layers('web-reads').env).toBe(false);
    expect(flags.enabled('web-reads', 'carol')).toBe(false);
});

it("builds the graph's step from the config and People, under the legacy tag too", async () => {
    const db = database();
    const layer = flagsLayers.flags.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyConfig, {} as PlatformConfig),
                Layer.succeed(LegacyWorkspace, { db } as WorkspaceStore),
                Layer.succeed(People, people),
                Layer.succeed(Audit, audit),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const flags = Context.get(context, LegacyFlags);
    // The flag routes' people and audit (`FlagsWorkspace`): the workspace's.
    const routesWorkspace = Context.get(context, FlagsWorkspace);
    expect(routesWorkspace.users()).toBe(people.users());
    routesWorkspace.audit({ actor: 'alice', action: 'update', targetKind: 'feature_flag', targetId: 'web-reads' });
    expect(audited).toEqual([{ actor: 'alice', action: 'update', targetKind: 'feature_flag', targetId: 'web-reads' }]);
    expect(Context.get(context, Flags)).toBe(flags);
    expect(Context.get(context, FlagAdmin)).toBe(flags);
    // Today's defaults when FEATURE_FLAGS and TENANT_ID are unset.
    expect(Context.get(context, FlagsConfig)).toEqual({ env: {}, internal: false, tenantId: 'main' });
    expect(flags.tenantId).toBe('main');
    // A role rule reaches an active admin, never a deactivated person or a stranger.
    await flags.setRule('tenant', 'web-reads', { enabled: false, roles: ['admin', 'member'], people: [] }, 'carol');
    expect(flags.evaluate('web-reads', 'carol').enabled).toBe(true);
    expect(flags.evaluate('web-reads', 'bob').enabled).toBe(false);
    expect(flags.evaluate('web-reads', 'dan').enabled).toBe(false);
});
