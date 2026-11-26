import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, it } from 'vitest';

import { withoutComments } from '../../scripts/check-package-boundary.mjs';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

/*
 * Plain writes on the shared connection (CB-110). Every write from an
 * async path goes through `transaction()` or `writeSoon` (packages/data/src/open.ts),
 * so it can't land inside another chain's unit of work. This check can't
 * tell a wrapped `.prepare('INSERT …')` from a bare one, so it counts
 * them: a new one outside the `infra/` repositories fails here until its
 * file's count below is raised, which a reviewer then sees. Route it through `transaction()` or `writeSoon` first (see
 * docs/DATA-LAYER.md); lower a count when writes go.
 */

const root = join(import.meta.dirname, '../..');
const EXEMPT = [/\/infra\//];

/** Files with `.prepare(` writes today, and how many. */
const KNOWN = new Map<string, number>([
    // CB-338: the offline user rename rewrites any table, in its own
    // transaction, while the app is stopped.
    ['src/server/backup/rename-user.ts', 6],
    // The operator purge: its temporary id sets and the deletes by them, in
    // the one write transaction the CLI (or an operator's removal, CB-360)
    // holds on its own connection; and its audit line (run.ts).
    ['src/server/purge/purge.ts', 2],
    ['src/server/purge/run.ts', 1],
    // CB-380: a workspace bundle's import writes each table it copies into,
    // in chunked transactions, ids and times kept; and the image file rows.
    ['src/server/bundle/import.ts', 28],
    ['src/server/bundle/file-sink.ts', 1],
    // CB-124: the session ends inside the save's `transaction()`.
    ['src/server/auth/access-policy.ts', 1],
    ['src/server/agents/grants.ts', 6],
    // CB-124: called inside the access policy save's `transaction()` or the
    // CLI reset's `transactionSync`.
    ['src/server/auth/access-policy-store.ts', 4],
    // CB-124: a step-up passkey's counter; CB-360: an account's last
    // activity; CB-352: ending a signed-out device's session. All on Better
    // Auth's own connection (no unit of work there; Better Auth writes on it
    // the same way). CB-379: a session made for a person deactivated meanwhile.
    // CB-390: the workspace owner's row, their stored admin role, and its
    // audit line.
    ['src/server/auth/better-auth.ts', 9],
    // CB-390: the boot step that adds `admin` to flag rules naming the
    // retired operator role, on Better Auth's connection.
    ['src/server/auth/retire-operator.ts', 1],
    // CB-379: the device turn's lease row (take, renew, let go), on Better
    // Auth's connection like the rest of the auth database's own rows.
    ['src/server/auth/account-turns.ts', 3],
    // CB-376: groups' rows (the workspace organization, members, runtime
    // roles), on Better Auth's own connection like the two above, each
    // change in one SAVEPOINT (groups.ts `atomically`).
    ['src/server/auth/groups.ts', 7],
    // CB-352: the app's devices, on Better Auth's own connection like the
    // above: a sign-in's device in one SAVEPOINT (devices.ts `atomically`),
    // its hourly last-seen time and its session's renewed expiry.
    // and push endpoints still to clean up.
    ['src/server/auth/devices.ts', 13],
    // CB-352: the sign-in sheet's requests and Add a device's QR codes and
    // claims, on Better Auth's own connection: each a single statement
    // (made, approved or claimed, polled, tried, ended, used, cleaned up).
    ['src/server/auth/device-sign-in.ts', 24],
    ['src/server/telegram/channel-state.ts', 11],
    // CB-292: a suggestion's insert, settle and clear, each a prepared write.
    ['src/server/chat-name-suggestions/repository.ts', 3],
    // CB-217: a fold's version record and its pruning, in the fold's
    // `transaction()` with the notes and facts.
    ['src/server/context/notes.ts', 5],
    ['src/server/context/reactions.ts', 3],
    // CB-382: the reply reports' outbox and setting, every write inside a
    // `transaction()`, or inside the reaction's own (`file`, `withdraw`).
    ['src/server/cloud/reply-reports.ts', 15],
    // CB-215: a room admin's cancel of someone else's queued message, inside
    // `transaction()` as the others are.
    ['src/server/context/steering.ts', 8],
    ['src/server/context/time-markers.ts', 1],
    // DatasetEngine owns separate per-dataset connections; deleteRows, the
    // history prune and the analytical catalog's writes (CB-369; retention
    // and forgetting retired parts, CB-387; an admin's retention override,
    // CB-387) run inside write()'s BEGIN IMMEDIATE.
    ['src/server/dataspace/engine.ts', 14],
    // CB-451 step 3b: row stamps' install, generations, floor and tombstone
    // prune, on the engine's per-dataset connections inside write().
    ['src/server/dataspace/stamps.ts', 6],
    ['src/server/turns/local-runner.ts', 3],
    // The runs migration 3's event times backfill, in the migration's
    // transaction: moved with the runs schema from local-runner.ts.
    ['src/server/runs/migrations.ts', 1],
    // CB-194: a turn's references, one autocommit insert each on the runner's
    // own connection, as before: moved from runs' infra.
    ['packages/foundation/src/runs/run-refs.ts', 1],
    // The page search and revision migrations' backfills (pages 5 and 7),
    // in the migration's transaction.
    ['src/server/pages/pages.ts', 2],
    // CB-212: a room stream's end, signaled to the other runtimes, inside
    // `transaction()`.
    ['src/server/rooms/streams.ts', 1],
    // Runtime lease mutations all run inside transaction()/transactionSync();
    // CB-232 adds contract versions and work take-over, likewise.
    ['packages/data/src/runtime-ownership.ts', 20],
    // Store, split into slices; the 4 writes store.ts had, unchanged: its
    // seed row stays, the rest moved.
    ['src/server/settings/store.ts', 1],
    ['src/server/settings/secret-settings.ts', 2],
    ['src/server/settings/workspace-settings.ts', 1],
    // The workspace, split into slices, Conversations among them; the 33
    // writes workspace.ts had, unchanged.
    // CB-294: migration 19 updates previously-null dot characters.
    ['src/server/workspace/workspace.ts', 1],
    ['src/server/workspace/conversations.ts', 11],
    // The audit's queued line, and its awaited ones in one transaction (`auditNow`, CB-352).
    ['src/server/workspace/audit.ts', 2],
    ['src/server/workspace/people.ts', 6],
    ['src/server/workspace/socios.ts', 10],
    // CB-271: the socio's grant of a Space it made, in `createSpaceFor`'s
    // unit of work with the Space and its access. CB-277: a Space's delete
    // and restore stamps, each in its own `transaction()` with its audit.
    // CB-366: a Space's rename, in its own `transaction()` with its audit.
    ['src/server/workspace/spaces.ts', 5],
]);

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

/** A `.prepare(` of a literal statement; group 2 is the SQL. */
const prepared = /\.prepare\(\s*(['"`])([\s\S]*?)\1/g;
const write = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/;

function writes(text: string) {
    return [...withoutComments(text).matchAll(prepared)].filter((match) => write.test(match[2])).length;
}

it('spots a prepared write', () => {
    expect(writes("db.prepare('INSERT INTO t VALUES (?)').run(1)")).toBe(1);
    expect(writes('db.prepare(`UPDATE t SET a=? WHERE id=?`)')).toBe(1);
    expect(writes('db\n  .prepare(\n    "DELETE FROM t WHERE id=?",\n  )')).toBe(1);
    expect(writes("db.prepare('SELECT * FROM t WHERE id=?')")).toBe(0);
    expect(writes("db.prepare('SELECT updatedAt FROM t')")).toBe(0);
});

it('counts prose about a write as nothing', () => {
    expect(writes("// never a bare `.prepare('INSERT …').run()`\nconst a = 1;")).toBe(0);
    expect(writes("/* db.prepare('DELETE FROM t') */\ndb.prepare('UPDATE t SET a=1');")).toBe(1);
});

it('holds the data package to the count, and exempts only repositories', () => {
    const exempt = (file: string) => EXEMPT.some((pattern) => pattern.test(file));
    for (const file of [
        'packages/data/src/backup.ts',
        'packages/data/src/migrate.ts',
        'packages/data/src/object-store.ts',
        'packages/data/src/open.ts',
        'packages/data/src/uow.ts',
        'packages/data/src/a-new-file.ts',
    ]) {
        expect(exempt(file), file).toBe(false);
    }
    expect(exempt('packages/data/src/infra/sqlite/ledger.ts')).toBe(true);
    expect(exempt('src/server/coding/infra/tables.ts')).toBe(true);
});

it('counts the plain writes on the connection outside the repositories', () => {
    const found = new Map<string, number>();
    for (const path of [
        ...sources(join(root, 'src')),
        ...sources(join(root, 'packages/client/src')),
        ...PACKAGE_SOURCES.flatMap((dir) => sources(join(root, dir))),
    ]) {
        const file = relative(root, path).replaceAll('\\', '/');
        if (EXEMPT.some((pattern) => pattern.test(file))) {
            continue;
        }
        const count = writes(readFileSync(path, 'utf8'));
        if (count) {
            found.set(file, count);
        }
    }
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(KNOWN));
});
