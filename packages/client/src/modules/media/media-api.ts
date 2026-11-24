import type { GrantAccess, GrantView } from '@socio/shared/data-types';
import type { MediaItem, MediaKind, MediaListing } from '@socio/shared/media-types';

import { api } from '../../lib/api';

/** What the page's filters and folder ask the server for. */
export interface MediaQuery {
    folder: string;
    q?: string;
    kind?: MediaKind;
    cursor?: string;
}

export function listMedia(query: MediaQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (query.folder) {
        params.set('folder', query.folder);
    }
    if (query.q?.trim()) {
        params.set('q', query.q.trim());
    }
    if (query.kind) {
        params.set('kind', query.kind);
    }
    if (query.cursor) {
        params.set('cursor', query.cursor);
    }
    const search = params.toString();
    return api<MediaListing>(`/media${search ? `?${search}` : ''}`, 'GET', undefined, signal);
}

const item = (id: string) => `/media/items/${encodeURIComponent(id)}`;

export const moveItem = (id: string, path: string) => api<MediaItem>(item(id), 'PATCH', { path });
export const deleteItem = (id: string) => api(item(id), 'DELETE');

export const createFolder = (path: string) => api<{ path: string }>('/media/folders', 'POST', { path });
export const moveFolder = (from: string, to: string) => api<{ path: string }>('/media/folders', 'PATCH', { from, to });
export const deleteFolder = (path: string) =>
    api<{ deleted: number }>(`/media/folders?path=${encodeURIComponent(path)}&recursive=1`, 'DELETE');

// Folder grants are the data space's (`/api/data/grants`).
export const listGrants = () => api<GrantView[]>('/data/grants');
export const saveGrant = (dotId: string, folder: string, access: GrantAccess) =>
    api<GrantView>('/data/grants', 'PUT', { dotId, folder, access });
export const revokeGrant = (id: string) => api(`/data/grants/${encodeURIComponent(id)}`, 'DELETE');

/** `reports/q3/` → `q3`; '' for the root. */
export const folderName = (folder: string) => folder.slice(0, -1).split('/').pop() ?? '';

/** `reports/q3/` → `reports/`; '' at the root. */
export function parentFolder(folder: string) {
    const trimmed = folder.slice(0, -1);
    const slash = trimmed.lastIndexOf('/');
    return slash < 0 ? '' : trimmed.slice(0, slash + 1);
}

/** `dots/<id>/` for a Dot's own folder, else undefined. */
export const dotFolderId = (folder: string) => /^dots\/([^/]+)\/$/.exec(folder)?.[1];

/**
 * A folder as people read it: the root is "All files", `attachments/` is
 * "Chat attachments", a Dot's folder carries the Dot's name.
 */
export function folderLabel(folder: string, dotName: (id: string) => string | undefined) {
    if (!folder) {
        return 'All files';
    }
    if (folder === 'attachments/') {
        return 'Chat attachments';
    }
    if (folder === 'dots/') {
        return 'Socios';
    }
    const dotId = dotFolderId(folder);
    if (dotId) {
        return dotName(dotId) ?? 'A deleted socio';
    }
    return folderName(folder);
}

/**
 * Breadcrumb folders that fit on one line: the last `keep` stay, and when
 * more than `keep + 1` are open the earlier ones collapse into `hidden`.
 */
export function collapseCrumbs(crumbs: readonly string[], keep = 2) {
    if (crumbs.length <= keep + 1) {
        return { hidden: [], shown: [...crumbs] };
    }
    return {
        hidden: crumbs.slice(0, crumbs.length - keep),
        shown: crumbs.slice(-keep),
    };
}

export const formatTime = (at: number) =>
    new Date(at).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

/** Native selects; `data-slot` keeps the legacy element styles off them. */
export const fieldClass = 'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs dark:bg-input/30';
