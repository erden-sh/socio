/**
 * The stores over the Integrations repositories: computers' `ComputerStore`,
 * Telegram's `TelegramLinks` and web's `WebStore`. Each takes its unit of work
 * and repositories; this file builds them on a connection as each store's
 * constructor did, a set of repositories of its own per store, so the stores
 * need none of the Integrations context's files. The workspace store's parts
 * (`workspace-parts.ts`), web's reader (`web.ts`) and tests construct them
 * here.
 */
import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import { ComputerStore } from '../computers/computer-store.js';
import { integrationRepositories } from '../integrations/layer.js';
import { TelegramLinks } from '../telegram/telegram-links.js';
import { WebStore } from '../web/web-store.js';

/** The connection's unit of work and a set of Integrations repositories on it. */
function integrationsOn(db: DatabaseSync) {
    const { uow } = sqliteData(db);
    return { uow, repositories: integrationRepositories(db) };
}

/** Per-socio computer permissions and their audit, on `db`. */
export function computerStoreOn(db: DatabaseSync): ComputerStore {
    const { uow, repositories } = integrationsOn(db);
    return new ComputerStore({
        uow,
        permissions: repositories.computerPermissions,
        audits: repositories.computerAudit,
    });
}

/** The Telegram account links, conversations, replies and room topics, on `db`. */
export function telegramLinksOn(db: DatabaseSync): TelegramLinks {
    const { uow, repositories } = integrationsOn(db);
    return new TelegramLinks({
        uow,
        links: repositories.telegramLinks,
        conversations: repositories.telegramConversations,
        replies: repositories.telegramReplies,
        roomCodes: repositories.telegramRoomCodes,
        topicSenders: repositories.telegramTopicSenders,
    });
}

/** Per-socio web identity and the web-read audit, on `db`. */
export function webStoreOn(db: DatabaseSync): WebStore {
    const { uow, repositories } = integrationsOn(db);
    return new WebStore({ uow, identities: repositories.webIdentities, audits: repositories.webAudit });
}
