import MASCOT from '../../assets/icon-512.png';
import { fileUri } from '../platform/file-system';
import { SquircleImage } from '../ui';

// A workspace's logo: the file staged at sign-in and kept in the
// workspace's directory (src/data/logo.ts), drawn in a squircle (owner,
// 2026-11-08), or the bundled mascot. Hidden from screen readers: the row or button beside it names
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
