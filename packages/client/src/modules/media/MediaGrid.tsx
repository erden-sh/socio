import {
    File,
    FileArchive,
    FileCode,
    FileImage,
    FileSpreadsheet,
    FileText,
    Folder,
    type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

import { mediaContentUrl, type MediaItem } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { ItemMenu, type MediaItemActions } from './ItemMenu';
import { folderLabel } from './media-api';
import { dropClass, fileDrag, folderDrag, movableFolder } from './media-dnd';

import { cn } from '@/lib/utils';

/** The icon for a file that isn't shown as an image: PDF, sheet, archive, code. */
export function typeIcon(item: Pick<MediaItem, 'kind' | 'mediaType'>) {
    const type = item.mediaType;
    if (item.kind === 'pdf') {
        return FileText;
    }
    if (/csv|tab-separated|spreadsheet|excel/.test(type)) {
        return FileSpreadsheet;
    }
    if (/zip|tar|gzip|7z|rar|compressed|bzip/.test(type)) {
        return FileArchive;
    }
    if (/^text\/x-|json|xml|yaml|javascript|html/.test(type)) {
        return FileCode;
    }
    if (type.startsWith('image/')) {
        return FileImage;
    }
    if (item.kind === 'text') {
        return FileText;
    }
    return File;
}

/** An image card's picture: the original, scaled by CSS, loaded lazily. */
export function Thumb({ item }: { item: MediaItem }) {
    const [failed, setFailed] = useState(false);
    const Icon: LucideIcon = typeIcon(item);
    if (item.kind === 'image' && !failed) {
        return (
            <img
                src={mediaContentUrl(item.id)}
                alt=""
                // The card is what drags, not the picture.
                draggable={false}
                loading="lazy"
                className="size-full object-cover"
                onError={() => setFailed(true)}
            />
        );
    }
    return <Icon className="size-10 text-muted-foreground" aria-hidden />;
}

/**
 * Subfolders, then files, as cards. With `dnd`, cards drag onto folder
 * cards (CB-255); each has a menu with "Move to…" for keyboard and touch.
 */
export function MediaGrid({
    folders,
    items,
    dotName,
    onOpenFolder,
    onOpen,
    dnd,
    onMoveItem,
    onMoveFolder,
    onDelete,
}: {
    folders: readonly string[];
    items: readonly MediaItem[];
    dotName: (id: string) => string | undefined;
    onOpenFolder: (folder: string) => void;
    onOpen: (item: MediaItem) => void;
} & MediaItemActions) {
    return (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3" data-slot="media-grid">
            {folders.map((folder) => {
                const movable = movableFolder(folder);
                const label = folderLabel(folder, dotName);
                return (
                    <li key={folder} className="relative min-w-0 self-start">
                        <button
                            type="button"
                            data-slot="media-folder-card"
                            className={cn(
                                'flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card p-3 text-left text-sm hover:bg-accent',
                                movable && onMoveFolder && 'pr-9',
                                dnd?.dragging(folderDrag(folder)) && 'opacity-50',
                                dropClass(dnd?.state(folder)),
                            )}
                            onClick={() => onOpenFolder(folder)}
                            {...(dnd && movable ? dnd.source(folderDrag(folder)) : {})}
                            {...dnd?.target(folder)}
                        >
                            <Folder className="size-5 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
                            <span className="truncate font-medium" title={label}>
                                {label}
                            </span>
                        </button>
                        {movable && onMoveFolder && (
                            <ItemMenu
                                label={label}
                                className="absolute top-1/2 right-1 -translate-y-1/2"
                                onMove={() => onMoveFolder(folder)}
                            />
                        )}
                    </li>
                );
            })}
            {items.map((item) => (
                <li key={item.id} className="relative">
                    <button
                        type="button"
                        data-slot="media-card"
                        data-kind={item.kind}
                        aria-label={`Open ${item.name}`}
                        className={cn(
                            'flex w-full flex-col overflow-hidden rounded-lg border bg-card text-left hover:bg-accent',
                            dnd?.dragging(fileDrag(item)) && 'opacity-50',
                        )}
                        onClick={() => onOpen(item)}
                        {...dnd?.source(fileDrag(item))}
                    >
                        <span className="flex aspect-square w-full items-center justify-center overflow-hidden bg-muted">
                            <Thumb item={item} />
                        </span>
                        <span className="grid gap-0.5 p-2">
                            <span className="truncate text-sm font-medium" title={item.name}>
                                {item.name}
                            </span>
                            <small className="text-xs text-muted-foreground">{formatSize(item.size)}</small>
                        </span>
                    </button>
                    {onMoveItem && (
                        <ItemMenu
                            label={item.name}
                            className="absolute top-1 right-1 bg-background/80 shadow-xs hover:bg-background"
                            onMove={() => onMoveItem(item)}
                            onDelete={onDelete && (() => onDelete(item))}
                        />
                    )}
                </li>
            ))}
        </ul>
    );
}
