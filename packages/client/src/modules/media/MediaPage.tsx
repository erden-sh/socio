import {
    ChevronRight,
    FolderPlus,
    KeyRound,
    LayoutGrid,
    List,
    MoreHorizontal,
    Pencil,
    Search,
    Trash2,
    Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import type { MediaItem, MediaKind, MediaListing } from '@socio/shared/media-types';
import { MODULE_IDS } from '@socio/shared/modules';
import { formatSize } from '@socio/shared/text/format-size';

import { useRevalidateOn } from '../../hooks/use-tab-refresh';
import { dragHasFiles, namedFile, pastedFiles } from '../../lib/files';
import { useLoaderSeed } from '../../lib/page-loader';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';
import { uploadToFolder } from '../chat/attachments/upload';

import { FolderAccess } from './FolderAccess';
import { FolderTree } from './FolderTree';
import {
    createFolder,
    deleteFolder,
    collapseCrumbs,
    deleteItem,
    folderLabel,
    folderName,
    listMedia,
    moveFolder,
    moveItem,
    parentFolder,
} from './media-api';
import { dropClass, fileDrag, fileFolder, folderDrag, movableFolder, useMediaDnd, type MediaDrag } from './media-dnd';
import { MediaGrid } from './MediaGrid';
import { MediaList } from './MediaList';
import { MediaPreview } from './MediaPreview';
import { MoveDialog } from './MoveDialog';

import { ConfirmDelete } from '@/components/confirm-delete';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

const KINDS: Array<{ value: MediaKind | ''; label: string }> = [
    { value: '', label: 'All' },
    { value: 'image', label: 'Images' },
    { value: 'text', label: 'Text' },
    { value: 'pdf', label: 'PDFs' },
    { value: 'file', label: 'Other' },
];

/** A listing from the page's loader, with what it was asked for. */
export interface MediaSeed {
    query: { folder: string; q: string; kind: MediaKind | '' };
    listing: MediaListing;
}

/** What a dialog is open for, if any. */
type Dialog =
    | { kind: 'preview'; item: MediaItem }
    | { kind: 'move'; item: MediaItem }
    | { kind: 'move-folder'; path: string }
    | { kind: 'delete'; item: MediaItem }
    | { kind: 'new-folder' }
    | { kind: 'rename-folder' }
    | { kind: 'delete-folder' }
    | { kind: 'access' };

function UsageBar({ used, max }: { used: number; max: number }) {
    const share = Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
    return (
        <div className="grid max-w-md gap-1" data-slot="media-usage">
            <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Data space used"
                aria-valuenow={share}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
            </div>
            <small className="text-xs text-muted-foreground">
                {formatSize(used)} of {formatSize(max)} used ({share}%)
            </small>
        </div>
    );
}

/**
 * `/media`: the user's files and chat attachments, by folder. A view over
 * the data space's files (CB-54): what it lists, the Dots' tools see, and
 * a folder's grants are the data space's. Upload by button, by dropping
 * anywhere on the page, or by pasting. Move by dragging onto a folder, or
 * with "Move to…" (CB-255).
 */
export function MediaPage({
    initial,
}: {
    /** The page's loader data: the listing for the address it opened at. */
    initial?: MediaSeed;
} = {}) {
    const shell = useShell();
    const dots = shell.workspace.dots;
    const dotName = useCallback((id: string) => dots.find((dot) => dot.id === id)?.name, [dots]);
    const [params, setParams] = useSearchParams();
    const folder = params.get('folder') ?? '';
    const kind = (params.get('kind') ?? '') as MediaKind | '';
    const view = params.get('view') === 'list' ? 'list' : 'grid';
    const q = params.get('q') ?? '';
    const [search, setSearch] = useState(q);
    // The loader's listing, when it is for this folder, search and kind.
    const seed =
        initial && initial.query.folder === folder && initial.query.q === q && initial.query.kind === kind
            ? initial.listing
            : undefined;
    const [listing, setListing] = useState<MediaListing | undefined>(seed);
    const [more, setMore] = useState<{ items: MediaItem[]; cursor?: string } | undefined>(
        seed && { items: [], cursor: seed.nextCursor },
    );
    const [loading, setLoading] = useState(!seed);
    const seeded = useRef(!!seed);
    const [reloads, setReloads] = useState(0);
    // Another tab's upload, move or delete, or this tab coming back: the
    // loader runs again, and its listing replaces this one if it is for
    // the same folder, search and kind.
    useRevalidateOn('media');
    useLoaderSeed(initial, (next) => {
        if (next.query.folder !== folder || next.query.q !== q || next.query.kind !== kind) {
            return;
        }
        setListing(next.listing);
        setMore({ items: [], cursor: next.listing.nextCursor });
    });
    const [dialog, setDialog] = useState<Dialog>();
    const [uploading, setUploading] = useState<{
        name: string;
        done: number;
        total: number;
        progress: number;
    }>();
    const [dragging, setDragging] = useState(false);
    const picker = useRef<HTMLInputElement>(null);

    const setParam = useCallback(
        (changes: Record<string, string>) =>
            setParams(
                (current) => {
                    const next = new URLSearchParams(current);
                    for (const [key, value] of Object.entries(changes)) {
                        if (value) {
                            next.set(key, value);
                        } else {
                            next.delete(key);
                        }
                    }
                    return next;
                },
                { replace: true },
            ),
        [setParams],
    );
    const openFolder = (next: string) => {
        setSearch('');
        setParam({ folder: next, q: '' });
    };
    const reload = () => setReloads((count) => count + 1);

    /**
     * Moves a file or folder to `path` (the server checks it is the user's
     * own and refuses a clash, as for any move), then says so with Undo.
     * No Undo after a rename (a file's upload name doesn't come back) or
     * when a folder joined one of the same name (undoing would take that
     * one's files too). True once moved.
     */
    const move = async (drag: MediaDrag, path: string) => {
        if (path === drag.path) {
            return true;
        }
        const file = drag.kind === 'file';
        const name = file ? drag.name : folderLabel(drag.path, dotName);
        const target = file ? fileFolder(path) : parentFolder(path);
        const renamed = file
            ? path.slice(target.length) !== drag.path.slice(drag.folder.length)
            : folderName(path) !== folderName(drag.path);
        const merged = !file && (listing?.tree ?? []).includes(path);
        try {
            if (file) {
                await moveItem(drag.id, path);
            } else {
                await moveFolder(drag.path, path);
            }
        } catch (e) {
            failed(e, `Could not move ${name}.`);
            return false;
        }
        reload();
        const where = folderLabel(target, dotName);
        if (renamed) {
            toast.success(`Moved to ${path}.`);
        } else if (merged) {
            toast.success(`Moved ${name} into ${where}, together with the ${name} folder already there.`);
        } else {
            toast.success(`Moved ${name} to ${where}.`, {
                duration: 10_000,
                action: {
                    label: 'Undo',
                    onClick: () =>
                        void (file ? moveItem(drag.id, drag.path) : moveFolder(path, drag.path))
                            .then(() => {
                                toast.success(`Moved ${name} back.`);
                                reload();
                            })
                            .catch((e: unknown) => failed(e, `Could not move ${name} back.`)),
                },
            });
        }
        return true;
    };
    const dnd = useMediaDnd((drag, _target, path) => void move(drag, path));

    // The search follows typing, a moment after it stops.
    useEffect(() => {
        if (search === q) {
            return;
        }
        const timer = setTimeout(() => setParam({ q: search }), 250);
        return () => clearTimeout(timer);
    }, [search, q, setParam]);

    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        const controller = new AbortController();
        setLoading(true);
        listMedia({ folder, q, kind: kind || undefined }, controller.signal)
            .then((next) => {
                // Aborted while its body was read, api() answers an error object
                // rather than throwing: a newer listing is on its way.
                if (controller.signal.aborted) {
                    return;
                }
                setListing(next);
                setMore({ items: [], cursor: next.nextCursor });
            })
            .catch((e: unknown) => {
                if ((e as Error).name !== 'AbortError') {
                    failed(e, 'Could not load your files.');
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            });
        return () => controller.abort();
    }, [folder, q, kind, reloads]);

    const loadMore = async () => {
        if (!more?.cursor) {
            return;
        }
        try {
            const next = await listMedia({
                folder,
                q,
                kind: kind || undefined,
                cursor: more.cursor,
            });
            setMore({
                items: [...more.items, ...next.items],
                cursor: next.nextCursor,
            });
        } catch (e) {
            failed(e, 'Could not load more files.');
        }
    };

    const upload = async (files: File[]) => {
        if (!files.length || uploading) {
            return;
        }
        const max = listing?.limits.fileMaxBytes;
        const named = files.map((file, index) => namedFile(file, index));
        const tooBig = max ? named.filter((file) => file.size > max) : [];
        if (tooBig.length) {
            toast.error(`${tooBig.map((file) => file.name).join(', ')}: files can be at most ${formatSize(max!)}.`);
        }
        const queue = named.filter((file) => !tooBig.includes(file));
        let done = 0;
        for (const file of queue) {
            setUploading({ name: file.name, done, total: queue.length, progress: 0 });
            try {
                await uploadToFolder(file, folder, {
                    onProgress: (progress) => setUploading((current) => current && { ...current, progress }),
                });
                done += 1;
            } catch (e) {
                failed(e, `Could not upload ${file.name}.`);
            }
        }
        setUploading(undefined);
        if (done) {
            toast.success(done === 1 ? 'Uploaded 1 file.' : `Uploaded ${done} files.`);
            reload();
        }
    };
    const uploadRef = useRef(upload);
    uploadRef.current = upload;

    // Paste anywhere on the page: files only, text pastes as usual.
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            const files = pastedFiles(event.clipboardData);
            if (!files.length) {
                return;
            }
            event.preventDefault();
            void uploadRef.current(files);
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, []);

    const onDragOver = (event: DragEvent) => {
        if (!dragHasFiles(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragging(false);
        }
    };
    const onDrop = (event: DragEvent) => {
        if (!dragHasFiles(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        setDragging(false);
        void upload([...event.dataTransfer.files]);
    };
    const onPick = (event: ChangeEvent<HTMLInputElement>) => {
        const files = [...(event.target.files ?? [])];
        event.target.value = '';
        void upload(files);
    };

    const items = [...(listing?.items ?? []), ...(more?.items ?? [])];
    const close = () => setDialog(undefined);
    const crumbs = folder
        ? folder
              .slice(0, -1)
              .split('/')
              .map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/`)
        : [];
    const { hidden: hiddenCrumbs, shown: shownCrumbs } = collapseCrumbs(crumbs);
    // A Dot's own folder keeps its place: renaming it would take the files
    // away from the Dot.
    const renamable = movableFolder(folder);
    const itemActions = {
        dnd,
        onMoveItem: (item: MediaItem) => setDialog({ kind: 'move', item }),
        onMoveFolder: (path: string) => setDialog({ kind: 'move-folder', path }),
        onDelete: (item: MediaItem) => setDialog({ kind: 'delete', item }),
    };

    return (
        <WorkspacePage
            slot="media-page"
            module={MODULE_IDS.media}
            className="relative"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            title="Media"
            actions={
                <>
                    <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'new-folder' })}>
                        <FolderPlus /> New folder
                    </Button>
                    <Button size="sm" onClick={() => picker.current?.click()} disabled={!!uploading}>
                        <Upload /> Upload
                    </Button>
                    <input ref={picker} type="file" multiple hidden aria-label="Upload files" onChange={onPick} />
                </>
            }
            description="Files you and your socios keep, and what you attached in chats. Drop files anywhere here, or paste them, to upload into the open folder. Drag files and folders onto a folder to move them."
        >
            {listing && (
                <div className="mb-4">
                    <UsageBar used={listing.usage.totalBytes} max={listing.limits.userMaxBytes} />
                </div>
            )}
            {uploading && (
                <p className="mb-3 text-sm text-muted-foreground" role="status" data-slot="media-uploading">
                    Uploading {uploading.name} ({uploading.done + 1} of {uploading.total},{' '}
                    {Math.round(uploading.progress * 100)}%)…
                </p>
            )}
            {dnd.moving && (
                // Over the page, not in it: the folders mustn't shift under the
                // pointer while it drags.
                <p
                    className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    role="status"
                    data-slot="media-moving"
                >
                    Moving {dnd.moving.kind === 'file' ? dnd.moving.name : folderLabel(dnd.moving.path, dotName)}. Drop
                    it on a folder, in the tree or the breadcrumbs. Esc cancels.
                </p>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
                <aside className="min-w-0">
                    <FolderTree
                        tree={listing?.tree ?? []}
                        folder={folder}
                        dotName={dotName}
                        onOpen={openFolder}
                        dnd={dnd}
                    />
                </aside>
                <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <nav
                            aria-label="Breadcrumbs"
                            className="flex min-w-0 basis-full items-center gap-1 text-sm sm:basis-0 sm:flex-1"
                            data-slot="media-crumbs"
                        >
                            <button
                                type="button"
                                data-slot="media-crumb"
                                className={cn('shrink-0 rounded-sm px-1 hover:underline', dropClass(dnd.state('')))}
                                onClick={() => openFolder('')}
                                {...dnd.target('')}
                            >
                                All files
                            </button>
                            {hiddenCrumbs.length > 0 && (
                                <span className="flex shrink-0 items-center gap-1">
                                    <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-7"
                                                aria-label="Earlier folders"
                                                data-slot="media-crumbs-more"
                                            >
                                                <MoreHorizontal />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="start">
                                            {hiddenCrumbs.map((path) => (
                                                <DropdownMenuItem
                                                    key={path}
                                                    data-slot="media-crumb"
                                                    onSelect={() => openFolder(path)}
                                                >
                                                    {folderLabel(path, dotName)}
                                                </DropdownMenuItem>
                                            ))}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </span>
                            )}
                            {shownCrumbs.map((path) => (
                                <span
                                    key={path}
                                    className={cn(
                                        'flex min-w-0 items-center gap-1',
                                        path !== folder && 'shrink-0 max-w-40',
                                    )}
                                >
                                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                    <button
                                        type="button"
                                        data-slot="media-crumb"
                                        title={folderLabel(path, dotName)}
                                        className={cn(
                                            'min-w-0 truncate rounded-sm px-1 hover:underline',
                                            path === folder && 'font-medium',
                                            dropClass(dnd.state(path)),
                                        )}
                                        onClick={() => openFolder(path)}
                                        {...dnd.target(path)}
                                    >
                                        {folderLabel(path, dotName)}
                                    </button>
                                </span>
                            ))}
                            {folder && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="size-7"
                                            aria-label="Folder actions"
                                        >
                                            <MoreHorizontal />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start">
                                        <DropdownMenuItem onSelect={() => setDialog({ kind: 'access' })}>
                                            <KeyRound /> Socio access
                                        </DropdownMenuItem>
                                        {renamable && (
                                            <DropdownMenuItem onSelect={() => setDialog({ kind: 'rename-folder' })}>
                                                <Pencil /> Rename or move
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            variant="destructive"
                                            onSelect={() => setDialog({ kind: 'delete-folder' })}
                                        >
                                            <Trash2 /> Delete folder
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </nav>
                        <div className="relative w-full sm:w-auto">
                            <Search
                                className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                aria-label="Search files"
                                placeholder={folder ? 'Search this folder' : 'Search files'}
                                className="w-full pl-8 sm:w-56"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                            />
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1" role="group" aria-label="Kind" data-slot="media-kinds">
                            {KINDS.map((entry) => (
                                <Button
                                    key={entry.value || 'all'}
                                    size="sm"
                                    variant={kind === entry.value ? 'secondary' : 'ghost'}
                                    aria-pressed={kind === entry.value}
                                    onClick={() => setParam({ kind: entry.value })}
                                >
                                    {entry.label}
                                </Button>
                            ))}
                        </div>
                        <div className="flex gap-1" role="group" aria-label="View">
                            <Button
                                size="icon"
                                variant={view === 'grid' ? 'secondary' : 'ghost'}
                                aria-label="Grid"
                                aria-pressed={view === 'grid'}
                                onClick={() => setParam({ view: '' })}
                            >
                                <LayoutGrid />
                            </Button>
                            <Button
                                size="icon"
                                variant={view === 'list' ? 'secondary' : 'ghost'}
                                aria-label="List"
                                aria-pressed={view === 'list'}
                                onClick={() => setParam({ view: 'list' })}
                            >
                                <List />
                            </Button>
                        </div>
                    </div>
                    {!listing && loading ? (
                        <Skeleton className="h-48" />
                    ) : listing && !items.length && !listing.folders.length ? (
                        <p
                            className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
                            data-slot="media-empty"
                        >
                            {q || kind
                                ? 'Nothing matches.'
                                : 'No files here yet. Upload some, or drop them on the page.'}
                        </p>
                    ) : (
                        listing &&
                        (view === 'grid' ? (
                            <MediaGrid
                                folders={q ? [] : listing.folders}
                                items={items}
                                dotName={dotName}
                                onOpenFolder={openFolder}
                                onOpen={(item) => setDialog({ kind: 'preview', item })}
                                {...itemActions}
                            />
                        ) : (
                            <MediaList
                                folders={q ? [] : listing.folders}
                                items={items}
                                dotName={dotName}
                                onOpenFolder={openFolder}
                                onOpen={(item) => setDialog({ kind: 'preview', item })}
                                {...itemActions}
                            />
                        ))
                    )}
                    {more?.cursor && (
                        <Button variant="outline" className="justify-self-center" onClick={() => void loadMore()}>
                            Load more
                        </Button>
                    )}
                </section>
            </div>
            {dragging && (
                <div
                    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/80 text-sm font-medium"
                    data-slot="media-drop"
                >
                    Drop to upload into {folderLabel(folder, dotName)}
                </div>
            )}

            {dialog?.kind === 'preview' && (
                <MediaPreview
                    item={dialog.item}
                    onClose={close}
                    onMove={() => setDialog({ kind: 'move', item: dialog.item })}
                    onDelete={() => setDialog({ kind: 'delete', item: dialog.item })}
                />
            )}
            {dialog?.kind === 'move' && (
                <MoveDialog
                    title={`Move or rename ${dialog.item.name}`}
                    folders={listing?.tree ?? []}
                    initialFolder={dialog.item.folder}
                    initialName={dialog.item.path.split('/').pop()!}
                    dotName={dotName}
                    onClose={close}
                    onSubmit={async (path) => {
                        if (await move(fileDrag(dialog.item), path)) {
                            close();
                        }
                    }}
                />
            )}
            {dialog?.kind === 'move-folder' && (
                <MoveDialog
                    title={`Move ${folderName(dialog.path)}`}
                    description="Everything in it moves along, and socios with access to it keep it."
                    folders={(listing?.tree ?? []).filter((path) => path !== 'dots/')}
                    initialFolder={parentFolder(dialog.path)}
                    initialName={folderName(dialog.path)}
                    folder
                    exclude={dialog.path}
                    dotName={dotName}
                    onClose={close}
                    onSubmit={async (path) => {
                        if (await move(folderDrag(dialog.path), path)) {
                            close();
                        }
                    }}
                />
            )}
            {dialog?.kind === 'new-folder' && (
                <MoveDialog
                    title="New folder"
                    description="An empty folder to upload into or move files to."
                    submitLabel="Create"
                    folders={listing?.tree ?? []}
                    initialFolder={folder}
                    initialName=""
                    folder
                    dotName={dotName}
                    onClose={close}
                    onSubmit={async (path) => {
                        try {
                            await createFolder(path);
                            close();
                            openFolder(path);
                            reload();
                        } catch (e) {
                            failed(e, 'Could not create the folder.');
                        }
                    }}
                />
            )}
            {dialog?.kind === 'rename-folder' && (
                <MoveDialog
                    title={`Rename or move ${folder}`}
                    description="Everything in it moves along, and socios with access to it keep it."
                    submitLabel="Rename"
                    folders={(listing?.tree ?? []).filter((path) => path !== 'dots/')}
                    initialFolder={parentFolder(folder)}
                    initialName={folderName(folder)}
                    folder
                    exclude={folder}
                    dotName={dotName}
                    onClose={close}
                    onSubmit={async (path) => {
                        try {
                            await moveFolder(folder, path);
                            close();
                            openFolder(path);
                            reload();
                        } catch (e) {
                            failed(e, 'Could not rename the folder.');
                        }
                    }}
                />
            )}
            {dialog?.kind === 'access' && <FolderAccess folder={folder} dots={dots} onClose={close} />}
            {dialog?.kind === 'delete' && (
                <ConfirmDelete
                    slot="media-confirm-delete"
                    title={`Delete ${dialog.item.name}?`}
                    onClose={close}
                    onConfirm={async () => {
                        try {
                            await deleteItem(dialog.item.id);
                            toast.success(`Deleted ${dialog.item.name}.`);
                            close();
                            reload();
                        } catch (e) {
                            failed(e, 'Could not delete the file.');
                        }
                    }}
                >
                    It’s removed from your files.
                    {dialog.item.attachments.length > 0 &&
                        ` It was attached in ${dialog.item.attachments.length === 1 ? 'a conversation' : `${dialog.item.attachments.length} conversations`}, which will show it as removed.`}
                </ConfirmDelete>
            )}
            {dialog?.kind === 'delete-folder' && (
                <ConfirmDelete
                    slot="media-confirm-delete"
                    title={`Delete ${folder} and everything in it?`}
                    onClose={close}
                    onConfirm={async () => {
                        try {
                            const { deleted } = await deleteFolder(folder);
                            toast.success(
                                deleted === 1
                                    ? 'Deleted the folder and 1 file.'
                                    : `Deleted the folder and ${deleted} files.`,
                            );
                            close();
                            openFolder(parentFolder(folder));
                            reload();
                        } catch (e) {
                            failed(e, 'Could not delete the folder.');
                        }
                    }}
                >
                    Every file in it and its subfolders is removed from your files. Files attached in conversations show
                    there as removed, and socios lose their access to the folder.
                </ConfirmDelete>
            )}
        </WorkspacePage>
    );
}
