import { MEDIA_LIMITS, UPLOAD_HEADER, type AttachmentView, type UploadResult } from '@socio/shared/media-types';

import { ApiError, api } from '../../../lib/api';
import { postWrite } from '../../../lib/change-channel';
import { forgetOnSignOut } from '../../../shell/auth-channel';

export interface UploadOptions {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
}

/**
 * Uploads one file as a chat attachment. Pending without `threadId` (the
 * new-chat composer), else in that conversation.
 */
export function uploadAttachment(
    file: File,
    options: UploadOptions & { threadId?: string } = {},
): Promise<UploadResult> {
    const query = new URLSearchParams({ purpose: 'attachment' });
    if (options.threadId) {
        query.set('threadId', options.threadId);
    }
    return uploadRaw(file, query, options);
}

/** Uploads one file into a folder of the user's files (the Media page). */
export function uploadToFolder(file: File, folder: string, options: UploadOptions = {}): Promise<UploadResult> {
    return uploadRaw(file, new URLSearchParams({ purpose: 'file', folder }), options);
}

/**
 * A file's raw bytes (no base64) to the one upload path, with the custom
 * header the server requires. XHR rather than fetch, for upload progress.
 */
function uploadRaw(file: File, query: URLSearchParams, options: UploadOptions): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/media/uploads?${query}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader(UPLOAD_HEADER, '1');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        if (file.type) {
            xhr.setRequestHeader('X-File-Type', file.type);
        }
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                options.onProgress?.(event.loaded / event.total);
            }
        };
        xhr.onload = () => {
            let body: { error?: string } = {};
            try {
                body = JSON.parse(xhr.responseText) as typeof body;
            } catch {
                // An unreadable answer is reported by status below.
            }
            if (xhr.status === 201) {
                postWrite('/media/uploads');
                resolve(body as UploadResult);
            } else {
                reject(new ApiError(body.error ?? `Upload failed (${xhr.status}).`, xhr.status));
            }
        };
        xhr.onerror = () => reject(new Error('The upload failed. Check your connection.'));
        xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
        options.signal?.addEventListener('abort', () => xhr.abort(), {
            once: true,
        });
        xhr.send(file);
    });
}

/** Removes an attachment that hasn't been sent, with its file. */
export const removeAttachment = (id: string) => api(`/media/attachments/${encodeURIComponent(id)}`, 'DELETE');

export interface MediaLimits {
    fileMaxBytes: number;
    perMessage: number;
    imageModelMaxBytes: number;
}
/** The defaults, until the server says. */
export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
    fileMaxBytes: 25 * 1024 * 1024,
    perMessage: MEDIA_LIMITS.perMessage,
    imageModelMaxBytes: 10 * 1024 * 1024,
};
let limits: Promise<MediaLimits> | undefined;
/** The server's upload limits, asked once per visit. */
export function mediaLimits() {
    limits ??= api<MediaLimits>('/media/limits').catch(() => {
        limits = undefined;
        return DEFAULT_MEDIA_LIMITS;
    });
    return limits;
}

const views = new Map<string, Promise<AttachmentView | null>>();
forgetOnSignOut(() => views.clear());
/** An attachment's metadata, kept for the visit; null once it is gone. */
export function attachmentView(id: string) {
    let view = views.get(id);
    if (!view) {
        view = api<AttachmentView>(`/media/attachments/${encodeURIComponent(id)}`).catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) {
                return null;
            }
            views.delete(id);
            throw error;
        });
        views.set(id, view);
    }
    return view;
}
