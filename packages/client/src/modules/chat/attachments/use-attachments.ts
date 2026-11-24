import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';

import type { AttachmentRef } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { dragHasFiles, namedFile, pastedFiles } from '../../../lib/files';

import { DEFAULT_MEDIA_LIMITS, mediaLimits, removeAttachment, uploadAttachment } from './upload';

/** One file in a composer's tray. */
export interface TrayItem {
    key: string;
    name: string;
    size: number;
    /** An image by its declared type: a thumbnail once uploaded. */
    image: boolean;
    status: 'uploading' | 'ready' | 'failed';
    /** 0 to 1 while uploading. */
    progress: number;
    ref?: AttachmentRef;
    error?: string;
}

let counter = 0;

/**
 * A composer's attachments (CB-54): files are uploaded as soon as they are
 * picked, pasted or dropped (into `threadId`, or pending without it), and
 * shown with their progress; removing a ready one deletes it on the
 * server. `refs` are what the message carries; sending waits for uploads.
 */
export function useAttachments(threadId?: string) {
    const [items, setItems] = useState<TrayItem[]>([]);
    const [notice, setNotice] = useState('');
    const [dropActive, setDropActive] = useState(false);
    const [limits, setLimits] = useState(DEFAULT_MEDIA_LIMITS);
    const files = useRef(new Map<string, File>());
    const uploads = useRef(new Map<string, AbortController>());
    useEffect(() => {
        let live = true;
        void mediaLimits().then((value) => live && setLimits(value));
        return () => {
            live = false;
        };
    }, []);
    useEffect(
        () => () => {
            for (const controller of uploads.current.values()) {
                controller.abort();
            }
        },
        [],
    );
    const update = (key: string, change: Partial<TrayItem>) =>
        setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
    const start = useCallback(
        (key: string, file: File) => {
            const controller = new AbortController();
            uploads.current.set(key, controller);
            update(key, { status: 'uploading', progress: 0, error: undefined });
            uploadAttachment(file, {
                threadId,
                signal: controller.signal,
                onProgress: (progress) => update(key, { progress }),
            })
                .then((result) => {
                    files.current.delete(key);
                    update(key, {
                        status: 'ready',
                        progress: 1,
                        ref: result.attachment,
                    });
                })
                .catch((error: unknown) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    update(key, {
                        status: 'failed',
                        error: error instanceof Error ? error.message : 'Upload failed.',
                    });
                })
                .finally(() => uploads.current.delete(key));
        },
        [threadId],
    );
    const add = useCallback(
        (picked: readonly File[]) => {
            const problems: string[] = [];
            const accepted: TrayItem[] = [];
            picked.forEach((raw, index) => {
                const file = namedFile(raw, index);
                if (!file.size) {
                    problems.push(`${file.name} is empty.`);
                } else if (file.size > limits.fileMaxBytes) {
                    problems.push(
                        `${file.name} is ${formatSize(file.size)}; files can be at most ${formatSize(limits.fileMaxBytes)}.`,
                    );
                } else if (items.length + accepted.length >= limits.perMessage) {
                    problems.push(`${file.name}: a message can carry at most ${limits.perMessage} attachments.`);
                } else {
                    const key = `attachment-${++counter}`;
                    files.current.set(key, file);
                    accepted.push({
                        key,
                        name: file.name,
                        size: file.size,
                        image: file.type.startsWith('image/'),
                        status: 'uploading',
                        progress: 0,
                    });
                }
            });
            setNotice(problems.join(' '));
            if (!accepted.length) {
                return;
            }
            setItems((current) => [...current, ...accepted]);
            for (const item of accepted) {
                start(item.key, files.current.get(item.key)!);
            }
        },
        [items.length, limits, start],
    );
    const remove = useCallback(
        (key: string) => {
            const item = items.find((entry) => entry.key === key);
            if (!item) {
                return;
            }
            uploads.current.get(key)?.abort();
            files.current.delete(key);
            setItems((current) => current.filter((entry) => entry.key !== key));
            if (item.ref) {
                void removeAttachment(item.ref.id).catch((error: unknown) =>
                    setNotice(
                        `${item.name} could not be removed: ${error instanceof Error ? error.message : 'try again'}`,
                    ),
                );
            }
        },
        [items],
    );
    const retry = useCallback(
        (key: string) => {
            const file = files.current.get(key);
            if (file) {
                start(key, file);
            }
        },
        [start],
    );
    /** After sending: the tray empties, the attachments stay with the message. */
    const clear = useCallback(() => {
        files.current.clear();
        setItems([]);
        setNotice('');
    }, []);
    const refs = items.flatMap((item) => (item.status === 'ready' && item.ref ? [item.ref] : []));
    const uploading = items.some((item) => item.status === 'uploading');
    return {
        items,
        refs,
        uploading,
        notice,
        dismissNotice: () => setNotice(''),
        add,
        remove,
        retry,
        clear,
        dropActive,
        /** For the textarea: pasted files attach; pasted text stays text. */
        onPaste: (event: ClipboardEvent) => {
            const pasted = pastedFiles(event.clipboardData);
            if (!pasted.length) {
                return;
            }
            event.preventDefault();
            add(pasted);
        },
        /** For the form: files dropped anywhere on it attach. */
        dropProps: {
            onDragOver: (event: DragEvent) => {
                if (!dragHasFiles(event.dataTransfer)) {
                    return;
                }
                event.preventDefault();
                setDropActive(true);
            },
            onDragLeave: (event: DragEvent) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    setDropActive(false);
                }
            },
            onDrop: (event: DragEvent) => {
                setDropActive(false);
                const dropped = [...(event.dataTransfer?.files ?? [])];
                if (!dropped.length) {
                    return;
                }
                event.preventDefault();
                add(dropped);
            },
        },
    };
}

export type Attachments = ReturnType<typeof useAttachments>;
