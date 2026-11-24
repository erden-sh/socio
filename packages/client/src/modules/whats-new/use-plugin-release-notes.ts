import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react';

import { compareVersions, isReleaseVersion } from '@socio/shared/updates/release-seen';
import {
    PLUGIN_RELEASE_NOTES_PATH,
    WHATS_NEW_PATH,
    WHATS_NEW_SEEN_PATH,
    seenRequestBatches,
    seenRequestFor,
    type PluginReleaseNotesCard,
    type PluginReleaseNotesResponse,
    type WhatsNewResponse,
    type WhatsNewSeenRequest,
} from '@socio/shared/updates/whats-new';

import { api } from '../../lib/api';
import { ShellContext } from '../../shell/shell-context';

import { noteWorkspaceSeen } from './use-whats-new';

/** `api` takes paths under /api. */
const under = (path: string) => path.replace(/^\/api/, '');

/** The signed-in person, or none outside the shell (no cards, no modal). */
const usePersonId = () => useContext(ShellContext)?.workspace?.user?.id ?? '';

/** A plugin's card as the client keeps it. */
export interface PluginCard extends PluginReleaseNotesCard {
    /**
     * The `lastSeen` the page loaded with: versions after it show open on
     * the card until the page reloads, though opening What's new marked
     * them seen (as the workspace's cards stay until then).
     */
    since: string;
}

interface Notes {
    plugins: PluginCard[];
    loading: boolean;
}
const EMPTY: Notes = { plugins: [], loading: false };
const notes = new Map<string, Notes>();
const listeners = new Set<() => void>();
const set = (userId: string, next: Notes) => {
    notes.set(userId, next);
    for (const listener of listeners) {
        listener();
    }
};
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The cards a client can show: anything malformed is left out. */
function usable(response: PluginReleaseNotesResponse): PluginCard[] {
    if (response?.apiVersion !== 1 || !Array.isArray(response.plugins)) {
        return [];
    }
    return response.plugins
        .filter(
            (card) =>
                typeof card?.id === 'string' &&
                typeof card.name === 'string' &&
                isReleaseVersion(card.version) &&
                isReleaseVersion(card.lastSeen) &&
                Array.isArray(card.releases),
        )
        .map((card) => ({
            ...card,
            releases: card.releases.filter(
                (release) =>
                    isReleaseVersion(release?.version) &&
                    typeof release.date === 'string' &&
                    typeof release.notes === 'string',
            ),
            since: card.lastSeen,
        }))
        .filter((card) => card.releases.length > 0);
}

async function load(userId: string) {
    set(userId, { ...EMPTY, loading: true });
    try {
        set(userId, {
            plugins: usable(await api<PluginReleaseNotesResponse>(under(PLUGIN_RELEASE_NOTES_PATH))),
            loading: false,
        });
    } catch {
        set(userId, EMPTY);
    }
}

/** Versions of `card` after the one the page loaded with. */
export const newSince = (card: PluginCard) =>
    card.releases.filter((release) => compareVersions(release.version, card.since) > 0);

/** Whether a plugin has a version newer than the one last seen. */
const unseen = (card: PluginCard) => compareVersions(card.version, card.lastSeen) > 0;

/** Moves the cards' seen versions forward, as the server now has them. */
function noteSeen(userId: string, seen: Readonly<Record<string, string>>) {
    const current = notes.get(userId);
    if (!current) {
        return;
    }
    set(userId, {
        ...current,
        plugins: current.plugins.map((card) => {
            const version = seen[card.id];
            return version && compareVersions(version, card.lastSeen) > 0 ? { ...card, lastSeen: version } : card;
        }),
    });
}

/**
 * Records on the server that the person saw these versions, in requests
 * of at most `WHATS_NEW_SEEN_MAX_PLUGINS` plugins.
 */
export async function postSeen(userId: string, request: WhatsNewSeenRequest) {
    if (request.plugins) {
        noteSeen(userId, request.plugins);
    }
    if (request.workspace) {
        noteWorkspaceSeen(userId, request.workspace);
    }
    await Promise.all(
        seenRequestBatches(request).map((batch) => api<WhatsNewResponse>(under(WHATS_NEW_SEEN_PATH), 'POST', batch)),
    );
}

/**
 * The installed plugins' release notes cards the signed-in person may see
 * (CB-527), loaded once per page load; `markSeen` for when they open
 * What's new.
 */
export function usePluginReleaseNotes() {
    const userId = usePersonId();
    const current = useSyncExternalStore(
        subscribe,
        () => notes.get(userId) ?? EMPTY,
        () => EMPTY,
    );
    useEffect(() => {
        if (!userId || notes.has(userId)) {
            return;
        }
        void load(userId);
    }, [userId]);
    const markSeen = useCallback(() => {
        const plugins = (notes.get(userId) ?? EMPTY).plugins.filter(unseen);
        if (!plugins.length) {
            return;
        }
        void postSeen(userId, {
            plugins: Object.fromEntries(plugins.map((card) => [card.id, card.version])),
        }).catch(() => undefined);
    }, [userId]);
    return {
        plugins: current.plugins,
        loading: current.loading,
        unreadCount: current.plugins.filter(unseen).length,
        markSeen,
    };
}

/** The modal's answer, once per person per page load. */
const modals = new Map<string, WhatsNewResponse | null>();
const modalListeners = new Set<() => void>();
const setModal = (userId: string, value: WhatsNewResponse | null) => {
    modals.set(userId, value);
    for (const listener of modalListeners) {
        listener();
    }
};
const subscribeModal = (listener: () => void) => {
    modalListeners.add(listener);
    return () => modalListeners.delete(listener);
};

/** Only what the modal can show: a malformed answer shows nothing. */
function showable(value: WhatsNewResponse): WhatsNewResponse | null {
    if (value?.apiVersion !== 1 || value.show !== true || !Array.isArray(value.plugins)) {
        return null;
    }
    const workspace =
        value.workspace &&
        isReleaseVersion(value.workspace.to) &&
        Array.isArray(value.workspace.releases) &&
        value.workspace.releases.length
            ? value.workspace
            : null;
    const plugins = value.plugins.filter(
        (plugin) =>
            typeof plugin?.id === 'string' &&
            typeof plugin.name === 'string' &&
            isReleaseVersion(plugin.to) &&
            Array.isArray(plugin.releases) &&
            plugin.releases.length > 0,
    );
    return workspace || plugins.length ? { ...value, workspace, plugins } : null;
}

/**
 * "What's new" once per person per change set (CB-527): the server says
 * whether the workspace or a plugin they may open moved on since they last
 * looked. `dismiss` records exactly what was shown as seen, on the server,
 * so another device doesn't show it again.
 */
export function useWhatsNewModal() {
    const userId = usePersonId();
    const value = useSyncExternalStore(
        subscribeModal,
        () => modals.get(userId) ?? null,
        () => null,
    );
    useEffect(() => {
        if (!userId || modals.has(userId)) {
            return;
        }
        modals.set(userId, null);
        api<WhatsNewResponse>(under(WHATS_NEW_PATH))
            .then((answer) => setModal(userId, showable(answer)))
            .catch(() => setModal(userId, null));
    }, [userId]);
    const dismiss = useCallback(() => {
        const shown = modals.get(userId);
        if (!shown) {
            return;
        }
        setModal(userId, null);
        void postSeen(userId, seenRequestFor(shown)).catch(() => undefined);
    }, [userId]);
    return { whatsNew: value, dismiss };
}

/** Forgets the loaded cards and modal (tests). */
export function forgetPluginReleaseNotes() {
    notes.clear();
    modals.clear();
}
