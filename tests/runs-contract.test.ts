// The runs contract: the tag other features will reach `runs/` through, and
// `sqliteRunRefs` serving it with today's `runRefRecorder`, unchanged.
import { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { runRefRecorder } from '@socio/foundation/runs/run-refs';

import { RunRefs } from '../src/server/runs/contract.js';
import { sqliteRunRefs } from '../src/server/runs/infra/sqlite/run-refs.js';

const RUN_REFS = `CREATE TABLE run_refs(id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, threadId TEXT NOT NULL, kind TEXT NOT NULL, spaceId TEXT, refId TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE(runId, kind, refId))`;

it('declares its tag under socio/runs', () => {
    expect(RunRefs.key).toBe('socio/runs/RunRefs');
});

it('serves RunRefs with the recorder the runner uses today', async () => {
    const viaTag = new DatabaseSync(':memory:');
    const direct = new DatabaseSync(':memory:');
    viaTag.exec(RUN_REFS);
    direct.exec(RUN_REFS);
    const refs = [
        { kind: 'page', spaceId: 's1', refId: 'p1' },
        { kind: 'search', refId: 'q' },
        { kind: 'page', spaceId: 's1', refId: 'p1' },
        { kind: 'unknown', refId: 'x' },
    ] as const;

    const record = await Effect.runPromise(
        Effect.gen(function* () {
            const runs = yield* RunRefs;
            return runs.recorder(viaTag, 'run-1', 't-1');
        }).pipe(Effect.provide(Layer.succeed(RunRefs, sqliteRunRefs))),
    );
    record(refs as never);
    runRefRecorder(direct, 'run-1', 't-1')(refs as never);

    const rows = (db: DatabaseSync) =>
        db.prepare('SELECT runId, threadId, kind, spaceId, refId FROM run_refs ORDER BY id').all();
    expect(rows(viaTag)).toEqual(rows(direct));
    expect(rows(viaTag)).toHaveLength(2);
});
