import { useSyncExternalStore } from 'react';

import MASCOT from '../../assets/icon-512.png';
import type { LogoScope } from '../data/logo-keeper';
import { storeRoot } from '../platform/active-scope';
import { fileUri } from '../platform/file-system';
import { keptLogos } from '../platform/workspace-logo';
import { workspaceLogoPath } from '../shell/workspaces';
import { SquircleImage } from '../ui';

// A workspace's logo: the file staged at sign-in and kept in the
// workspace's directory (src/data/logo.ts), or the one its branding changed to
// since (CB-574), drawn in a squircle (owner, 2026-11-08), or the bundled
// mascot. Hidden from screen readers: the row or button beside it names
// the workspace.

export function WorkspaceLogo({
    path,
    size,
    ring = null,
}: {
    path: string | null;
    size: number;
    ring?: string | null;
}) {
    return <SquircleImage size={size} source={path === null ? MASCOT : { uri: fileUri(path) }} ring={ring} />;
}

/** The open scope's logo path (null: the mascot), following a refresh while the scope is open. */
export function useWorkspaceLogoPath(scope: Pick<LogoScope, 'id' | 'workspace'>): string | null {
    const logo = useSyncExternalStore(keptLogos.subscribe, () => keptLogos.current(scope));
    return workspaceLogoPath(storeRoot(), scope.workspace.id, logo);
}
