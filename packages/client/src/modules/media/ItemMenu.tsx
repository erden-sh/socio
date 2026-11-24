import { FolderInput, MoreHorizontal, Trash2 } from 'lucide-react';

import type { MediaItem } from '@socio/shared/media-types';

import type { MediaDnd } from './media-dnd';

import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** What the grid and the list can do with what they show, besides open it. */
export interface MediaItemActions {
    /** Dragging onto folders; none, nothing drags. */
    dnd?: MediaDnd;
    onMoveItem?: (item: MediaItem) => void;
    onMoveFolder?: (folder: string) => void;
    onDelete?: (item: MediaItem) => void;
}

/**
 * A file's or folder's own actions: "Move to…", the keyboard and touch
 * way to do what dragging does (CB-255), and Delete for a file.
 */
export function ItemMenu({
    label,
    className,
    onMove,
    onDelete,
}: {
    label: string;
    className?: string;
    onMove: () => void;
    onDelete?: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className={cn('size-7', className)}
                    aria-label={`More actions for ${label}`}
                    data-slot="media-item-menu"
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onMove}>
                    <FolderInput /> Move to…
                </DropdownMenuItem>
                {onDelete && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                            <Trash2 /> Delete
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
