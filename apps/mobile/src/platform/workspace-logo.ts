import { createLogoKeeper, type LogoKeeper, type LogoScope } from '../data/logo-keeper';

import { logoFiles, publicFetch } from './add-workspace';
import { sha256BytesHex } from './crypto';
import { launchedStore } from './device-store';

// The open workspace's logo kept current (CB-574, src/data/logo-keeper.ts):
// screens/workspace-summary.tsx hands in `branding.logo` from the synced
// settings each time the scope opens and whenever it changes, and Home's
// workspace button draws `keptLogos.current(scope)`.

let keeper: LogoKeeper | null = null;
const listeners = new Set<() => void>();

function opened(): LogoKeeper | null {
    if (keeper === null) {
        const launched = launchedStore();
        if (launched === null) {
            return null;
        }
        const { store } = launched.opened;
        keeper = createLogoKeeper({
            root: store.root,
            registry: store.registry,
            files: logoFiles(),
            publicFetch,
            hash: sha256BytesHex,
        });
        keeper.subscribe(() => {
            for (const listener of [...listeners]) {
                listener();
            }
        });
    }
    return keeper;
}

/** The logo file name each scope draws, and its changes, for useSyncExternalStore. */
export const keptLogos = {
    /** The keeper's answer, null (the mascot) included; the scope's snapshot only before the store has opened. */
    current: (scope: Pick<LogoScope, 'id' | 'workspace'>): string | null => {
        const open = opened();
        return open === null ? scope.workspace.logo : open.current(scope);
    },
    subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** Brings the scope's workspace's logo up to `logo` (its `branding.logo`); never rejects. */
export function refreshWorkspaceLogo(scope: LogoScope, logo: string | null): Promise<void> {
    return opened()?.refresh(scope, logo) ?? Promise.resolve();
}
