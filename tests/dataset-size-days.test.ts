import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { type DataActor } from '../src/server/dataspace/contract.js';
import { DataSpace } from '../src/server/dataspace/space.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

// CB-191: each write that measures a dataset keeps its sizes for the UTC
// day (the day's last measurement winning), so Operations can chart
// dataset sizes over time.

const DAY = 86_400_000;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('keeps each dataset’s sizes per UTC day, the day’s last write winning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 9, 20, 23, 0);
    vi.setSystemTime(start);
    const dir = mkdtempSync(join(tmpdir(), 'cb-size-days-'));
    const workspace = new WorkspaceStore(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: 'secret-0123456789abcdef-xyz',
        approvals: sqliteApprovals(workspace.db, {
            dotName: (id) => workspace.dot(id)?.name,
        }),
        workspace,
    });
    cleanup.push(() => {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    });
    // A person's own socio: its scratch is Alice's own (CB-337).
    const home = workspace.dots()[0]!.spaceId;
    const dot = workspace.createDot(home, 'Helper', 'Helps.', false, false, [home], null, false, null, false, 'alice');
    const actor: DataActor = { kind: 'dot', userId: 'alice', dotId: dot.id };
    const write = async (op: Parameters<DataSpace['write']>[2]) =>
        expect((await space.write(actor as Exclude<DataActor, { kind: 'user' }>, undefined, op)).status).toBe('done');
    const days = () =>
        workspace.db
            .prepare('SELECT day, sizeBytes, historyBytes, tableCount, measuredAt FROM data_dataset_days ORDER BY day')
            .all()
            .map((row) => ({ ...row }));
    const now = () => {
        const row = space.scratch('alice', dot.id)!;
        return {
            sizeBytes: row.sizeBytes,
            historyBytes: row.historyBytes,
            tableCount: row.tableCount,
        };
    };

    await write({
        op: 'create_table',
        input: {
            table: 'items',
            columns: [
                { name: 'k', type: 'TEXT', primaryKey: true },
                { name: 'v', type: 'TEXT' },
            ],
        },
    });
    vi.setSystemTime(start + 10 * 60_000);
    await write({
        op: 'insert',
        table: 'items',
        rows: [{ k: 'a', v: 'x'.repeat(20_000) }],
    });
    const first = now();
    expect(first.tableCount).toBe(1);
    // Two writes on the 20th: one row, the later's sizes.
    expect(days()).toEqual([
        {
            day: Math.floor(start / DAY),
            ...first,
            measuredAt: start + 10 * 60_000,
        },
    ]);
    // The next UTC day starts a row of its own.
    vi.setSystemTime(start + 2 * 3_600_000);
    await write({
        op: 'upsert',
        table: 'items',
        rows: [{ k: 'a', v: 'y'.repeat(40_000) }],
        key: ['k'],
    });
    const second = now();
    expect(second.historyBytes).toBeGreaterThan(0);
    expect(days()).toEqual([
        {
            day: Math.floor(start / DAY),
            ...first,
            measuredAt: start + 10 * 60_000,
        },
        {
            day: Math.floor(start / DAY) + 1,
            ...second,
            measuredAt: start + 2 * 3_600_000,
        },
    ]);
});
