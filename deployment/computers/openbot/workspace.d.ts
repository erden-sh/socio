// Editor-only types for OpenBot's agent-computer/src/workspace.ts at the
// pinned revision (b6932d3), which principal-worker.ts imports as
// `./workspace` inside the computer image. Only what the worker uses; never
// copied into an image.
export interface WorkspaceEntry {
    path: string;
    kind: 'file' | 'folder';
}

export interface Workspace {
    read(path: string): Promise<unknown>;
    write(path: string, contents: string, options?: { append?: boolean }): Promise<unknown>;
    list(path: string): Promise<{ path: string; entries: WorkspaceEntry[] }>;
}

export function createWorkspace(root: string): Workspace;
