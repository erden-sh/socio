import { EventType, type BaseEvent } from '@ag-ui/client';

import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Stored agent runs (the Runs module's data), which the turn runner
 * (`turns/local-runner.ts`) writes on its own connection. Databases from
 * before `source` and `errorDetail` gain them in place, as before. Moved
 * from the runner, so the module's schema is its own.
 */
export const runsSchema: SchemaSet = {
    id: MODULE_IDS.runs,
    migrations: [
        {
            version: 1,
            name: 'baseline',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['710ea57a8e4be830'],
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS agent_runs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        threadId TEXT NOT NULL,
        runId TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        events TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        finishedAt INTEGER,
        errorDetail TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_thread ON agent_runs(threadId, seq);`);
                if (
                    !db
                        .prepare('PRAGMA table_info(agent_runs)')
                        .all()
                        .some((column) => column.name === 'source')
                ) {
                    db.exec('ALTER TABLE agent_runs ADD COLUMN source TEXT');
                }
                if (
                    !db
                        .prepare('PRAGMA table_info(agent_runs)')
                        .all()
                        .some((field) => field.name === 'errorDetail')
                ) {
                    db.exec('ALTER TABLE agent_runs ADD COLUMN errorDetail TEXT');
                }
            },
        },
        {
            // A Dot's turns by time without reading their events (the admins'
            // Dots page): every column runsOfThreads reads is in the index.
            version: 2,
            name: 'runs by thread and time',
            up: 'CREATE INDEX agent_runs_thread_time ON agent_runs(threadId, startedAt, status, source, runId, finishedAt)',
        },
        {
            // Each event is stamped with its time now (CB-72). A run stored
            // before has only its row's times: they go on its RUN_STARTED (so its
            // user messages have a time) and its terminal event. The other events
            // keep none, and read as before.
            version: 3,
            name: 'event times',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['e2799f39db888bd1'],
            up: (db) => {
                const update = db.prepare('UPDATE agent_runs SET events=? WHERE seq=?');
                const rows = db.prepare('SELECT seq, events, startedAt, finishedAt FROM agent_runs').all() as {
                    seq: number;
                    events: string;
                    startedAt: number;
                    finishedAt: number | null;
                }[];
                for (const row of rows) {
                    const events = JSON.parse(row.events) as BaseEvent[];
                    const started = events.find((event) => event.type === EventType.RUN_STARTED);
                    const ended = events.findLast(
                        (event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR,
                    );
                    let changed = false;
                    if (started && started.timestamp === undefined) {
                        started.timestamp = row.startedAt;
                        changed = true;
                    }
                    if (ended && ended.timestamp === undefined && row.finishedAt) {
                        ended.timestamp = row.finishedAt;
                        changed = true;
                    }
                    if (changed) {
                        update.run(JSON.stringify(events), row.seq);
                    }
                }
            },
        },
        {
            // Each turn's trace (CB-128): its model rounds, tool calls, waits and
            // why its loop ended, as JSON (`RunTrace`). A column rather than
            // events, which every reader of the conversation replays: the trace
            // is for admins and the turn's owner, through the Runs view. Runs
            // stored before have none.
            version: 4,
            name: 'run traces',
            up: 'ALTER TABLE agent_runs ADD COLUMN trace TEXT',
        },
        {
            // CB-194: what grounded each turn (`packages/shared/src/runs/run-refs.ts`), references
            // only: a page, search result, dataset or recalled part of the chat,
            // each once per turn. Append-only; the Operations ETL reads it by id.
            version: 5,
            name: 'run refs',
            up: `CREATE TABLE run_refs(id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL CHECK(length(runId) > 0), threadId TEXT NOT NULL CHECK(length(threadId) > 0), kind TEXT NOT NULL CHECK(kind IN ('page','search','context','dataset','recall')), spaceId TEXT, refId TEXT NOT NULL CHECK(length(refId) BETWEEN 1 AND 200), at INTEGER NOT NULL, UNIQUE(runId, kind, refId));
      CREATE INDEX run_refs_thread ON run_refs(threadId, at);`,
        },
    ],
};
