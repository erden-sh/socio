import type { PublicFetch } from '../net/public-fetch';

import { workspaceLayout } from './layout';
import { type LogoFiles, refreshLogo } from './logo';
import type { Registry } from './registry';

// The open workspace's logo kept current (CB-574): `refresh` brings a
// scope's workspace up to its `branding.logo` (`refreshLogo`), one refresh at a
// time, and `current` says which file that scope's screens draw. Each scope
// keeps its own: a new scope reads the registry's row afresh (its snapshot),
// so a name kept by an earlier scope never applies to it, and a scope's entry
// goes when it closes. The screens hear of a new name inside `save`, before the
// old file is deleted, so they never point at a file that is gone.

/** The scope whose workspace is refreshed: its unique id, its row as it opened, and its signal. */
export interface LogoScope {
    readonly id: string;
    readonly workspace: { readonly id: string; readonly origin: string; readonly logo: string | null };
    readonly signal: AbortSignal;
}

export interface LogoKeeperDeps {
    /** The app's document directory, the store's root. */
    readonly root: string;
    readonly registry: Pick<Registry, 'get' | 'setLogo'>;
    readonly files: LogoFiles;
    readonly publicFetch: PublicFetch;
    readonly hash: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

export interface LogoKeeper {
    /**
     * The logo file name scope `scope` draws: its latest refresh, null (the
     * mascot) included, else its snapshot when it has none.
     */
    current(scope: Pick<LogoScope, 'id' | 'workspace'>): string | null;
    subscribe(listener: () => void): () => void;
    /** Brings the scope's workspace up to `logo`; resolves once done, never rejects. */
    refresh(scope: LogoScope, logo: string | null): Promise<void>;
}

export function createLogoKeeper(deps: LogoKeeperDeps): LogoKeeper {
    const kept = new Map<string, string | null>();
    const listeners = new Set<() => void>();
    let queue: Promise<void> = Promise.resolve();
    const run = async (scope: LogoScope, logo: string | null) => {
        if (scope.signal.aborted) {
            return;
        }
        const id = scope.workspace.id;
        const row = await deps.registry.get(id);
        if (row === null || row.state !== 'ready') {
            return;
        }
        await refreshLogo(logo, scope.workspace.origin, workspaceLayout(deps.root, id).directory, row.logo, {
            files: deps.files,
            publicFetch: deps.publicFetch,
            hash: deps.hash,
            save: async (name) => {
                await deps.registry.setLogo(id, name);
                if (!scope.signal.aborted) {
                    kept.set(scope.id, name);
                    for (const listener of [...listeners]) {
                        listener();
                    }
                }
            },
            signal: scope.signal,
        });
    };
    return {
        current: (scope) => {
            // No entry (undefined) is "not refreshed in this scope": its snapshot. A kept null is the mascot.
            const refreshed = kept.get(scope.id);
            return refreshed === undefined ? scope.workspace.logo : refreshed;
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        refresh: (scope, logo) => {
            if (!scope.signal.aborted) {
                scope.signal.addEventListener('abort', () => kept.delete(scope.id), { once: true });
            }
            queue = queue
                .then(() => run(scope, logo))
                .catch((error: unknown) => {
                    console.warn('[logo] not refreshed', error);
                });
            return queue;
        },
    };
}
