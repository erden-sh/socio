/**
 * The Integrations context's layer: its eleven repository tags (`contract.ts`),
 * over one set of SQLite repositories on a migrated connection. The context
 * reads no configuration and no other feature's tag. Only the composition
 * (`composition/integrations.ts`) and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';

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
    type IntegrationRepositories,
} from './contract.js';
import { sqliteIntegrationRepositories } from './infra/sqlite/index.js';

/** The SQLite repositories on `db` (the workspace's connection, migrated by the boot step). */
export function integrationRepositories(db: DatabaseSync): IntegrationRepositories {
    return sqliteIntegrationRepositories(sqliteData(db));
}

/** Each repository under its tag: the very objects `repos` holds. */
export const integrationsContext = (repos: IntegrationRepositories) =>
    Context.make(TelegramLinksRepo, repos.telegramLinks).pipe(
        Context.add(TelegramConversationsRepo, repos.telegramConversations),
        Context.add(TelegramRepliesRepo, repos.telegramReplies),
        Context.add(TelegramRoomCodesRepo, repos.telegramRoomCodes),
        Context.add(TelegramTopicSendersRepo, repos.telegramTopicSenders),
        Context.add(WebIdentitiesRepo, repos.webIdentities),
        Context.add(WebAuditRepo, repos.webAudit),
        Context.add(ComputerPermissionsRepo, repos.computerPermissions),
        Context.add(ComputerAuditRepo, repos.computerAudit),
        Context.add(DomainHostsRepo, repos.domainHosts),
        Context.add(DomainOpsRepo, repos.domainOps),
    );

/**
 * Every repository tag, over one set of repositories on `db`, made when
 * the layer is built; needs nothing.
 */
export const IntegrationsLive = (db: DatabaseSync) =>
    Layer.effectContext(Effect.sync(() => integrationsContext(integrationRepositories(db))));
