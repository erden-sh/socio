import { createContext, Fragment, type ReactNode, use } from 'react';

import type { WorkspaceScope } from '../sync/scope';

// The open workspace's scope (src/sync/scope.ts) for the screens below it.
// Whoever opens the scope renders
// the provider with it, and disposes the scope after the provider has gone
// (a switch, a sign-out): everything under it remounts with a new scope, so no
// screen, live query or state of one workspace survives into another.

const ScopeContext = createContext<WorkspaceScope | null>(null);

export function WorkspaceScopeProvider({ scope, children }: { scope: WorkspaceScope; children: ReactNode }) {
    return (
        <ScopeContext value={scope}>
            <Fragment key={scope.id}>{children}</Fragment>
        </ScopeContext>
    );
}

/** The open workspace's scope. Throws outside WorkspaceScopeProvider. */
export function useWorkspaceScope(): WorkspaceScope {
    const scope = use(ScopeContext);
    if (scope === null) {
        throw new Error('No workspace scope here: render the screen inside WorkspaceScopeProvider.');
    }
    return scope;
}

/**
 * Whether a workspace scope is open here. A shell screen shows a placeholder
 * without one, rather than failing: nothing opens a scope until sign-in does.
 */
export function useHasWorkspaceScope(): boolean {
    return use(ScopeContext) !== null;
}
