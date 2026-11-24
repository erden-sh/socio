import { Bot, Folder, FolderOpen, Home, MessageSquare } from 'lucide-react';

import { compareText } from '@socio/shared/locale';

import { dotFolderId, folderLabel, parentFolder } from './media-api';
import { dropClass, type MediaDnd } from './media-dnd';

import { cn } from '@/lib/utils';

/** Chat attachments first, then the Dots' folders, then the user's own. */
const rank = (folder: string) => (folder.startsWith('attachments/') ? 0 : folder.startsWith('dots/') ? 1 : 2);

/**
 * The folder tree: the root, "Chat attachments", the Dots' folders (by the
 * Dot's name) and the user's folders. Top-level folders always show; the
 * folders along the way to the open one show their children. With `dnd`,
 * each folder, the root too, takes files and folders dropped on it.
 */
export function FolderTree({
    tree,
    folder,
    dotName,
    onOpen,
    dnd,
}: {
    tree: readonly string[];
    folder: string;
    dotName: (id: string) => string | undefined;
    onOpen: (folder: string) => void;
    dnd?: MediaDnd;
}) {
    const open = (path: string) => folder.startsWith(path);
    const shown = tree
        .filter((path) => {
            const parent = parentFolder(path);
            return !parent || open(parent);
        })
        .sort((a, b) => rank(a) - rank(b) || compareText(a, b));
    const entry = (path: string) => {
        const depth = path ? path.split('/').length - 1 : 0;
        const Icon = !path
            ? Home
            : path === 'attachments/'
              ? MessageSquare
              : dotFolderId(path)
                ? Bot
                : folder === path
                  ? FolderOpen
                  : Folder;
        return (
            <li key={path || '/'}>
                <button
                    type="button"
                    data-slot="media-folder"
                    data-folder={path}
                    aria-current={folder === path ? 'page' : undefined}
                    className={cn(
                        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent',
                        folder === path && 'bg-accent font-medium',
                        dropClass(dnd?.state(path)),
                    )}
                    style={{ paddingLeft: `${0.5 + Math.max(0, depth - 1) * 0.875}rem` }}
                    onClick={() => onOpen(path)}
                    {...dnd?.target(path)}
                >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate" title={folderLabel(path, dotName)}>
                        {folderLabel(path, dotName)}
                    </span>
                </button>
            </li>
        );
    };
    return (
        <nav aria-label="Folders" data-slot="media-folders" className="min-w-0">
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                {entry('')}
                {shown.map(entry)}
            </ul>
        </nav>
    );
}
