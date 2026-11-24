/**
 * The app's protocol with the datasets' analytics process (CB-369),
 * over IPC in child mode. Each job names the dataset file the app already
 * authorized and the caps it runs under.
 */
import type { AnalyticalTable, StagedPart } from './declare.js';

/** What every DuckDB job runs with (`DataLimits`' analytics settings). */
interface DuckCaps {
    memoryMb: number;
    threads: number;
    tempMb: number;
    /** A directory of the job's own, removed after it. */
    tempDir: string;
}

export type WorkerJob =
    | ({
          kind: 'stage';
          datasetPath: string;
          table: AnalyticalTable;
          /** A request body the app streamed to disk, or a table of the same dataset (`append-from`). */
          source:
              | { kind: 'body'; file: string; format: 'ndjson' | 'json' }
              | {
                    kind: 'sqlite';
                    table: string;
                    where?: { column: string; from?: string | number; to?: string | number };
                };
          maxRows: number;
      } & DuckCaps)
    | ({
          kind: 'query';
          datasetPath: string;
          sql: string;
          params: Array<string | number | boolean | null>;
          maxRows: number;
          maxBytes: number;
          joinMaxRows: number;
          joinMaxBytes: number;
          timeoutMs: number;
      } & DuckCaps)
    | { kind: 'ping' };

export interface StageAnswer {
    parts: StagedPart[];
    rows: number;
}

export type WorkerReply =
    | { id: number; ok: true; value: unknown }
    | { id: number; ok: false; status: number; error: string };
