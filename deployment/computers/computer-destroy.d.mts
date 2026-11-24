export function destroyComputer(
    docker: unknown,
    names: {
        botId: string;
        container: string;
        profileVolume: string;
        workspaceVolume: string;
        privateVolume: string;
    },
    ours: (labels: Record<string, string> | undefined) => boolean,
    botLabel: string,
): Promise<{ botId: string; container: boolean; volumes: string[] }>;
