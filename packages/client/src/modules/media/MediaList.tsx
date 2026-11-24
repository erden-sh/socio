import { Download, Folder } from 'lucide-react';
import { Link } from 'react-router';

import { mediaContentUrl, type MediaItem } from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import { LocalTime } from '../../lib/local-time';

import { ItemMenu, type MediaItemActions } from './ItemMenu';
import { folderLabel, formatTime } from './media-api';
import { dropClass, fileDrag, folderDrag, movableFolder } from './media-dnd';
import { typeIcon } from './MediaGrid';

import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * Where a file came from: the conversation it was attached in (a link,
 * with the Dot's name), a deleted one, Telegram, or a chat not sent yet.
 * Nothing for a file that was never attached.
 */
export function AttachedFrom({ item }: { item: MediaItem }) {
    const from = item.attachments[0];
    if (!from) {
        return null;
    }
    if (from.source === 'telegram' && !from.threadTitle) {
        return <>Telegram</>;
    }
    if (!from.threadId) {
        return <span className="text-muted-foreground">A chat not sent yet</span>;
    }
    if (!from.threadTitle) {
        return <span className="text-muted-foreground">A deleted conversation</span>;
    }
    return (
        <Link
            className="underline-offset-4 hover:underline"
            to={`/chats/${encodeURIComponent(from.threadId)}`}
            data-slot="media-from"
            draggable={false}
        >
            {from.threadTitle}
            {from.dotName ? ` · ${from.dotName}` : ''}
            {from.source === 'telegram' ? ' (Telegram)' : ''}
        </Link>
    );
}

/** The type as people say it: PNG, Markdown, PDF, or the media type. */
export function typeLabel(item: Pick<MediaItem, 'mediaType'>) {
    const type = item.mediaType.split(';')[0];
    const known: Record<string, string> = {
        'text/markdown': 'Markdown',
        'text/plain': 'Text',
        'text/csv': 'CSV',
        'application/json': 'JSON',
        'application/pdf': 'PDF',
        'application/octet-stream': 'File',
    };
    if (known[type]) {
        return known[type];
    }
    if (type.startsWith('image/')) {
        return type.slice(6).replace('svg+xml', 'SVG').toUpperCase();
    }
    if (type.startsWith('text/x-')) {
        return type.slice(7);
    }
    return type;
}

/**
 * Subfolders, then files, as table rows. With `dnd`, rows drag onto folder
 * rows (CB-255); each has a menu with "Move to…" for keyboard and touch.
 */
export function MediaList({
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
        <Table data-slot="media-list">
            <TableHeader>
                <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>Saved by</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="w-12">
                        <span className="sr-only">Actions</span>
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {folders.map((folder) => {
                    const movable = movableFolder(folder);
                    const label = folderLabel(folder, dotName);
                    return (
                        <TableRow
                            key={folder}
                            className={cn(
                                dnd?.dragging(folderDrag(folder)) && 'opacity-50',
                                dropClass(dnd?.state(folder)),
                            )}
                            {...(dnd && movable ? dnd.source(folderDrag(folder)) : {})}
                            {...dnd?.target(folder)}
                        >
                            <TableCell colSpan={6}>
                                <button
                                    type="button"
                                    data-slot="media-folder-row"
                                    className="flex items-center gap-2 font-medium"
                                    onClick={() => onOpenFolder(folder)}
                                >
                                    <Folder className="size-4 text-sky-700 dark:text-sky-300" aria-hidden />
                                    {label}
                                </button>
                            </TableCell>
                            <TableCell>
                                {movable && onMoveFolder && (
                                    <ItemMenu label={label} className="size-9" onMove={() => onMoveFolder(folder)} />
                                )}
                            </TableCell>
                        </TableRow>
                    );
                })}
                {items.map((item) => {
                    const Icon = typeIcon(item);
                    return (
                        <TableRow
                            key={item.id}
                            data-item={item.path}
                            className={cn(dnd?.dragging(fileDrag(item)) && 'opacity-50')}
                            {...dnd?.source(fileDrag(item))}
                        >
                            <TableCell className="max-w-72">
                                <button
                                    type="button"
                                    data-slot="media-open"
                                    className="flex max-w-full items-center gap-2 text-left font-medium underline-offset-4 hover:underline"
                                    aria-label={`Open ${item.name}`}
                                    onClick={() => onOpen(item)}
                                >
                                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                    <span className="truncate" title={item.path}>
                                        {item.name}
                                    </span>
                                </button>
                            </TableCell>
                            <TableCell>{typeLabel(item)}</TableCell>
                            <TableCell className="text-right">{formatSize(item.size)}</TableCell>
                            <TableCell className="max-w-56 truncate">
                                <AttachedFrom item={item} />
                            </TableCell>
                            <TableCell>{item.createdByDotId ? (item.dotName ?? 'A deleted socio') : 'You'}</TableCell>
                            <TableCell className="whitespace-nowrap">
                                <LocalTime value={item.updatedAt} format={formatTime} />
                            </TableCell>
                            <TableCell>
                                <span className="flex items-center gap-1">
                                    <Button variant="ghost" size="icon" asChild>
                                        <a
                                            href={mediaContentUrl(item.id, true)}
                                            download={item.name}
                                            aria-label={`Download ${item.name}`}
                                            // The row is what drags, not the link.
                                            draggable={false}
                                        >
                                            <Download />
                                        </a>
                                    </Button>
                                    {onMoveItem && (
                                        <ItemMenu
                                            label={item.name}
                                            className="size-9"
                                            onMove={() => onMoveItem(item)}
                                            onDelete={onDelete && (() => onDelete(item))}
                                        />
                                    )}
                                </span>
                            </TableCell>
                        </TableRow>
                    );
                })}
            </TableBody>
        </Table>
    );
}
