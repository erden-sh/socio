// Editor-only types for OpenBot's agent-computer/src/shell.ts at the pinned
// revision (b6932d3), which principal-worker.ts imports as `./shell` inside
// the computer image. Only what the worker uses; never copied into an image.
export interface Shell {
    run(options: { command: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}

export function createShell(cwd: string, env?: Record<string, string | undefined>): Shell;
