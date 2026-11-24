import { Download, FolderInput, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { mediaContentUrl, type MediaItem } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { formatTime } from './media-api';
import { typeIcon } from './MediaGrid';
import { AttachedFrom, typeLabel } from './MediaList';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/** Text previews show this much; the rest is a download away. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

/**
 * The first 256 KB of a text file at `url`, read-only in a monospace
 * `<pre>`. Chat attachments use it too.
 */
export function TextPreview({ url }: { url: string }) {
    const [text, setText] = useState<string>();
    const [more, setMore] = useState(false);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        void fetch(url, { signal: controller.signal })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(String(response.status));
                }
                return response.blob();
            })
            .then((blob) => {
                setMore(blob.size > TEXT_PREVIEW_BYTES);
                return blob.slice(0, TEXT_PREVIEW_BYTES).text();
            })
            .then(setText)
            .catch((error: unknown) => {
                if ((error as Error).name !== 'AbortError') {
                    setFailed(true);
                }
            });
        return () => controller.abort();
    }, [url]);
    if (failed) {
        return <p className="text-sm text-muted-foreground">The preview could not be loaded.</p>;
    }
    return (
        <pre
            data-slot="media-text-preview"
            className="max-h-[55svh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
        >
            {text ?? 'Loading…'}
            {text !== undefined && more && (
                <span className="block pt-2 text-muted-foreground">(The first 256 KB. Download it for the rest.)</span>
            )}
        </pre>
    );
}

/**
 * A file, previewed by kind: an image at full size, text in a `<pre>`,
 * anything else as its details. Download, move or rename, and delete.
 */
export function MediaPreview({
    item,
    onClose,
    onMove,
    onDelete,
}: {
    item: MediaItem;
    onClose: () => void;
    onMove: () => void;
    onDelete: () => void;
}) {
    const Icon = typeIcon(item);
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-4xl" data-slot="media-preview">
                <DialogHeader>
                    <DialogTitle className="truncate pr-8">{item.name}</DialogTitle>
                    <DialogDescription className="font-mono text-xs break-all">{item.path}</DialogDescription>
                </DialogHeader>
                {item.kind === 'image' ? (
                    <img
                        src={mediaContentUrl(item.id)}
                        alt={item.name}
                        className="max-h-[60svh] w-full rounded-md object-contain"
                    />
                ) : item.kind === 'text' ? (
                    <TextPreview url={mediaContentUrl(item.id)} />
                ) : (
                    <div className="flex items-center gap-3 rounded-md bg-muted p-4 text-sm">
                        <Icon className="size-8 text-muted-foreground" aria-hidden />
                        <span>No preview for this file. Download it to open it on your device.</span>
                    </div>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>
                        {typeLabel(item)} <span className="text-muted-foreground">({item.mediaType})</span>
                    </dd>
                    <dt className="text-muted-foreground">Size</dt>
                    <dd>{formatSize(item.size)}</dd>
                    {item.attachments.length > 0 && (
                        <>
                            <dt className="text-muted-foreground">From</dt>
                            <dd>
                                <AttachedFrom item={item} />
                            </dd>
                        </>
                    )}
                    <dt className="text-muted-foreground">Saved by</dt>
                    <dd>{item.createdByDotId ? (item.dotName ?? 'A deleted socio') : 'You'}</dd>
                    <dt className="text-muted-foreground">Updated</dt>
                    <dd>{formatTime(item.updatedAt)}</dd>
                </dl>
                <DialogFooter className="gap-2 sm:justify-between">
                    <Button variant="ghost" className="text-destructive" onClick={onDelete}>
                        <Trash2 /> Delete
                    </Button>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={onMove}>
                            <FolderInput /> Move or rename
                        </Button>
                        <Button asChild>
                            <a href={mediaContentUrl(item.id, true)} download={item.name}>
                                <Download /> Download
                            </a>
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
