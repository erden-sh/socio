/**
 * Picked, pasted and dropped files: shared by issue attachments and chat
 * attachments (CB-54).
 */

const MIME_EXTENSION: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

/**
 * A pasted image has a generic name, or none: give it one with its
 * extension. `keep` says which extensions a name may keep as they are.
 */
export function namedFile(
    file: File,
    index = 0,
    keep: (extension: string) => boolean = (extension) => !!extension,
): File {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (file.name && keep(extension)) {
        return file;
    }
    const fallback = MIME_EXTENSION[file.type];
    if (!fallback) {
        return file;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return new File([file], `pasted-${stamp}${index ? `-${index}` : ''}.${fallback}`, { type: file.type });
}

/** Files on the clipboard (a pasted screenshot), if any. */
export function pastedFiles(data: DataTransfer | null): File[] {
    if (!data) {
        return [];
    }
    return [...data.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
}

/** Whether a drag carries files (not text or a link). */
export const dragHasFiles = (data: DataTransfer | null) => !!data && [...data.types].includes('Files');
