import { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';

import * as contract from '../src/server/integrations/contract.js';
import { sqliteIntegrationRepositories } from '../src/server/integrations/infra/sqlite/index.js';
import { computersSchema, domainsSchema, telegramSchema, webSchema } from '../src/server/integrations/migrations.js';

// The repositories' interfaces moved to `integrations/contract.ts` (types
// only, re-exported at `domain/repositories.ts`), and each repository got a
// tag.

const cleanup: Array<() => void> = [];
afterEach(() => {
    cleanup.splice(0).forEach((fn) => fn());
});

it('names its tags socio/integrations/<Name>', () => {
    expect([
        contract.TelegramLinksRepo.key,
        contract.TelegramConversationsRepo.key,
        contract.TelegramRepliesRepo.key,
        contract.TelegramRoomCodesRepo.key,
        contract.TelegramTopicSendersRepo.key,
        contract.WebIdentitiesRepo.key,
        contract.WebAuditRepo.key,
        contract.ComputerPermissionsRepo.key,
        contract.ComputerAuditRepo.key,
        contract.DomainHostsRepo.key,
        contract.DomainOpsRepo.key,
    ]).toEqual([
        'socio/integrations/TelegramLinksRepo',
        'socio/integrations/TelegramConversationsRepo',
        'socio/integrations/TelegramRepliesRepo',
        'socio/integrations/TelegramRoomCodesRepo',
        'socio/integrations/TelegramTopicSendersRepo',
        'socio/integrations/WebIdentitiesRepo',
        'socio/integrations/WebAuditRepo',
        'socio/integrations/ComputerPermissionsRepo',
        'socio/integrations/ComputerAuditRepo',
        'socio/integrations/DomainHostsRepo',
        'socio/integrations/DomainOpsRepo',
    ]);
});

it('serves each tag with the SQLite repository the stores use today', async () => {
    const db = new DatabaseSync(':memory:');
    cleanup.push(() => db.close());
    migrate(db, [telegramSchema, webSchema, computersSchema, domainsSchema]);
    const repos = sqliteIntegrationRepositories(sqliteData(db));
    const layer = Layer.mergeAll(
        Layer.succeed(contract.TelegramLinksRepo, repos.telegramLinks),
        Layer.succeed(contract.TelegramConversationsRepo, repos.telegramConversations),
        Layer.succeed(contract.TelegramRepliesRepo, repos.telegramReplies),
        Layer.succeed(contract.TelegramRoomCodesRepo, repos.telegramRoomCodes),
        Layer.succeed(contract.TelegramTopicSendersRepo, repos.telegramTopicSenders),
        Layer.succeed(contract.WebIdentitiesRepo, repos.webIdentities),
        Layer.succeed(contract.WebAuditRepo, repos.webAudit),
        Layer.succeed(contract.ComputerPermissionsRepo, repos.computerPermissions),
        Layer.succeed(contract.ComputerAuditRepo, repos.computerAudit),
        Layer.succeed(contract.DomainHostsRepo, repos.domainHosts),
        Layer.succeed(contract.DomainOpsRepo, repos.domainOps),
    );

    const read = Effect.gen(function* () {
        const links = yield* contract.TelegramLinksRepo;
        const hosts = yield* contract.DomainHostsRepo;
        const identities = yield* contract.WebIdentitiesRepo;
        yield* Effect.promise(() => links.link('tg-1', 'user-1', null, 1));
        return {
            same: links === repos.telegramLinks && hosts === repos.domainHosts,
            userFor: yield* Effect.promise(() => links.userFor('tg-1')),
            hosts: yield* Effect.promise(() => hosts.all()),
            identity: yield* Effect.promise(() => identities.get('dot-1')),
        };
    });

    expect(await Effect.runPromise(Effect.provide(read, layer))).toEqual({
        same: true,
        userFor: 'user-1',
        hosts: [],
        identity: undefined,
    });
});
