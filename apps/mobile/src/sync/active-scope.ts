import type { WorkspaceScope } from './scope';

// The active workspace's scope: at
// most one is open, and a switch disposes it completely before the next one
// opens, so nothing of one workspace (a row, a meta row or ETag, the jar, a
// pull in flight) can reach the next. The app shows the shell on the open
// scope, under a React key per scope (src/live/active-scope.tsx), and nothing
// while one is opening, so no screen ever draws a disposed scope's collections.
//
// `show(id)` asks for workspace `id`'s scope (null: none). The last call wins:
// a switch asked while another runs waits for it, and a scope that opens after
// a newer switch was asked is disposed without being shown. A scope that
// doesn't open is 'failed': nothing counts as shown, so asking for it again (or
// `retry()`) opens it again, and the app offers Try again, the other
// workspaces and Add a workspace (src/screens/workspace-failed.tsx).
// No React Native: tests/sync runs it under Node.

export type ActiveScopeState =
    | { readonly kind: 'none' }
    | { readonly kind: 'opening'; readonly workspaceId: string }
    | { readonly kind: 'open'; readonly scope: WorkspaceScope }
    | { readonly kind: 'failed'; readonly workspaceId: string; readonly error: unknown };

export interface ActiveScope {
    get(): ActiveScopeState;
    subscribe(listener: () => void): () => void;
    /** Shows workspace `workspaceId`'s scope, or none. Resolves once the scope shown is the last one asked for. Never rejects. */
    show(workspaceId: string | null): Promise<void>;
    /** Asks again for the workspace asked for last: opens it again after it failed. Never rejects. */
    retry(): Promise<void>;
}

export interface ActiveScopeOptions {
    /** Opens a workspace's scope (openWorkspaceScope with the app's bindings). */
    readonly open: (workspaceId: string) => Promise<WorkspaceScope>;
    /** A scope that didn't open. */
    readonly onError?: (error: unknown) => void;
}

const NONE: ActiveScopeState = { kind: 'none' };

export function createActiveScope({ open, onError = () => {} }: ActiveScopeOptions): ActiveScope {
    let state: ActiveScopeState = NONE;
    const listeners = new Set<() => void>();
    const set = (next: ActiveScopeState) => {
        state = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    /** The workspace asked for last, and the one shown: undefined while none is settled (between two). */
    let wanted: string | null = null;
    let shown: string | null | undefined = null;
    let current: WorkspaceScope | null = null;
    /** One switch at a time: each `show` queues one settle, so the last one always runs after the last ask. */
    let queue: Promise<void> = Promise.resolve();

    const settle = async () => {
        const target = wanted;
        if (target === shown) {
            return;
        }
        // The screens let go of the old scope first, then it closes, then the next opens.
        set(target === null ? NONE : { kind: 'opening', workspaceId: target });
        if (current !== null) {
            const old = current;
            current = null;
            shown = undefined;
            await old.dispose();
        }
        if (target === null) {
            shown = null;
            return;
        }
        if (wanted !== target) {
            return;
        }
        let next: WorkspaceScope;
        try {
            next = await open(target);
        } catch (error) {
            onError(error);
            // Not shown: the next ask for it (or retry) opens it again.
            shown = undefined;
            set({ kind: 'failed', workspaceId: target, error });
            return;
        }
        if (wanted !== target) {
            // A newer switch came while it opened: it never shows, and the next settle runs.
            shown = undefined;
            await next.dispose();
            return;
        }
        current = next;
        shown = target;
        set({ kind: 'open', scope: next });
    };

    const show = (workspaceId: string | null) => {
        wanted = workspaceId;
        queue = queue.then(settle).catch(onError);
        return queue;
    };

    return {
        get: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        show,
        retry: () => show(wanted),
    };
}
