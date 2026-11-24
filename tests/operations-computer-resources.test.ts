import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { migrate } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import { COMPUTER_RESOURCE_METRICS, type ComputerResourceMetric } from '@socio/shared/computers/computer-resources';
import { RESOURCE_METRICS, type ResourceValues } from '@socio/shared/operations/operations-resources';

import { SqliteResourceSamples, StaleResourceSample } from '../src/server/operations/infra/sqlite/samples.js';
import { operationsSchema } from '../src/server/operations/migrations.js';

import { testDatabase } from './helpers/test-database.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) {
        db.close();
    }
});
const values = {
    ...Object.fromEntries(Object.keys(RESOURCE_METRICS).map((key) => [key, null])),
    rssBytes: 7,
} as ResourceValues;
it('migrates existing server samples and rollups without rewriting observations', async () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    migrate(db, [
        {
            ...operationsSchema,
            migrations: operationsSchema.migrations!.slice(0, 2),
        },
    ]);
    db.prepare('INSERT INTO ops_samples(at,data) VALUES (?,?)').run(1000, JSON.stringify(values));
    const observed = Object.fromEntries(Object.keys(values).map((key) => [key, 1000]));
    db.prepare('INSERT INTO ops_samples_hourly(at,samples,data,observedAt) VALUES (?,?,?,?)').run(
        0,
        1,
        JSON.stringify(values),
        JSON.stringify(observed),
    );
    migrate(db, [operationsSchema]);
    const history = await new SqliteResourceSamples(sqliteData(db)).history(2000, 60);
    expect(history.latest).toEqual({ at: 1000, values });
    expect(history.hourly).toEqual([{ at: 0, samples: 1, values, observedAt: observed }]);
});
it('keeps server and computer measurements and gaps isolated at identical timestamps', async () => {
    const db = testDatabase();
    databases.push(db);
    const server = new SqliteResourceSamples(sqliteData(db));
    const computer = new SqliteResourceSamples<ComputerResourceMetric>(
        sqliteData(db),
        'dot-a',
        COMPUTER_RESOURCE_METRICS,
    );
    await server.record({ at: 1000, values }, 0);
    await computer.record(
        {
            at: 1000,
            values: {
                cpuPercent: 20,
                memoryBytes: 500,
                memoryLimitBytes: 1000,
                volumeBytes: 30,
                containerBytes: 4,
            },
        },
        0,
    );
    expect((await server.latest())?.values.rssBytes).toBe(7);
    const history = await computer.history(2000, 60);
    expect(history.latest?.values).toEqual({
        cpuPercent: 20,
        memoryBytes: 500,
        memoryLimitBytes: 1000,
        volumeBytes: 30,
        containerBytes: 4,
    });
    expect(history.hourly[0].samples).toBe(1);
    expect(history.gaps).toEqual([]);
    expect(
        (
            await new SqliteResourceSamples<ComputerResourceMetric>(
                sqliteData(db),
                'dot-b',
                COMPUTER_RESOURCE_METRICS,
            ).history(2000, 60)
        ).gaps,
    ).toHaveLength(5);
    expect(db.prepare('SELECT COUNT(*) n FROM ops_samples').get()?.n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) n FROM ops_samples_hourly').get()?.n).toBe(2);
});

it('checks stop generation after a telemetry write waits for the writer queue', async () => {
    const db = testDatabase();
    databases.push(db);
    const data = sqliteData(db),
        repository = new SqliteResourceSamples(data);
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const held = data.uow.run(async () => {
        await waiting;
    });
    let current = true;
    const writing = repository.record({ at: 1000, values }, 0, () => current);
    current = false;
    release();
    await held;
    expect(await writing).toBe(false);
    expect(await repository.latest()).toBeNull();
});

it('rolls back raw and hourly measurements if stop wins before the transaction commits', async () => {
    const db = testDatabase();
    databases.push(db);
    const repository = new SqliteResourceSamples(sqliteData(db));
    let checks = 0;
    await expect(repository.record({ at: 1000, values }, 0, () => ++checks === 1)).rejects.toBeInstanceOf(
        StaleResourceSample,
    );
    expect(await repository.latest()).toBeNull();
    expect(db.prepare('SELECT count(*) n FROM ops_samples_hourly').get()?.n).toBe(0);
});
