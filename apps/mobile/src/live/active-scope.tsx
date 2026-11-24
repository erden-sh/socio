import { type ReactNode, useEffect, useSyncExternalStore } from 'react';

import type { ActiveScope } from '../sync/active-scope';
import type { WorkspaceScope } from '../sync/scope';

import { WorkspaceScopeProvider } from './scope-context';

// The active workspace's scope for everything under it
// (src/sync/active-scope.ts): the open scope's provider, under a React key
// per scope, so a switch mounts the whole tree again (the navigation's state
// included, which opens on Home and then the workspace's last screen,
// src/shell/last-screen.ts). While a scope opens, nothing draws: the old one
// has gone from the tree before it closes. A scope that didn't open draws
// `failed` in place of the children (Try again, the other workspaces, Add a
// workspace). Without a scope (no workspace, adding one, locked) the children
// draw without it.

export function ActiveWorkspace({
    source,
    failed,
    children,
}: {
    source: ActiveScope;
    failed: (workspaceId: string) => ReactNode;
    children: ReactNode;
}) {
    const state = useSyncExternalStore(source.subscribe, source.get);
    if (state.kind === 'opening') {
        return null;
    }
    if (state.kind === 'failed') {
        return failed(state.workspaceId);
    }
    if (state.kind !== 'open') {
        return children;
    }
    return (
        <WorkspaceScopeProvider key={state.scope.id} scope={state.scope}>
            <StartSync scope={state.scope} />
            {children}
        </WorkspaceScopeProvider>
    );
}

/** Starts the scope's sync once its first frame has drawn (5.3). */
function StartSync({ scope }: { scope: WorkspaceScope }) {
    useEffect(() => {
        if (!scope.disposed) {
            scope.start();
        }
    }, [scope]);
    return null;
}
