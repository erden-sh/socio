import { formatSize } from '@socio/shared/text/format-size';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';
import { httpError } from '../sync/errors';

import type { MessageFile } from './attachment-tray';

// A message's file chip (CB-413, the web's FileChip in MessageAttachments):
// its size and whether the file is still there, from `GET
// /api/media/attachments/:id` through the workspace's authedFetch (a 404, or
// a record whose file was deleted, is gone: "Removed"), and what a tap opens:
// the file's page in Media (CB-558, the `MediaFile` route by attachment id),
// never a browser. A copy still on the phone (a pending bubble's) asks nothing
// and opens nothing. No React Native here: tests/chat runs it under Node.

export const attachmentInfoPath = (id: string) => `/api/media/attachments/${encodeURIComponent(id)}`;

/** What the chip learns: the size, or that the file is gone. */
export type AttachmentInfo = { readonly state: 'there'; readonly size: number } | { readonly state: 'gone' };

export async function loadAttachmentInfo(
    fetch: AuthedFetch,
    id: string,
    signal?: AbortSignal,
): Promise<AttachmentInfo> {
    const response = await fetch(attachmentInfoPath(id), signal ? { signal } : undefined);
    if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        return { state: 'gone' };
    }
    if (!response.ok) {
        throw await httpError(response, signal);
    }
    const body = (await readJson(response, signal)) as { size?: unknown; path?: unknown } | null;
    if (body !== null && typeof body === 'object' && body.path === null) {
        return { state: 'gone' };
    }
    const size = body !== null && typeof body === 'object' ? body.size : undefined;
    return { state: 'there', size: typeof size === 'number' && size >= 0 ? size : -1 };
}

export interface FileChipView {
    /** The line under the name: the size once known, else the extension ("PDF"), or "Removed". */
    readonly note: string;
    readonly removed: boolean;
    /** What a tap opens, the file's page in Media by its attachment id, or null: a copy on the phone, or a removed file. */
    readonly opens: {
        readonly attachment: string;
        readonly name: string;
        readonly mediaType: string;
        readonly size?: number;
    } | null;
    readonly accessibilityLabel: string;
}

/** A file chip from its file and what the server said (null: not asked yet, or it failed). */
export function fileChipView(file: MessageFile, info: AttachmentInfo | null, removed = false): FileChipView {
    if (removed || info?.state === 'gone') {
        return { note: 'Removed', removed: true, opens: null, accessibilityLabel: `${file.name}, removed` };
    }
    const size = info?.state === 'there' && info.size >= 0 ? formatSize(info.size) : null;
    const note = size ?? (file.extension || 'File');
    if (file.local !== null) {
        return { note, removed: false, opens: null, accessibilityLabel: file.name };
    }
    return {
        note,
        removed: false,
        opens: {
            attachment: file.id,
            name: file.name,
            mediaType: file.mime,
            ...(info?.state === 'there' && info.size >= 0 ? { size: info.size } : {}),
        },
        accessibilityLabel: size === null ? `Open ${file.name}` : `Open ${file.name}, ${size}`,
    };
}
