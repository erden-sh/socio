import { ArchiveRestore, Trash2 } from 'lucide-react';
import { useContext, useState } from 'react';
import { Link } from 'react-router';

import { formatNumber } from '@socio/shared/locale';
import { isRoom, roomAdmin, roomsOn, shownChats } from '@socio/shared/rooms/room-view';
import type { Conversation } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';
import { ShellContext, useShell } from '../../shell/shell-context';
import { DeleteChatDialog, useArchiveChat } from '../chat/chat-menu';
import { ChatIcon } from '../chat/nav';
import { useArchiveRoom } from '../rooms/RoomMenu';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** "Oct 12, 2026", in the reader's words once hydrated. */
const day = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * Account → Archived chats, where ChatGPT keeps them (Settings → Data
 * controls → Archived chats → Manage): how many there are, and Manage,
 * which lists them.
 */
export function ArchivedChatsSection({
    onOpenChat,
}: {
    /** A chat opened from the list (its dialog has closed). */
    onOpenChat: () => void;
}) {
    // Settings pages are in the shell; alone (tests), it has no chats.
    const shell = useContext(ShellContext);
    const [open, setOpen] = useState(false);
    if (!shell) {
        return null;
    }
    const count = shell.workspace.archived?.length ?? 0;
    return (
        <section className="grid gap-2" data-slot="archived-chats-section">
            <h3 className="font-medium">Archived chats</h3>
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-muted-foreground">
                    {count === 0
                        ? 'Chats you archive leave your sidebar and wait here.'
                        : count === 1
                          ? '1 archived chat, out of your sidebar.'
                          : `${formatNumber(count)} archived chats, out of your sidebar.`}
                </p>
                <Button variant="outline" onClick={() => setOpen(true)}>
                    Manage
                </Button>
            </div>
            <ArchivedChatsDialog
                open={open}
                onOpenChange={setOpen}
                onOpenChat={() => {
                    setOpen(false);
                    onOpenChat();
                }}
            />
        </section>
    );
}

/** The list: each chat's title (it opens), its Dot and date, Unarchive and Delete. */
function ArchivedChatsDialog({
    open,
    onOpenChange,
    onOpenChat,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onOpenChat: () => void;
}) {
    const { workspace, state } = useShell();
    // Archived rooms (CB-212) too, while Rooms are on.
    const chats = shownChats(workspace.archived ?? [], state);
    const [deleting, setDeleting] = useState<Conversation>();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-slot="archived-chats"
                className="max-h-[85svh] overflow-y-auto sm:max-w-xl"
                // Focus the dialog, not the first row's Unarchive (its tooltip
                // would open over the list); Tab goes on from there.
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    (event.currentTarget as HTMLElement).focus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>Archived chats</DialogTitle>
                    <DialogDescription>
                        Out of your sidebar and the ⌘K palette; their links still open them, and their scheduled tasks
                        keep running.
                    </DialogDescription>
                </DialogHeader>
                {chats.length === 0 ? (
                    <p className="text-sm text-muted-foreground">You have no archived chats.</p>
                ) : (
                    // The dialog is outside the sidebar's tooltip provider.
                    <TooltipProvider>
                        <ul className="grid gap-1 text-sm" aria-label="Archived chats">
                            {chats.map((thread) => (
                                <ArchivedRow
                                    key={thread.id}
                                    thread={thread}
                                    dotName={workspace.dots.find((dot) => dot.id === thread.dotId)?.name}
                                    onOpen={onOpenChat}
                                    onDelete={() => setDeleting(thread)}
                                />
                            ))}
                        </ul>
                    </TooltipProvider>
                )}
                {deleting && (
                    <DeleteChatDialog thread={deleting} onClose={() => setDeleting(undefined)} onLeave={onOpenChat} />
                )}
            </DialogContent>
        </Dialog>
    );
}

function ArchivedRow({
    thread,
    dotName,
    onOpen,
    onDelete,
}: {
    thread: Conversation;
    dotName?: string;
    onOpen: () => void;
    onDelete: () => void;
}) {
    const chat = useArchiveChat();
    const room = useArchiveRoom();
    const { state } = useShell();
    const [busy, setBusy] = useState(false);
    // A room is its admins' to unarchive, and never deleted.
    const shared = isRoom(thread);
    const unarchivable = !shared || (roomAdmin(thread) && roomsOn(state));
    const unarchive = shared ? room.unarchive : chat.unarchive;
    return (
        <li data-archived-chat={thread.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
            <ChatIcon thread={thread} className="size-4 shrink-0 text-muted-foreground" />
            <div className="grid min-w-0 flex-1">
                <Link
                    to={`/chats/${encodeURIComponent(thread.id)}`}
                    onClick={onOpen}
                    className="truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                    title={thread.title}
                >
                    {thread.title}
                </Link>
                <span className="truncate text-xs text-muted-foreground">
                    {dotName ? `${dotName} · ` : ''}Archived{' '}
                    <LocalTime value={thread.archivedAt ?? thread.createdAt} format={day} />
                </span>
            </div>
            {unarchivable && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0"
                            aria-label={`Unarchive ${thread.title}`}
                            disabled={busy}
                            onClick={async () => {
                                setBusy(true);
                                try {
                                    await unarchive(thread);
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            <ArchiveRestore />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Unarchive</TooltipContent>
                </Tooltip>
            )}
            {!shared && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 shrink-0 text-destructive hover:text-destructive"
                            aria-label={`Delete ${thread.title}`}
                            onClick={onDelete}
                        >
                            <Trash2 />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                </Tooltip>
            )}
        </li>
    );
}
