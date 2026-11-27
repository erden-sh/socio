import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { AttachmentRef } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { dragHasFiles, namedFile, pastedFiles } from '../../../lib/files';

import {
    DEFAULT_MEDIA_LIMITS,
    mediaLimits,
    removeAttachment,
    uploadAttachment,
    UploadOffline,
    UploadRefused,
} from './upload';

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
    const { t } = useTranslation(['chat.composer']);
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
                        // The server's words as they are; the client's own in the person's language.
                        error:
                            error instanceof UploadRefused
                                ? t('chat.composer:attachments.refused', { status: error.status })
                                : error instanceof UploadOffline
                                  ? t('chat.composer:attachments.offline')
                                  : error instanceof Error
                                    ? error.message
                                    : t('chat.composer:attachments.failed'),
                    });
                })
                .finally(() => uploads.current.delete(key));
        },
        [threadId, t],
    );
    const add = useCallback(
        (picked: readonly File[]) => {
            const problems: string[] = [];
            const accepted: TrayItem[] = [];
            picked.forEach((raw, index) => {
                const file = namedFile(raw, index);
                if (!file.size) {
                    problems.push(t('chat.composer:attachments.empty', { name: file.name }));
                } else if (file.size > limits.fileMaxBytes) {
                    problems.push(
                        t('chat.composer:attachments.too-big', {
                            name: file.name,
                            size: formatSize(file.size),
                            max: formatSize(limits.fileMaxBytes),
                        }),
                    );
                } else if (items.length + accepted.length >= limits.perMessage) {
                    problems.push(
                        t('chat.composer:attachments.too-many', { name: file.name, count: limits.perMessage }),
                    );
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
        [items.length, limits, start, t],
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
                        error instanceof Error
                            ? t('chat.composer:attachments.remove-failed', { name: item.name, reason: error.message })
                            : t('chat.composer:attachments.remove-failed-retry', { name: item.name }),
                    ),
                );
            }
        },
        [items, t],
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
