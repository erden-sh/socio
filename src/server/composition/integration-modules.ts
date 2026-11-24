/**
 * The modules whose tables the Integrations context owns: computers, web,
 * Telegram and domains. Each folder's module file holds its hooks; the SQL of
 * its tables stays in `integrations/migrations.ts`, the only file besides the
 * context's repositories that names them (CB-110). This file joins the two, as
 * each module's own spread of its `SchemaSet` did, so the registry
 * (`modules/index.ts`) lists the same objects with the same id and migrations,
 * and the four folders need none of the context's files.
 */
import { computersModule as computersHooks } from '../computers/computer-module.js';
import { domainsModule as domainsHooks } from '../domains/module.js';
import { computersSchema, domainsSchema, telegramSchema, webSchema } from '../integrations/migrations.js';
import type { ServerModule } from '../modules/contract.js';
import { telegramModule as telegramHooks } from '../telegram/telegram-module.js';
import { webModule as webHooks } from '../web/web-module.js';

/** Computers: the permissions and audit tables, and the module's Dot tools. */
export const computersModule: ServerModule = { ...computersSchema, ...computersHooks };
/** Web: the web identity and audit tables, and the module's Dot tools. */
export const webModule: ServerModule = { ...webSchema, ...webHooks };
/** Telegram: the links, conversations, replies and room topics' tables, and the module's hooks. */
export const telegramModule: ServerModule = { ...telegramSchema, ...telegramHooks };
/** Domains: the hosts and operations tables, and the module's hooks. */
export const domainsModule: ServerModule = { ...domainsSchema, ...domainsHooks };
