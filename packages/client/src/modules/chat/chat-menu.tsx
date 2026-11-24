import { Archive, ArchiveRestore, MoreHorizontal, MessagesSquare, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useMatch, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { roomsOn } from '@socio/shared/rooms/room-view';
import { MAX_CHAT_TITLE, type Conversation, type ConversationDeletion, type DeleteBlocker } from '@socio/shared/types';

import { api } from '../../lib/api';
import { showInHeaderMenu, useHeaderMenu } from '../../shell/header-menu';
import { useShell } from '../../shell/shell-context';
import { ConvertRoomDialog } from '../rooms/RoomDialogs';
import { RoomDialogs, RoomMenu, RoomMenuSection, type RoomDialog } from '../rooms/RoomMenu';

import { ConfirmDelete } from '@/components/confirm-delete';
import { BreadcrumbPage } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { DialogReturnFocus } from '@/components/ui/return-focus';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The chat menu (CB-66): Rename, Archive and Delete, on the sidebar's
 * chat rows (the ⋯ button and right-click) and in the chat's header. Only
 * on chats the user owns: team topics they are only in get none.
 */
export const ownsChat = (thread: Conversation, userId: string) => thread.ownerId === userId && !thread.team;

// Titles saved but not yet in the shell's workspace: a rename shows at
// once in the sidebar and the header, before the refresh lands.
const pending = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
const setPending = (id: string, title: string | undefined) => {
    if (title === undefined) {
        pending.delete(id);
    } else {
        pending.set(id, title);
    }
    for (const listener of listeners) {
        listener();
    }
};

/** The chat's title, a rename in progress included. */
export function useChatTitle(thread: Conversation) {
    const saving = useSyncExternalStore(
        subscribe,
        () => pending.get(thread.id),
        () => undefined,
    );
    return saving ?? thread.title;
}

/** Why Delete is unavailable, in the menu's tooltip. */
export const blockedReason: Record<DeleteBlocker, string> = {
    running: 'Stop the socio first',
    call: 'End the call first',
    telegram: 'Telegram chats can’t be deleted here',
    page: 'This chat belongs to a page',
};

/** "This will delete “Plan” and its 2 scheduled tasks." */
export function deleteSentence(title: string, scheduledTasks: number) {
    const tasks =
        scheduledTasks === 1
            ? ' and its scheduled task'
            : scheduledTasks > 1
              ? ` and its ${scheduledTasks} scheduled tasks`
              : '';
    return `This will delete “${title}”${tasks}.`;
}

/** Saves a new title: trimmed; empty or unchanged keeps the old one. */
function useRename(thread: Conversation) {
    const shell = useShell();
    return async (value: string) => {
        const title = value.trim().slice(0, MAX_CHAT_TITLE);
        if (!title || title === thread.title) {
            return;
        }
        setPending(thread.id, title);
        try {
            await api(`/conversations/${encodeURIComponent(thread.id)}`, 'PATCH', {
                title,
            });
            await shell.refresh();
        } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : 'Could not rename the chat.');
        } finally {
            setPending(thread.id, undefined);
        }
    };
}

/**
 * The title as a text box, in place of the row or the header's title:
 * Enter or leaving it saves, Escape keeps the old title, and so does an
 * empty box.
 */
export function ChatTitleInput({
    thread,
    onDone,
    className,
}: {
    thread: Conversation;
    onDone: () => void;
    className?: string;
}) {
    const rename = useRename(thread);
    const done = useRef(false);
    const finish = (value?: string) => {
        if (done.current) {
            return;
        }
        done.current = true;
        onDone();
        if (value !== undefined) {
            void rename(value);
        }
    };
    return (
        <Input
            aria-label="Chat title"
            data-slot="chat-title-input"
            defaultValue={thread.title}
            maxLength={MAX_CHAT_TITLE}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) {
                    return;
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    finish(event.currentTarget.value);
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish();
                }
            }}
            onBlur={(event) => finish(event.currentTarget.value)}
            className={cn('h-8 px-2 text-sm md:text-sm', className)}
        />
    );
}

/**
 * What deleting the chat would take with it and what stops it now, asked
 * while `active` (the menu or the confirm is open).
 */
function useDeletion(id: string, active: boolean) {
    const [info, setInfo] = useState<ConversationDeletion>();
    useEffect(() => {
        if (!active) {
            return;
        }
        let live = true;
        void api<ConversationDeletion>(`/conversations/${encodeURIComponent(id)}/deletion`)
            .then((next) => {
                if (live) {
                    setInfo(next);
                }
            })
            .catch(() => {
                // Delete still asks the server, which refuses with the reason.
            });
        return () => {
            live = false;
        };
    }, [active, id]);
    return active ? info : undefined;
}

/**
 * Deletes a chat: `onSettled` once the server answered (the confirm
 * closes), the toast, and a new chat with the same Dot when it was the
 * open one. False when the server refused (its reason toasts).
 */
function useDeleteChat() {
    const shell = useShell();
    const navigate = useNavigate();
    const openChat = useMatch('/chats/:threadId')?.params.threadId;
    return async (thread: Conversation, title: string, onSettled: () => void, onLeave?: () => void) => {
        try {
            await api(`/conversations/${encodeURIComponent(thread.id)}`, 'DELETE');
        } catch (cause) {
            onSettled();
            toast.error(cause instanceof Error ? cause.message : 'Could not delete the chat.');
            return false;
        }
        onSettled();
        // The open chat is gone: a new chat with the same Dot.
        if (openChat === thread.id) {
            onLeave?.();
            void navigate(`/dots/${encodeURIComponent(thread.dotId)}/new`);
        }
        toast.success(`Deleted “${title}”`);
        await shell.refresh();
        return true;
    };
}

/**
 * "Delete chat?" for one chat, naming its scheduled tasks; when something
 * stops the delete now, it says what and Delete is off.
 */
export function DeleteChatDialog({
    thread,
    onClose,
    onLeave,
}: {
    thread: Conversation;
    onClose: () => void;
    /** Before leaving the open chat it deleted. */
    onLeave?: () => void;
}) {
    const title = useChatTitle(thread);
    const info = useDeletion(thread.id, true);
    const remove = useDeleteChat();
    const blocked = info?.blocked;
    return (
        <ConfirmDelete
            title="Delete chat?"
            slot="delete-chat"
            onClose={onClose}
            disabled={!!blocked}
            onConfirm={async () => {
                await remove(thread, title, onClose, onLeave);
            }}
        >
            {blocked ? `${blockedReason[blocked]}.` : deleteSentence(title, info?.scheduledTasks ?? 0)}
        </ConfirmDelete>
    );
}

/**
 * Archives and unarchives the user's own chats, without
 * a confirm: "Chat archived" with Undo, as ChatGPT and T3 Code do. The
 * open chat archived leaves for a new chat with its Dot, as Delete does;
 * Undo brings it back and returns to it.
 */
export function useArchiveChat() {
    const shell = useShell();
    const navigate = useNavigate();
    const openChat = useMatch('/chats/:threadId')?.params.threadId;
    const patch = async (thread: Conversation, archived: boolean) => {
        try {
            await api(`/conversations/${encodeURIComponent(thread.id)}`, 'PATCH', {
                archived,
            });
            return true;
        } catch (cause) {
            toast.error(
                cause instanceof Error
                    ? cause.message
                    : archived
                      ? 'Could not archive the chat.'
                      : 'Could not unarchive the chat.',
            );
            return false;
        }
    };
    // Undo: back in the lists, and in the chat when archiving left it.
    const undo = async (thread: Conversation, back: boolean) => {
        if (!(await patch(thread, false))) {
            return;
        }
        await shell.refresh();
        if (back) {
            void navigate(`/chats/${encodeURIComponent(thread.id)}`);
        }
    };
    const unarchive = async (thread: Conversation) => {
        if (!(await patch(thread, false))) {
            return false;
        }
        toast.success('Chat unarchived');
        await shell.refresh();
        return true;
    };
    const archive = async (thread: Conversation, onLeave?: () => void) => {
        if (!(await patch(thread, true))) {
            return false;
        }
        const left = openChat === thread.id;
        if (left) {
            onLeave?.();
            void navigate(`/dots/${encodeURIComponent(thread.dotId)}/new`);
        }
        toast('Chat archived', {
            action: {
                label: 'Undo',
                onClick: () => void undo(thread, left),
            },
        });
        await shell.refresh();
        return true;
    };
    return { archive, unarchive };
}

/**
 * The chat menu's items: Rename, Share as a room (when it can be one),
 * Archive or Unarchive, and Delete, which stays focusable while something
 * stops it (`blocked`) and says what on hover, focus and tap.
 */
function ChatMenuItems({
    thread,
    blocked,
    onRename,
    onShare,
    onDelete,
    onLeave,
}: {
    thread: Conversation;
    blocked?: DeleteBlocker | null;
    onRename: () => void;
    onShare: () => void;
    onDelete: () => void;
    onLeave?: () => void;
}) {
    const shareable = useShareable(thread);
    const [why, setWhy] = useState(false);
    const { archive, unarchive } = useArchiveChat();
    return (
        <>
            <DropdownMenuItem onSelect={onRename}>
                <Pencil /> Rename
            </DropdownMenuItem>
            {shareable && (
                <DropdownMenuItem onSelect={onShare}>
                    <MessagesSquare /> Share as a room…
                </DropdownMenuItem>
            )}
            {thread.archivedAt ? (
                <DropdownMenuItem onSelect={() => void unarchive(thread)}>
                    <ArchiveRestore /> Unarchive
                </DropdownMenuItem>
            ) : (
                <DropdownMenuItem onSelect={() => void archive(thread, onLeave)}>
                    <Archive /> Archive
                </DropdownMenuItem>
            )}
            <Tooltip open={!!blocked && why} onOpenChange={setWhy}>
                <TooltipTrigger asChild>
                    <DropdownMenuItem
                        variant="destructive"
                        aria-disabled={blocked ? true : undefined}
                        className={cn(blocked && 'opacity-50')}
                        onSelect={(event) => {
                            // Disabled, but still focusable and tappable: the reason
                            // shows on hover, focus and tap.
                            if (blocked) {
                                event.preventDefault();
                                setWhy(true);
                                return;
                            }
                            onDelete();
                        }}
                    >
                        <Trash2 /> Delete
                    </DropdownMenuItem>
                </TooltipTrigger>
                {blocked && <TooltipContent side="right">{blockedReason[blocked]}</TooltipContent>}
            </Tooltip>
        </>
    );
}

/**
 * The ⋯ menu of one chat. `trigger` is its button; `open` is controlled
 * so a right-click on the row opens it too. Opening it asks the server
 * what Delete would take and whether something stops it now. An archived
 * chat (opened by its link) offers Unarchive instead of Archive.
 */
export function ChatMenu({
    thread,
    trigger,
    open,
    onOpenChange,
    onRename,
    onLeave,
    align = 'start',
}: {
    thread: Conversation;
    trigger: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: () => void;
    /** Before leaving the open chat it deleted or archived (closes the mobile sheet). */
    onLeave?: () => void;
    align?: 'start' | 'end';
}) {
    const info = useDeletion(thread.id, open);
    const [confirming, setConfirming] = useState(false);
    const [sharing, setSharing] = useState(false);
    const renaming = useRef(false);
    return (
        <>
            <DropdownMenu open={open} onOpenChange={onOpenChange}>
                <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                <DropdownMenuContent
                    align={align}
                    data-slot="chat-menu"
                    // Rename moves focus into the title box, not back to ⋯.
                    onCloseAutoFocus={(event) => {
                        if (renaming.current) {
                            event.preventDefault();
                        }
                        renaming.current = false;
                    }}
                >
                    <ChatMenuItems
                        thread={thread}
                        blocked={info?.blocked}
                        onRename={() => {
                            renaming.current = true;
                            onRename();
                        }}
                        onShare={() => setSharing(true)}
                        onDelete={() => setConfirming(true)}
                        onLeave={onLeave}
                    />
                </DropdownMenuContent>
            </DropdownMenu>
            {confirming && <DeleteChatDialog thread={thread} onClose={() => setConfirming(false)} onLeave={onLeave} />}
            {sharing && <ConvertRoomDialog thread={thread} onClose={() => setSharing(false)} />}
        </>
    );
}

/**
 * The chat menu in the phone header's ⋯ menu, where the title has no ⋯ of
 * its own: the same items under "Chat". What they open waits for ⋯ to
 * close (header-menu.tsx); the title box and the dialogs are the
 * header title's (ChatTitleCrumb).
 */
function ChatMenuSection({
    thread,
    onRename,
    onShare,
    onDelete,
}: {
    thread: Conversation;
    onRename: () => void;
    onShare: (from: HTMLElement | null) => void;
    onDelete: (from: HTMLElement | null) => void;
}) {
    const info = useDeletion(thread.id, true);
    const { defer } = useHeaderMenu();
    return (
        <DropdownMenuGroup data-slot="header-chat-items">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Chat</DropdownMenuLabel>
            <ChatMenuItems
                thread={thread}
                blocked={info?.blocked}
                onRename={() => defer(() => onRename())}
                onShare={() => defer(onShare)}
                onDelete={() => defer(onDelete)}
            />
        </DropdownMenuGroup>
    );
}

/**
 * Whether the owner can make this chat a room (CB-212): Rooms on,
 * their own web chat (not Telegram), not archived, with a company
 * socio. The server checks the rest (a call, scheduled tasks).
 */
function useShareable(thread: Conversation) {
    const { state, workspace } = useShell();
    const dot = workspace.dots.find((item) => item.id === thread.dotId);
    return (
        roomsOn(state) &&
        (thread.kind ?? 'private') === 'private' &&
        !thread.team &&
        !thread.source &&
        !thread.archivedAt &&
        !!dot &&
        !dot.ownerId &&
        !dot.archivedAt
    );
}

/**
 * The header's last crumb on a conversation: its title, and for the
 * owner a ⋯ with the chat menu; Rename edits the title in place. On
 * phones that ⋯ gives way to the header's own (AppHeader), which carries
 * the same menu, or the room's.
 */
export function ChatTitleCrumb({ thread }: { thread: Conversation }) {
    const { workspace } = useShell();
    const owned = ownsChat(thread, workspace.user.id);
    const title = useChatTitle(thread);
    const [menu, setMenu] = useState(false);
    const [editing, setEditing] = useState(false);
    // Opened from the phone header's ⋯ (the title's own menus keep theirs),
    // and given the focus back to it on closing.
    const [dialog, setDialog] = useState<{ kind: 'delete' | 'share'; from: HTMLElement | null }>();
    const [roomDialog, setRoomDialog] = useState<{ kind: RoomDialog; from: HTMLElement | null }>();
    const room = thread.kind === 'room';
    useEffect(() => {
        if (room) {
            return showInHeaderMenu(
                <RoomMenuSection thread={thread} onDialog={(kind, from) => setRoomDialog({ kind, from })} />,
            );
        }
        if (!owned || editing) {
            return;
        }
        return showInHeaderMenu(
            <ChatMenuSection
                thread={thread}
                onRename={() => setEditing(true)}
                onShare={(from) => setDialog({ kind: 'share', from })}
                onDelete={(from) => setDialog({ kind: 'delete', from })}
            />,
        );
    }, [room, owned, editing, thread]);
    // A room (CB-212): its own menu (Members, Rename, Archive, Leave).
    if (room) {
        return (
            <span className="flex min-w-0 items-center gap-1" data-slot="chat-title">
                <BreadcrumbPage className="truncate" title={title}>
                    {title}
                </BreadcrumbPage>
                <RoomMenu
                    thread={thread}
                    open={menu}
                    onOpenChange={setMenu}
                    trigger={
                        <Button
                            variant="ghost"
                            size="icon"
                            // An invisible 44 px hit area on a touch screen (CB-219).
                            className="relative size-7 shrink-0 text-muted-foreground max-md:hidden pointer-coarse:after:absolute pointer-coarse:after:-inset-2"
                            aria-label="Room options"
                        >
                            <MoreHorizontal />
                        </Button>
                    }
                />
                <DialogReturnFocus value={roomDialog?.from ?? null}>
                    <RoomDialogs thread={thread} dialog={roomDialog?.kind} onClose={() => setRoomDialog(undefined)} />
                </DialogReturnFocus>
            </span>
        );
    }
    return (
        <span className="flex min-w-0 items-center gap-1" data-slot="chat-title">
            {editing ? (
                <ChatTitleInput thread={thread} onDone={() => setEditing(false)} className="w-72 max-w-full" />
            ) : (
                <BreadcrumbPage className="truncate" title={title}>
                    {title}
                </BreadcrumbPage>
            )}
            {owned && !editing && (
                <ChatMenu
                    thread={thread}
                    open={menu}
                    onOpenChange={setMenu}
                    onRename={() => setEditing(true)}
                    trigger={
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 shrink-0 text-muted-foreground max-md:hidden"
                            aria-label="Chat options"
                        >
                            <MoreHorizontal />
                        </Button>
                    }
                />
            )}
            <DialogReturnFocus value={dialog?.from ?? null}>
                {dialog?.kind === 'delete' && <DeleteChatDialog thread={thread} onClose={() => setDialog(undefined)} />}
                {dialog?.kind === 'share' && <ConvertRoomDialog thread={thread} onClose={() => setDialog(undefined)} />}
            </DialogReturnFocus>
        </span>
    );
}
