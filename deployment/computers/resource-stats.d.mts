export interface ResourceStats {
    botId: string;
    container: string;
    instance: string;
    running: boolean;
    values: {
        cpuPercent: number | null;
        memoryBytes: number | null;
        memoryLimitBytes: number | null;
        volumeBytes: number | null;
    };
}
export function readComputerStats(
    docker: unknown,
    names: {
        botId: string;
        container: string;
        workspaceVolume: string;
        profileVolume: string;
        privateVolume: string;
    },
    ours: (labels: Record<string, string> | undefined) => boolean,
    botLabel: string,
): Promise<ResourceStats | null>;
export function resourceValues(stats: unknown, limit: unknown, previous?: unknown): ResourceStats['values'];
