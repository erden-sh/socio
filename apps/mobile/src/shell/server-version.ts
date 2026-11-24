// The server's version at the foot of Settings (CB-501), under the app's own two lines:
// "Server: Socio v0.51.0 (1a2b3c4)", as the web's Settings says "Socio v0.51.0 (1a2b3c4)".
// No React Native, so tests/shell runs it under Node.
//
// - The version is the one the scope's version rules hold (src/sync/versions.ts): `GET /api/state`'s
//   `version`, the highest seen, kept in the registry, so it is known at a cold start offline too.
// - The commit is `GET /api/releases?limit=0`'s (the web's footer asks the same), read while Settings
//   is open, and shown only beside the version it was read with: a deploy since never pairs a new
//   version with the old build's commit.
// - Nothing shows until a version is known, nor for '0.0.0' (a server that can't read its own).
//   While the server is away the line keeps the last version known and says so: "· last known".

import { isReleaseVersion } from '@socio/shared/updates/release-seen';
import type { ReleasesResponse } from '@socio/shared/updates/releases';

/** Where the commit is read: the web's footer asks the same (packages/client's app-version.ts). */
export const SERVER_RELEASES_PATH = '/api/releases?limit=0';

/** What the releases answer says of the running server. */
export interface ServerBuild {
    readonly version: string;
    readonly commit: string | null;
}

/** The running server's version and commit from `GET /api/releases?limit=0`'s body, or null when it reads as neither. */
export function parseServerBuild(body: unknown): ServerBuild | null {
    if (body === null || typeof body !== 'object') {
        return null;
    }
    const { current, commit } = body as Partial<ReleasesResponse>;
    if (!isReleaseVersion(current)) {
        return null;
    }
    return { version: current, commit: typeof commit === 'string' && commit.trim() !== '' ? commit.trim() : null };
}

/**
 * The footer's server line: "Server: Socio v0.51.0 (1a2b3c4)", " · last known" added while the server
 * is away (`offline`), or null while no version is known. `build` gives the commit when its version
 * is the one shown.
 */
export function serverVersionLine(version: string | null, build: ServerBuild | null, offline: boolean): string | null {
    if (version === null || !isReleaseVersion(version) || version === '0.0.0') {
        return null;
    }
    const commit = build !== null && build.version === version ? build.commit : null;
    return `Server: Socio v${version}${commit === null ? '' : ` (${commit.slice(0, 7)})`}${offline ? ' · last known' : ''}`;
}
