import { useCallback, useRef, useState, type DragEvent } from 'react';

import { dotFolderId, folderName, parentFolder } from './media-api';

import { cn } from '@/lib/utils';

/**
 * Moving files and folders by dragging them onto a folder (CB-255): onto a
 * folder card or row, the folder tree, or a breadcrumb. Only a drag that
 * started on this page carries this type; a drag of files from the
 * computer is an upload, as before.
 */
export const MEDIA_DRAG_TYPE = 'application/x-socio-media';

/** What is being dragged. */
export type MediaDrag =
    | { kind: 'file'; id: string; path: string; folder: string; name: string }
    | { kind: 'folder'; path: string };

export const fileDrag = (item: { id: string; path: string; folder: string; name: string }): MediaDrag => ({
    kind: 'file',
    id: item.id,
    path: item.path,
    folder: item.folder,
    name: item.name,
});
export const folderDrag = (path: string): MediaDrag => ({
    kind: 'folder',
    path,
});

/**
 * Whether a folder can be moved or renamed: not the root, and not Socios
 * or a socio's own folder, which keep their place (the server says so
 * too: renamed, a socio's files would leave it).
 */
export const movableFolder = (folder: string) => !!folder && folder !== 'dots/' && !dotFolderId(folder);

/** `reports/q3/summary.md` → `reports/q3/`; '' at the root. */
export function fileFolder(path: string) {
    return path.slice(0, path.lastIndexOf('/') + 1);
}

/**
 * Where a drag dropped on `target` lands, or undefined where it can't go:
 * where it already is, a folder into itself or one of its subfolders, or
 * a folder straight into Socios (only a socio's own folder lives there).
 */
export function dropPath(drag: MediaDrag, target: string): string | undefined {
    if (drag.kind === 'file') {
        return target === drag.folder ? undefined : `${target}${drag.path.slice(drag.folder.length)}`;
    }
    if (
        !movableFolder(drag.path) ||
        target === parentFolder(drag.path) ||
        target.startsWith(drag.path) ||
        target === 'dots/'
    ) {
        return undefined;
    }
    return `${target}${folderName(drag.path)}/`;
}

/** A drop target's look: `ready` while something it takes is dragged. */
export type DropState = 'ready' | 'over' | undefined;

export const dropClass = (state: DropState) =>
    cn(
        'transition-colors motion-reduce:transition-none',
        state === 'ready' && 'outline-2 -outline-offset-2 outline-primary/40 outline-dashed',
        state === 'over' && 'bg-primary/10 ring-2 ring-primary ring-inset',
    );

const sameDrag = (a: MediaDrag | undefined, b: MediaDrag) => !!a && a.kind === b.kind && a.path === b.path;

/**
 * The page's drag state, and the props that make an element something to
 * drag (`source`) or a folder to drop on (`target`). `onMove` gets the
 * drag, the folder it was dropped on and its new path.
 */
export function useMediaDnd(onMove: (drag: MediaDrag, target: string, path: string) => void) {
    // Read while dragging (dragover can't read the drag's data); the state
    // only draws it.
    const current = useRef<MediaDrag | undefined>(undefined);
    const [moving, setMoving] = useState<MediaDrag>();
    const [over, setOver] = useState<string>();
    const end = useCallback(() => {
        current.current = undefined;
        setMoving(undefined);
        setOver(undefined);
    }, []);
    const ours = (event: DragEvent) =>
        !!current.current && (!event.dataTransfer || [...event.dataTransfer.types].includes(MEDIA_DRAG_TYPE));

    return {
        moving,
        /** How a folder looks as a drop target right now. */
        state(folder: string): DropState {
            if (!moving || dropPath(moving, folder) === undefined) {
                return undefined;
            }
            return over === folder ? 'over' : 'ready';
        },
        /** Whether this is what is being dragged. */
        dragging: (drag: MediaDrag) => sameDrag(moving, drag),
        source: (drag: MediaDrag) => ({
            draggable: true,
            onDragStart: (event: DragEvent) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(MEDIA_DRAG_TYPE, drag.kind === 'file' ? drag.id : drag.path);
                current.current = drag;
                // Drawn once the browser has its picture of the dragged element.
                setTimeout(() => {
                    if (current.current === drag) {
                        setMoving(drag);
                    }
                }, 0);
            },
            onDragEnd: end,
        }),
        target: (folder: string) => ({
            'data-drop-folder': folder,
            onDragOver: (event: DragEvent) => {
                if (!ours(event)) {
                    return;
                }
                // Not taken here: no preventDefault, so the browser shows it can't
                // be dropped.
                if (dropPath(current.current!, folder) === undefined) {
                    return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                }
                setOver(folder);
            },
            onDragLeave: (event: DragEvent) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    return;
                }
                setOver((now) => (now === folder ? undefined : now));
            },
            onDrop: (event: DragEvent) => {
                if (!ours(event)) {
                    return;
                }
                const drag = current.current!;
                const path = dropPath(drag, folder);
                if (path === undefined) {
                    return;
                }
                event.preventDefault();
                end();
                onMove(drag, folder, path);
            },
        }),
    };
}

export type MediaDnd = ReturnType<typeof useMediaDnd>;
