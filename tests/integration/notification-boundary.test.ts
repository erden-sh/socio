import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { getTableName } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { notificationTables } from '../../src/server/notifications/infra/sqlite/schema.js';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * Notifications own their tables (CB-110): only its repositories in
 * src/server/notifications/infra read or write them. Its migrations create
 * them, and the change counters (CB-62) watch the in-app notices.
 */

const root = join(import.meta.dirname, '../..');
const INFRA = 'src/server/notifications/infra/';
const ALLOWED = new Set(['src/server/notifications/migrations.ts', 'src/server/live/change-counters.ts']);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

const names = notificationTables.map((table) => getTableName(table));
/** SQL naming a Notifications table: `FROM notifications`, `INTO "notification_images"`, … */
const statement = new RegExp(
    String.raw`\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON)\s+["'\x60\[]?(?:${names.join('|')})\b(?!\w)`,
);

it('spots SQL on a Notifications table', () => {
    for (const sql of [
        'SELECT COUNT(*) FROM notifications WHERE dotId = ?',
        'SELECT n FROM x JOIN "notification_deliveries" d ON d.notificationId = x.id',
        'INSERT INTO notification_images(token) VALUES (?)',
        'UPDATE notification_in_app SET seenAt = ?',
        'DELETE FROM notification_push_subscriptions',
        'INSERT INTO notification_settings VALUES (?, ?)',
    ]) {
        expect(sql).toMatch(statement);
    }
    for (const prose of [
        'SELECT * FROM notifications_v2',
        'Turn notifications on in Account → Notifications',
        'Notify them from notifications they chose',
        'SELECT * FROM issues',
    ]) {
        expect(prose).not.toMatch(statement);
    }
});

it('keeps SQL on the Notifications tables inside its infra', () => {
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
        if (/from '[./]*(?:notifications\/)?infra\/sqlite\/schema\.js'/.test(text)) {
            offenders.push(`${file}: imports the Notifications table schema`);
        }
    }
    expect(offenders).toEqual([]);
});
