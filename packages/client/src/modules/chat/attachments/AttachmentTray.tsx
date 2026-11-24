import { FileText, LoaderCircle, Paperclip, RotateCw, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { attachmentContentUrl } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { ChatIconButton } from '../chat-chrome';

import { AttachmentViewer } from './AttachmentViewer';
import type { Attachments } from './use-attachments';

import { cn } from '@/lib/utils';

/** The upload spinner, at the legacy pace. */
const spin = 'animate-[spin_2s_linear_infinite]';

/** The composer's paperclip: a button over a hidden file input. */
export function AttachButton({
    attachments,
    disabled,
    className,
}: {
    attachments: Attachments;
    disabled?: boolean;
    className?: string;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                data-slot="attachment-input"
                type="file"
                multiple
                hidden
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (files.length) {
                        attachments.add(files);
                    }
                }}
            />
            <ChatIconButton
                className={className}
                aria-label="Attach files"
                title="Attach files (or paste or drop them)"
                disabled={disabled}
                onClick={() => input.current?.click()}
            >
                <Paperclip size={18} />
            </ChatIconButton>
        </>
    );
}

/** A tray item's small round button (retry, remove, dismiss). */
const action =
    'inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-card p-0 text-foreground/75 shadow-[0_1px_3px_rgb(57_57_74/0.2)] hover:text-foreground';
/** A file that isn't an image: its name and size (or progress, or error). */
const chip =
    'inline-flex max-w-65 items-center gap-1.5 rounded-lg border bg-muted/50 py-1.5 pr-3.5 pl-[9px] text-[11px]/[normal] text-foreground group-data-[status=failed]/item:border-destructive/40 group-data-[status=failed]/item:bg-destructive/5';
const chipNote =
    'text-[0.8em] whitespace-nowrap text-muted-foreground group-data-[status=failed]/item:whitespace-normal group-data-[status=failed]/item:text-destructive';
const thumb = 'block size-18 rounded-lg border bg-muted object-cover';

/**
 * Above the textarea: each attachment with its upload progress, a
 * thumbnail of the uploaded original for images (scaled by CSS, never
 * re-encoded), a chip for other files, and a button to remove it. An
 * uploaded one opens the viewer (CB-85), as a sent message's do.
 */
export function AttachmentTray({ attachments }: { attachments: Attachments }) {
    const { items, notice } = attachments;
    const [shown, setShown] = useState<string>();
    if (!items.length && !notice) {
        return null;
    }
    // Uploads start on attach: the viewer shows the uploaded originals.
    const viewable = items.flatMap((item) => (item.status === 'ready' && item.ref ? [item.ref] : []));
    return (
        <div data-slot="attachment-tray" className="mb-2.5 flex flex-col gap-1.5">
            {!!items.length && (
                <ul
                    className="m-0 flex list-none flex-wrap items-center gap-2.5 p-0 pt-1.5 pr-1.5"
                    aria-label="Attachments to send"
                >
                    {items.map((item) => (
                        <li
                            key={item.key}
                            className="group/item relative flex items-center gap-1"
                            data-slot="tray-item"
                            data-status={item.status}
                            title={item.error ?? `${item.name} · ${formatSize(item.size)}`}
                        >
                            {item.status === 'ready' && item.ref?.kind === 'image' ? (
                                <button
                                    type="button"
                                    data-slot="tray-open"
                                    className="block cursor-zoom-in rounded-lg p-0"
                                    aria-label={`View ${item.name}`}
                                    onClick={() => setShown(item.ref!.id)}
                                >
                                    <img
                                        data-slot="tray-thumb"
                                        className={thumb}
                                        src={attachmentContentUrl(item.ref.id)}
                                        alt={item.name}
                                    />
                                </button>
                            ) : item.status === 'ready' && item.ref ? (
                                <button
                                    type="button"
                                    data-slot="tray-chip"
                                    className={chip}
                                    aria-label={`View ${item.name}`}
                                    onClick={() => setShown(item.ref!.id)}
                                >
                                    <FileText size={14} aria-hidden />
                                    <span className="min-w-0 truncate">{item.name}</span>
                                    <small className={chipNote}>{formatSize(item.size)}</small>
                                </button>
                            ) : item.image && item.status === 'uploading' ? (
                                <span
                                    data-slot="tray-thumb"
                                    className={cn(
                                        thumb,
                                        'flex flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground',
                                    )}
                                    role="progressbar"
                                    aria-label={`Uploading ${item.name}`}
                                    aria-valuenow={Math.round(item.progress * 100)}
                                >
                                    <LoaderCircle size={18} className={spin} />
                                    <span>{Math.round(item.progress * 100)}%</span>
                                </span>
                            ) : (
                                <span data-slot="tray-chip" className={chip}>
                                    {item.status === 'uploading' ? (
                                        <LoaderCircle size={14} className={spin} aria-hidden />
                                    ) : (
                                        <FileText size={14} aria-hidden />
                                    )}
                                    <span className="min-w-0 truncate">{item.name}</span>
                                    <small className={chipNote}>
                                        {item.status === 'failed'
                                            ? item.error
                                            : item.status === 'uploading'
                                              ? `${Math.round(item.progress * 100)}%`
                                              : formatSize(item.size)}
                                    </small>
                                </span>
                            )}
                            {item.status === 'failed' && (
                                <button
                                    type="button"
                                    data-slot="tray-action"
                                    className={action}
                                    aria-label={`Retry ${item.name}`}
                                    onClick={() => attachments.retry(item.key)}
                                >
                                    <RotateCw size={12} />
                                </button>
                            )}
                            <button
                                type="button"
                                data-slot="tray-action"
                                className={cn(action, 'absolute -top-[7px] -right-[7px]')}
                                aria-label={`Remove ${item.name}`}
                                onClick={() => attachments.remove(item.key)}
                            >
                                <X size={12} />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {notice && (
                <div
                    data-slot="attachment-notice"
                    className="flex items-center gap-2 text-[11px] text-destructive"
                    role="alert"
                >
                    {notice}
                    <button
                        type="button"
                        data-slot="tray-action"
                        className={action}
                        aria-label="Dismiss"
                        onClick={attachments.dismissNotice}
                    >
                        <X size={12} />
                    </button>
                </div>
            )}
            <AttachmentViewer items={viewable} shown={shown} onShow={setShown} />
        </div>
    );
}
