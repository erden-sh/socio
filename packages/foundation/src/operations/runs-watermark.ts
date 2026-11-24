// Moved from `src/server/operations/etl/runs-step.ts`, which re-exports it. Pure.

/**
 * Where the turns' ETL got to: every turn up to `seq` has been read, and
 * `running` are the ones that were still running, read again until they
 * finish. In effect the watermark stops below the oldest running turn,
 * without reading the turns after it again.
 */
export interface RunsWatermark {
    seq: number;
    running: number[];
}

export function readRunsWatermark(text: string | null): RunsWatermark {
    if (!text) {
        return { seq: 0, running: [] };
    }
    try {
        const value = JSON.parse(text) as Partial<RunsWatermark>;
        return {
            seq: Number.isInteger(value.seq) ? value.seq! : 0,
            running: Array.isArray(value.running) ? value.running.filter(Number.isInteger) : [],
        };
    } catch {
        return { seq: 0, running: [] };
    }
}
