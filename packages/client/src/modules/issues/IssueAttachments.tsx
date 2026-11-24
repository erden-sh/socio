import { Download, FileText, Paperclip, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { IssueAttachment } from '@socio/shared/issues/issue-types';
import { formatSize } from '@socio/shared/text/format-size';

import { ATTACHMENT_ACCEPT, attachmentDataUrl, downloadAttachment, previewUrl } from './attachments';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** "Attach files": a button over a hidden file input. */
export function AttachButton({
    onFiles,
    disabled,
    label = 'Attach files',
    compact = false,
}: {
    onFiles: (files: File[]) => void;
    disabled?: boolean;
    label?: string;
    compact?: boolean;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                data-slot="file-input"
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="hidden"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (files.length) {
                        onFiles(files);
                    }
                }}
            />
            <Button
                type="button"
                variant="outline"
                size={compact ? 'icon' : 'sm'}
                disabled={disabled}
                aria-label={compact ? label : undefined}
                title={compact ? label : undefined}
                onClick={() => input.current?.click()}
            >
                <Paperclip />
                {!compact && label}
            </Button>
        </>
    );
}

/** Files chosen but not uploaded yet, with a remove button each. */
export function PendingFiles({ files, onRemove }: { files: readonly File[]; onRemove: (index: number) => void }) {
    if (!files.length) {
        return null;
    }
    return (
        <ul data-slot="pending-files" aria-label="Files to attach" className="flex flex-wrap gap-2">
            {files.map((file, index) => (
                <li
                    key={`${file.name}:${index}`}
                    className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-1"
                >
                    <PendingPreview file={file} />
                    <span className="max-w-40 truncate text-xs">{file.name}</span>
                    <span className="text-[11px] text-muted-foreground">{formatSize(file.size)}</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Remove ${file.name}`}
                        onClick={() => onRemove(index)}
                    >
                        <X className="size-3.5" />
                    </Button>
                </li>
            ))}
        </ul>
    );
}

function PendingPreview({ file }: { file: File }) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        let live = true;
        void previewUrl(file).then((value) => live && setUrl(value));
        return () => {
            live = false;
        };
    }, [file]);
    return url ? (
        <img src={url} alt="" className="size-8 rounded object-cover" />
    ) : (
        <FileText className="size-4 text-muted-foreground" aria-hidden />
    );
}

/** An uploaded image as a `data:` URL, fetched with the app's credentials. */
function useAttachmentUrl(file: IssueAttachment) {
    const image = file.mediaType.startsWith('image/');
    const [url, setUrl] = useState('');
    useEffect(() => {
        if (!image) {
            return;
        }
        let live = true;
        attachmentDataUrl(file.id)
            .then((value) => live && setUrl(value))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [file.id, image]);
    return image ? url : undefined;
}

/** Thumbnails for images, a file row for the rest; images open larger. */
export function AttachmentGrid({
    files,
    canDelete,
    onDelete,
    className,
}: {
    files: readonly IssueAttachment[];
    canDelete: (file: IssueAttachment) => boolean;
    onDelete: (file: IssueAttachment) => void;
    className?: string;
}) {
    const [shown, setShown] = useState<IssueAttachment>();
    if (!files.length) {
        return null;
    }
    return (
        <>
            <ul data-slot="attachments" aria-label="Attachments" className={cn('flex flex-wrap gap-2', className)}>
                {files.map((file) => (
                    <AttachmentTile
                        key={file.id}
                        file={file}
                        onOpen={() => setShown(file)}
                        onDelete={canDelete(file) ? () => onDelete(file) : undefined}
                    />
                ))}
            </ul>
            <Dialog open={!!shown} onOpenChange={(open) => !open && setShown(undefined)}>
                <DialogContent className="max-h-[90svh] sm:max-w-4xl">
                    <DialogTitle className="truncate pr-8 text-sm">{shown?.name}</DialogTitle>
                    {shown && <LargeImage file={shown} />}
                </DialogContent>
            </Dialog>
        </>
    );
}

function LargeImage({ file }: { file: IssueAttachment }) {
    const url = useAttachmentUrl(file);
    return url ? (
        <img src={url} alt={file.name} className="max-h-[75svh] w-full rounded-md object-contain" />
    ) : (
        <div className="h-40 animate-pulse rounded-md bg-muted" />
    );
}

function AttachmentTile({
    file,
    onOpen,
    onDelete,
}: {
    file: IssueAttachment;
    onOpen: () => void;
    onDelete?: () => void;
}) {
    const url = useAttachmentUrl(file);
    const download = () =>
        void downloadAttachment(file).catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : String(error)),
        );
    return (
        <li
            data-slot="attachment"
            className="group/file relative flex items-center gap-2 overflow-hidden rounded-md border bg-card"
        >
            {url !== undefined ? (
                <button
                    type="button"
                    data-slot="attachment-open"
                    className="block size-20 cursor-zoom-in bg-muted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label={`View ${file.name}`}
                    onClick={onOpen}
                >
                    {url && <img src={url} alt="" className="size-full object-cover" />}
                </button>
            ) : (
                <button
                    type="button"
                    data-slot="attachment-download"
                    className="flex h-12 max-w-56 items-center gap-2 px-3 text-left text-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label={`Download ${file.name}`}
                    onClick={download}
                >
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                        <span className="block truncate font-medium">{file.name}</span>
                        <span className="text-muted-foreground">{formatSize(file.size)}</span>
                    </span>
                    <Download className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
            )}
            {onDelete && (
                <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute top-1 right-1 size-6 opacity-80 hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Delete ${file.name}`}
                    onClick={onDelete}
                >
                    <Trash2 className="size-3" />
                </Button>
            )}
        </li>
    );
}
