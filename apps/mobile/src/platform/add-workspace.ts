import { File } from 'expo-file-system';

import { commitLogo, discardStagedLogos, type LogoFiles, type StagedLogo, stageLogo } from '../data/logo';
import { rootState } from '../navigation/root-gate';
import { type ManifestRead, type ProbeResult, probeWorkspace, readManifest } from '../net/probe';
import { createPublicFetch } from '../net/public-fetch';
import { gateVerdict } from '../sync/versions';

import { randomBytes } from './crypto';
import { launchedStore } from './device-store';
import { appFetch } from './fetch';
import { createExpoFileSystem, fileUri } from './file-system';
import { APP_USER_AGENT } from './user-agent';
import { BUILD_VARIANT } from './variant';

// What the add-workspace screens need from the phone: the probe
// through publicFetch (the app's one fetch, its User-Agent, no cookies, no
// Origin, redirects handed back), the logo's staging in the store's folder,
// and opening a workspace already on the phone. The logic is src/net's and
// src/data's, under Node; this binds it.

export const publicFetch = createPublicFetch({ fetch: appFetch, userAgent: APP_USER_AGENT });

/** The store's FileSystem plus expo-file-system's byte writes and moves (also workspace-logo.ts). */
export function logoFiles(): LogoFiles {
    const fs = createExpoFileSystem();
    return {
        mkdir: fs.mkdir,
        remove: fs.remove,
        write: async (path, bytes) => {
            await new File(fileUri(path)).write(bytes);
        },
        move: async (from, to) => {
            await new File(fileUri(from)).move(new File(fileUri(to)), { overwrite: true });
        },
    };
}

function store() {
    const launched = launchedStore();
    if (launched === null) {
        throw new Error('The store is not open.');
    }
    return launched.opened.store;
}

/** Whether a workspace at exactly `origin` is ready on the phone. */
async function readyRows(origin: string) {
    return (await store().registry.byOrigin(origin)).filter((row) => row.state === 'ready');
}

/** Probes the typed address with this build's rules (net/probe.ts). */
export function probe(text: string, signal: AbortSignal): Promise<ProbeResult> {
    return probeWorkspace(text, {
        variant: BUILD_VARIANT,
        publicFetch,
        isKnown: async (origin) => (await readyRows(origin)).length > 0,
        // The minimum-version gate's rule (sync/versions.ts), before any sign-in.
        serverVersionOk: (version) => gateVerdict(version, BUILD_VARIANT) === 'open',
        signal,
    });
}

/** The workspace's manifest, read now (SignIn when signing in again). */
export function readWorkspaceManifest(origin: string, signal: AbortSignal): Promise<ManifestRead> {
    return readManifest(origin, { publicFetch, signal });
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** Stages the workspace's logo for the confirm screen (data/logo.ts). */
export function stage(logo: string | null, origin: string, signal: AbortSignal): Promise<StagedLogo> {
    return stageLogo(logo, origin, {
        root: store().root,
        files: logoFiles(),
        publicFetch,
        randomName: () => hex(randomBytes(8)),
        signal,
    });
}

/** Moves a staged logo into the workspace's directory, for the sign-in commit; resolves with its file name. */
export function commitStaged(staged: StagedLogo, workspaceDirectory: string): Promise<string | null> {
    return commitLogo(staged, workspaceDirectory, store().root, logoFiles());
}

/** Deletes what is staged: a cancel, or what a kill left. */
export function discardStaged(): Promise<void> {
    const launched = launchedStore();
    return launched === null ? Promise.resolve() : discardStagedLogos(launched.opened.store.root, logoFiles());
}

/** Opens the workspace at `origin` that is already on the phone: the last one used there. */
export async function openKnown(origin: string): Promise<void> {
    const [latest] = (await readyRows(origin)).sort((a, b) => b.lastUsed - a.lastUsed);
    if (latest === undefined) {
        return;
    }
    await store().registry.setActive(latest.id);
    await rootState.refresh({ adding: false });
}
