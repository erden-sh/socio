import { useTranslation } from '@socio/i18n/react';
import { acceptFiles as acceptAttachments, ATTACHMENT_EXTENSIONS } from '@socio/shared/issues/issue-attachment-files';
import type { IssueAttachment } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';
import { namedFile as namedAnyFile, pastedFiles } from '../../lib/files';
import { forgetOnSignOut } from '../../shell/auth-channel';

// Shared with chat attachments (`lib/files.ts`).
export { pastedFiles };

/** For the file picker's `accept`. */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_EXTENSIONS)
    .map((extension) => `.${extension}`)
    .join(',');

/** A pasted image has a generic name; give it one with its extension. */
export const namedFile = (file: File, index = 0) =>
    namedAnyFile(file, index, (extension) => extension in ATTACHMENT_EXTENSIONS);

/**
 * Splits picked or pasted files into those to upload and the reasons for
 * the rest (shared's `acceptFiles`), pasted ones named first.
 */
export const acceptFiles = (files: readonly File[], existing: number) =>
    acceptAttachments(
        files.map((file, index) => namedFile(file, index)),
        existing,
    );

const readAsDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error());
        reader.readAsDataURL(blob);
    });

/** A local preview of an image before it is uploaded (`data:`; the CSP allows it). */
export const previewUrl = (file: File) => (file.type.startsWith('image/') ? readAsDataUrl(file) : Promise.resolve(''));

/** Uploads one file to an issue, or to one of its comments. */
export async function uploadAttachment(number: number, file: File, commentId?: string): Promise<IssueAttachment> {
    const url = await readAsDataUrl(file);
    return api<IssueAttachment>(`/issues/${number}/attachments`, 'POST', {
        name: file.name,
        ...(file.type ? { mediaType: file.type } : {}),
        data: url.slice(url.indexOf(',') + 1),
        ...(commentId ? { commentId } : {}),
    });
}

/** A file that didn't upload: its name, and the server's reason when it gave one. */
export interface UploadFailure {
    name: string;
    reason?: string;
}

/** Uploads files one by one; returns each that failed (`useUploadProblems` words them). */
export async function uploadAll(number: number, files: readonly File[], commentId?: string) {
    const failed: UploadFailure[] = [];
    for (const file of files) {
        try {
            await uploadAttachment(number, file, commentId);
        } catch (error) {
            failed.push({
                name: file.name,
                ...(error instanceof Error && error.message ? { reason: error.message } : {}),
            });
        }
    }
    return failed;
}

/** Each failed upload as a line: "photo.png: <the reason>". */
export function useUploadProblems() {
    const { t } = useTranslation(['issues.form']);
    return (failed: readonly UploadFailure[]) =>
        failed.map((file) =>
            file.reason
                ? t('issues.form:upload-failed', { name: file.name, reason: file.reason })
                : t('issues.form:upload-failed-plain', { name: file.name }),
        );
}

/**
 * An attachment's bytes, fetched with the session cookie and kept for the
 * visit. Images come back as `data:` URLs, which the CSP allows.
 */
const fetched = new Map<string, Promise<Blob>>();
forgetOnSignOut(() => fetched.clear());
export function attachmentBlob(id: string) {
    let blob = fetched.get(id);
    if (!blob) {
        blob = fetch(`/api/issue-attachments/${encodeURIComponent(id)}`).then((response) => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return response.blob();
        });
        blob.catch(() => fetched.delete(id));
        fetched.set(id, blob);
    }
    return blob;
}
export const attachmentDataUrl = (id: string) => attachmentBlob(id).then(readAsDataUrl);

/** Saves an attachment through a temporary object URL. */
export async function downloadAttachment(file: IssueAttachment) {
    const url = URL.createObjectURL(await attachmentBlob(file.id));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
