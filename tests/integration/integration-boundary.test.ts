import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { integrationTables } from '../../src/server/integrations/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * The Integrations context owns its tables (CB-110): Telegram links and
 * conversations, web identity and audit, computer permissions and audit,
 * and the custom domains' hosts and operations. Only its repositories in
 * src/server/integrations/infra read or write them; its migrations create
 * them. Other code asks the services (TelegramLinks, WebStore,
 * ComputerStore, DomainsStore), and the admins' socio activity reads the
 * computer and web audits through their ports.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/integrations/infra/';
const ALLOWED = new Set(['src/server/integrations/migrations.ts']);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const names = integrationTables.map((table) => getTableName(table));
/** SQL naming an Integrations table: `FROM telegram_links`, `INTO "web_audit"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on an Integrations table', () => {
    for (const sql of [
        'SELECT userId FROM telegram_links WHERE telegramUserId=?',
        'DELETE FROM telegram_link_codes WHERE userId=?',
        'SELECT t.threadId FROM telegram_threads t JOIN telegram_members m ON m.chatId = t.chatId',
        'INSERT OR REPLACE INTO web_identity VALUES (?,?,?)',
        'SELECT id FROM "web_audit" WHERE dotId=?',
        'INSERT OR REPLACE INTO computer_permissions VALUES (?,?)',
        'UPDATE computer_audit SET outcome=? WHERE id=?',
        'SELECT * FROM domain_hosts ORDER BY hostname',
        "UPDATE domain_ops SET status = 'failed'",
        'CREATE INDEX domain_ops_host ON domain_ops(hostname, startedAt)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM telegram_links_v2',
        'Link your Telegram account first',
        'reads from the web audit',
        'SELECT * FROM computers',
    ]) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the Integrations tables inside its infra', () => {
    const offenders: string[] = [];
    for (const path of [
        ...sources(join(root, 'src')),
        ...sources(join(root, 'packages/client/src')),
        ...PACKAGE_SOURCES.flatMap((dir) => sources(join(root, dir))),
    ]) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (file.startsWith(INFRA) || ALLOWED.has(file)) {
            continue;
        }
        const text = readFileSync(path, 'utf8');
        // Over the whole file, so a statement split across lines counts too.
        for (const match of text.matchAll(new RegExp(statement, 'g'))) {
            offenders.push(`${file}:${text.slice(0, match.index).split('\n').length}`);
        }
        if (/from '[./]*(?:integrations\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Integrations tables' schema`);
        }
    }
    expect(offenders).toEqual([]);
});
