import type { SqliteData } from '@socio/data/open';

import type { IntegrationRepositories } from '../../contract.js';

import { SqliteComputerAudit, SqliteComputerPermissions } from './computers.js';
import { SqliteDomainHosts, SqliteDomainOps } from './domains.js';
import { SqliteTelegramReplies } from './telegram-replies.js';
import { SqliteTelegramRoomCodes, SqliteTelegramTopicSenders } from './telegram-rooms.js';
import { SqliteTelegramConversations, SqliteTelegramLinks } from './telegram.js';
import { SqliteWebAudit, SqliteWebIdentities } from './web.js';

/**
 * The Integrations repositories on a migrated connection (CB-110): the
 * only code that reads or writes the Telegram, web, computer and domain
 * tables.
 */
export function sqliteIntegrationRepositories(data: SqliteData): IntegrationRepositories {
    return {
        telegramLinks: new SqliteTelegramLinks(data),
        telegramConversations: new SqliteTelegramConversations(data),
        telegramReplies: new SqliteTelegramReplies(data),
        telegramRoomCodes: new SqliteTelegramRoomCodes(data),
        telegramTopicSenders: new SqliteTelegramTopicSenders(data),
        webIdentities: new SqliteWebIdentities(data),
        webAudit: new SqliteWebAudit(data),
        computerPermissions: new SqliteComputerPermissions(data),
        computerAudit: new SqliteComputerAudit(data),
        domainHosts: new SqliteDomainHosts(data),
        domainOps: new SqliteDomainOps(data),
    };
}
