import type { PluginReleaseNote } from '../plugins/plugin-release-notes.js';

import type { ReleaseSummary } from './releases.js';

/**
 * What's new across the workspace and its plugins (CB-527), the API the
 * web app and Socio Mobile share. Version 1 of these shapes; a change that
 * breaks them gets a new path.
 *
 * - `GET /api/v1/release-notes/plugins` → `PluginReleaseNotesResponse`:
 *   one card per installed, enabled plugin the person may open now (the
 *   same check as opening it), with its stored history.
 * - `GET /api/v1/whats-new` → `WhatsNewResponse`: what changed since the
 *   person last looked, for the once-per-person modal.
 * - `POST /api/v1/whats-new/seen` with `WhatsNewSeenRequest` →
 *   `WhatsNewResponse`: the person saw those versions (they dismissed the
 *   modal, or opened What's new). It only moves forward.
 *
 * Signed-in people only; data tokens and service keys are refused.
 */
export const WHATS_NEW_API_VERSION = 1;
export const PLUGIN_RELEASE_NOTES_PATH = '/api/v1/release-notes/plugins';
export const WHATS_NEW_PATH = '/api/v1/whats-new';
export const WHATS_NEW_SEEN_PATH = '/api/v1/whats-new/seen';

export type { PluginReleaseNote } from '../plugins/plugin-release-notes.js';

/** One plugin's card in the drawer and the versions list. */
export interface PluginReleaseNotesCard {
    /** The plugin's id. */
    id: string;
    name: string;
    /** The manifest's short icon name, when it has one (never a URL). */
    icon?: string;
    /** The installed version. */
    version: string;
    /**
     * The newest version the person has seen. Versions after it are new
     * to them; the rest fold away.
     */
    lastSeen: string;
    /** Newest first, at most `PLUGIN_RELEASE_HISTORY_MAX`. */
    releases: PluginReleaseNote[];
}

export interface PluginReleaseNotesResponse {
    apiVersion: typeof WHATS_NEW_API_VERSION;
    /** By name. Plugins with no stored notes are left out. */
    plugins: PluginReleaseNotesCard[];
}

/** The workspace's part of the modal: the releases after the last one seen. */
export interface WhatsNewWorkspace {
    /** The newest release the person had seen. */
    from: string;
    /** The newest release now: what `seen.workspace` takes. */
    to: string;
    /** Newest first, at most `WHATS_NEW_MAX_RELEASES`. */
    releases: ReleaseSummary[];
    /** How many releases are new in all (more than `releases` holds when capped). */
    count: number;
}

/** One updated plugin's part of the modal. */
export interface WhatsNewPlugin {
    id: string;
    name: string;
    icon?: string;
    /** The newest version the person had seen. */
    from: string;
    /** The installed version now: what `seen.plugins[id]` takes. */
    to: string;
    /** The versions after `from`, newest first, at most `WHATS_NEW_MAX_RELEASES`. */
    releases: PluginReleaseNote[];
    count: number;
}

export interface WhatsNewResponse {
    apiVersion: typeof WHATS_NEW_API_VERSION;
    /** Whether there is anything to show: the workspace or a plugin moved on. */
    show: boolean;
    workspace: WhatsNewWorkspace | null;
    plugins: WhatsNewPlugin[];
}

/**
 * What the person saw: the `to` of each part of the `WhatsNewResponse`
 * they were shown. Versions never move back; a plugin they may not open,
 * or a version it doesn't have, is left as it was.
 */
export interface WhatsNewSeenRequest {
    workspace?: string;
    plugins?: Record<string, string>;
}

/** Versions per part the modal carries; the drawer has the rest. */
export const WHATS_NEW_MAX_RELEASES = 3;
/** Plugins one `WhatsNewSeenRequest` may name. */
export const WHATS_NEW_SEEN_MAX_PLUGINS = 100;

/** The seen request that dismisses `whatsNew`, exactly as shown. */
export function seenRequestFor(whatsNew: WhatsNewResponse): WhatsNewSeenRequest {
    return {
        ...(whatsNew.workspace ? { workspace: whatsNew.workspace.to } : {}),
        ...(whatsNew.plugins.length
            ? { plugins: Object.fromEntries(whatsNew.plugins.map((plugin) => [plugin.id, plugin.to])) }
            : {}),
    };
}

/**
 * `request` as requests the server takes: at most
 * `WHATS_NEW_SEEN_MAX_PLUGINS` plugins each, the workspace with the first.
 */
export function seenRequestBatches(request: WhatsNewSeenRequest): WhatsNewSeenRequest[] {
    const plugins = Object.entries(request.plugins ?? {});
    const batches: WhatsNewSeenRequest[] = [];
    for (let at = 0; at < plugins.length || (at === 0 && request.workspace); at += WHATS_NEW_SEEN_MAX_PLUGINS) {
        const chunk = plugins.slice(at, at + WHATS_NEW_SEEN_MAX_PLUGINS);
        batches.push({
            ...(at === 0 && request.workspace ? { workspace: request.workspace } : {}),
            ...(chunk.length ? { plugins: Object.fromEntries(chunk) } : {}),
        });
    }
    return batches;
}
