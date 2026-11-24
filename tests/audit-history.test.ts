import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { domainsRepositories } from '../src/server/composition/domains.js';
import { computerStoreOn, webStoreOn } from '../src/server/composition/integration-stores.js';
import { DomainsStore } from '../src/server/domains/store.js';

import { testDatabase } from './helpers/test-database.js';

// The audit and run history tables keep every row. Their reads stay a page of
// the newest rows, served by an index, so a table of 100,000 rows answers as
// fast as one of 1,000.

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
vi.setConfig({ testTimeout: 30_000 });

const ROWS = 100_000;
const DOTS = 10;

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}
/** Inserts `rows` rows in one transaction, `fill(i)` giving each one's values. */
function fill(db: DatabaseSync, sql: string, rows: number, values: (i: number) => Array<string | number | null>) {
    const insert = db.prepare(sql);
    db.exec('BEGIN');
    for (let i = 0; i < rows; i++) {
        insert.run(...values(i));
    }
    db.exec('COMMIT');
    db.exec('ANALYZE');
}
/** The best of a few runs, in ms: the read's cost without the machine's noise. */
function best(read: () => unknown, runs = 7) {
    let fastest = Infinity;
    for (let i = 0; i < runs; i++) {
        const start = performance.now();
        read();
        fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
}
/** `best` for a read through a repository (CB-110), which is async. */
async function bestAsync(read: () => Promise<unknown>, runs = 7) {
    let fastest = Infinity;
    for (let i = 0; i < runs; i++) {
        const start = performance.now();
        await read();
        fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
}
const plan = (db: DatabaseSync, sql: string) =>
    db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail));

it('keeps every computer audit entry, and reads a Dot’s latest 50 through an index', async () => {
    const db = database();
    const store = computerStoreOn(db);
    // More than the old cap of 1,000 finished entries per Dot.
    for (let i = 0; i < 1_005; i++) {
        store.finish(store.begin('dot-a', `action ${i}`, 'agent', 'alice'), 'succeeded');
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM computer_audit WHERE dotId='dot-a'").get()).toEqual({ n: 1_005 });

    fill(
        db,
        'INSERT INTO computer_audit (id,dotId,action,actor,outcome,createdAt,userId) VALUES (?,?,?,?,?,?,?)',
        ROWS,
        (i) => [`c${i}`, `dot-${i % DOTS}`, 'shell', 'agent', 'succeeded', 1_000 + i, 'alice'],
    );
    expect(
        plan(
            db,
            "SELECT id,action,actor,userId,outcome,createdAt FROM computer_audit WHERE dotId='dot-3' ORDER BY createdAt DESC LIMIT 50",
        ),
    ).toEqual(['SEARCH computer_audit USING INDEX computer_audit_dot (dotId=?)']);
    const latest = await store.audit('dot-3');
    expect(latest).toHaveLength(50);
    expect(latest[0].id).toBe(`c${ROWS - 7}`);
    expect(await bestAsync(() => store.audit('dot-3'))).toBeLessThan(5);
});

it('keeps every web audit line, and reads a Dot’s latest 50 through an index', async () => {
    const db = database();
    const store = webStoreOn(db);
    for (let i = 0; i < 1_005; i++) {
        store.record({
            dotId: 'dot-a',
            userId: 'alice',
            method: 'GET',
            host: 'example.com',
            path: `/page/${i}`,
            status: 200,
            bytes: 1_000,
            outcome: 'fetched',
        });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM web_audit WHERE dotId='dot-a'").get()).toEqual({ n: 1_005 });
    expect((await store.audit('dot-a', 1))[0].path).toBe('/page/1004');

    fill(
        db,
        'INSERT INTO web_audit (id,dotId,userId,method,host,path,status,bytes,outcome,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ROWS,
        (i) => [
            `w${i}`,
            `dot-${i % DOTS}`,
            'alice',
            'GET',
            'docs.example.com',
            `/guides/item-${i}?q=&page=`,
            200,
            12_345,
            'fetched',
            Date.now() + i,
        ],
    );
    expect(
        plan(db, "SELECT id FROM web_audit WHERE dotId='dot-3' ORDER BY createdAt DESC, rowid DESC LIMIT 50"),
    ).toEqual(['SEARCH web_audit USING INDEX web_audit_dot (dotId=?)']);
    const latest = await store.audit('dot-3');
    expect(latest).toHaveLength(50);
    expect(latest[0].id).toBe(`w${ROWS - 7}`);
    expect(await bestAsync(() => store.audit('dot-3'))).toBeLessThan(5);
});

it('keeps every domain operation, and finds the latest and a hostname’s last through indexes', async () => {
    const db = database();
    let now = 1_000;
    const store = new DomainsStore(domainsRepositories(db), () => now++);
    // More than the old cap of 500.
    for (let i = 0; i < 505; i++) {
        const op = await store.startOp('provision', `app-${i % 5}.example.com`, 'olga');
        await store.finishOp(op.id, []);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM domain_ops').get()).toEqual({
        n: 505,
    });

    fill(
        db,
        "INSERT INTO domain_ops(id, kind, hostname, actor, status, steps, startedAt, finishedAt) VALUES (?, 'provision', ?, 'olga', 'ok', '[]', ?, ?)",
        ROWS,
        (i) => [`o${i}`, `host-${i % 1_000}.example.com`, 10_000 + i, 10_001 + i],
    );
    expect(
        plan(
            db,
            "SELECT * FROM domain_ops WHERE hostname = 'host-7.example.com' AND status <> 'running' ORDER BY startedAt DESC, rowid DESC LIMIT 1",
        ),
    ).toEqual(['SEARCH domain_ops USING INDEX domain_ops_host (hostname=?)']);
    expect(await store.ops()).toHaveLength(20);
    expect((await store.ops())[0].id).toBe(`o${ROWS - 1}`);
    expect((await store.lastOp('host-7.example.com'))?.id).toBe(`o${ROWS - 993}`);
    expect(await bestAsync(() => store.ops())).toBeLessThan(5);
    expect(await bestAsync(() => store.lastOp('host-7.example.com'))).toBeLessThan(5);
});

it('reads a job’s runs and trims old output through indexes, with every run kept', () => {
    const db = database();
    const jobs = 20;
    fill(
        db,
        "INSERT INTO job_runs (id, jobId, version, userId, dotId, trigger, status, queuedAt, startedAt, finishedAt, exitCode, stdout, stderr, outputTrimmedAt) VALUES (?, ?, 1, 'alice', 'dot-1', 'schedule', 'succeeded', ?, ?, ?, 0, ?, ?, ?)",
        ROWS,
        (i) => {
            // Each job's newest 50 keep their output, as trimming leaves them.
            const recent = i >= ROWS - jobs * 50;
            return [
                `r${i}`,
                `job-${i % jobs}`,
                i,
                i,
                i + 1,
                recent ? 'ok\n' : null,
                recent ? '' : null,
                recent ? null : i + 2,
            ];
        },
    );
    const trim = `UPDATE job_runs SET stdout=NULL, stderr=NULL, outputTrimmedAt=1 WHERE jobId='job-3' AND outputTrimmedAt IS NULL AND status IN ('succeeded', 'failed') AND id NOT IN (SELECT id FROM job_runs WHERE jobId='job-3' ORDER BY queuedAt DESC, rowid DESC LIMIT 50)`;
    expect(plan(db, trim)[0]).toBe('SEARCH job_runs USING INDEX job_runs_untrimmed (jobId=?)');
    expect(best(() => db.exec(trim))).toBeLessThan(5);
    const page = db.prepare("SELECT * FROM job_runs WHERE jobId='job-3' ORDER BY queuedAt DESC, rowid DESC LIMIT 20");
    expect(plan(db, page.sourceSQL)).toEqual(['SEARCH job_runs USING INDEX job_runs_job (jobId=?)']);
    expect(best(() => page.all())).toBeLessThan(5);
    // "Load more": the runs before one of the job's, deep in its history.
    const older = db.prepare(
        "SELECT * FROM job_runs WHERE jobId='job-3' AND (queuedAt, rowid) < (SELECT queuedAt, rowid FROM job_runs WHERE id='r50003') ORDER BY queuedAt DESC, rowid DESC LIMIT 21",
    );
    expect(plan(db, older.sourceSQL)[0]).toBe('SEARCH job_runs USING INDEX job_runs_job (jobId=? AND queuedAt<?)');
    expect(older.all()[0]).toMatchObject({ id: 'r49983' });
    expect(best(() => older.all())).toBeLessThan(5);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_runs').get()).toEqual({
        n: ROWS,
    });
    // The operators' counts by status don't read the runs (schedules 4).
    const counts = db.prepare('SELECT status, n FROM job_run_counts WHERE n > 0');
    expect(counts.all().map((row) => ({ ...row }))).toEqual([{ status: 'succeeded', n: ROWS }]);
    expect(best(() => counts.all())).toBeLessThan(1);
});
