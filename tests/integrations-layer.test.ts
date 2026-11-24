// The integrations' layer and the composition's step offer every repository
// tag over one set of SQLite repositories on the workspace's connection.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { LegacyWorkspace } from '../src/server/composition/base.js';
import { integrationsLayers } from '../src/server/composition/integrations.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import {
    ComputerAuditRepo,
    ComputerPermissionsRepo,
    DomainHostsRepo,
    DomainOpsRepo,
    TelegramConversationsRepo,
    TelegramLinksRepo,
    TelegramRepliesRepo,
    TelegramRoomCodesRepo,
    TelegramTopicSendersRepo,
    WebAuditRepo,
    WebIdentitiesRepo,
} from '../src/server/integrations/contract.js';
import { SqliteDomainHosts } from '../src/server/integrations/infra/sqlite/domains.js';
import { SqliteTelegramLinks } from '../src/server/integrations/infra/sqlite/telegram.js';
import { IntegrationsLive } from '../src/server/integrations/layer.js';

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

const TAGS = [
    TelegramLinksRepo,
    TelegramConversationsRepo,
    TelegramRepliesRepo,
    TelegramRoomCodesRepo,
    TelegramTopicSendersRepo,
    WebIdentitiesRepo,
    WebAuditRepo,
    ComputerPermissionsRepo,
    ComputerAuditRepo,
    DomainHostsRepo,
    DomainOpsRepo,
] as const;

it('offers every repository tag, each a distinct SQLite repository, needing nothing', async () => {
    const context = await Effect.runPromise(Layer.build(IntegrationsLive(database())).pipe(Effect.scoped));
    const repos = TAGS.map((tag) => Context.get(context, tag as never) as object);
    expect(new Set(repos).size).toBe(TAGS.length);
    expect(Context.get(context, TelegramLinksRepo)).toBeInstanceOf(SqliteTelegramLinks);
    expect(Context.get(context, DomainHostsRepo)).toBeInstanceOf(SqliteDomainHosts);
});

it('reads and writes the connection it was given', async () => {
    const db = database();
    const program = Effect.gen(function* () {
        const links = yield* TelegramLinksRepo;
        yield* Effect.promise(() => links.link('tg-1', 'user-1', null, 1));
        return yield* Effect.promise(() => links.userFor('tg-1'));
    });
    expect(await Effect.runPromise(program.pipe(Effect.provide(IntegrationsLive(db))))).toBe('user-1');
    expect({ ...db.prepare('SELECT userId FROM telegram_links WHERE telegramUserId = ?').get('tg-1') }).toEqual({
        userId: 'user-1',
    });
});

it("builds the graph's step once, on the workspace's connection", async () => {
    const db = database();
    const layer = integrationsLayers.bridges.pipe(
        Layer.provide(Layer.succeed(LegacyWorkspace, { db } as WorkspaceStore)),
    );
    const program = Effect.gen(function* () {
        const first = yield* TelegramLinksRepo;
        const again = yield* TelegramLinksRepo;
        const hosts = yield* DomainHostsRepo;
        return { same: first === again, hosts: yield* Effect.promise(() => hosts.all()) };
    });
    expect(await Effect.runPromise(program.pipe(Effect.provide(layer)))).toEqual({ same: true, hosts: [] });
});
