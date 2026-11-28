import { Archive, ArchiveRestore, LogOut, Pencil, Send, Users } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import { roomsOn } from '@socio/shared/rooms/room-view';
import type { RoomView } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { useHeaderMenu } from '../../shell/header-menu';
import { useShell } from '../../shell/shell-context';

import { failure, roomsApi } from './api';
import { soleAdmin, successorsOf } from './MembersPanel';
import { LeaveRoomDialog, RenameRoomDialog, membersPath } from './RoomDialogs';
import { RoomNotifyItems } from './RoomNotifySettings';
import { RoomTopicDialog } from './TopicDialogs';
import { touchTarget } from './touch';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Archives and unarchives a room (room admins): "Room archived" with
 * Undo. The room stays open where it is, read-only, with Unarchive.
 */
export function useArchiveRoom() {
    const { t } = useTranslation(['rooms.nav']);
    const shell = useShell();
    const patch = async (id: string, archived: boolean) => {
        try {
            await (archived ? roomsApi.archive(id) : roomsApi.unarchive(id));
            await shell.refresh();
            return true;
        } catch (error) {
            toast.error(failure(error, archived ? t('rooms.nav:errors.archive') : t('rooms.nav:errors.unarchive')));
            return false;
        }
    };
    return {
        archive: async (thread: Pick<Conversation, 'id'>) => {
            if (!(await patch(thread.id, true))) {
                return false;
            }
            toast(t('rooms.nav:toasts.archived'), {
                action: { label: t('rooms.nav:toasts.undo'), onClick: () => void patch(thread.id, false) },
            });
            return true;
        },
        unarchive: async (thread: Pick<Conversation, 'id'>) => {
            if (!(await patch(thread.id, false))) {
                return false;
            }
            toast.success(t('rooms.nav:toasts.unarchived'));
            return true;
        },
    };
}

/**
 * Leaving, from a menu: the room's people are read first, so the last
 * admin can hand the role on in the same dialog.
 */
function LeaveFromMenu({
    thread,
    onClose,
    onLeft,
}: {
    thread: Conversation;
    onClose: () => void;
    onLeft?: () => void;
}) {
    const { t } = useTranslation(['rooms.nav']);
    const shell = useShell();
    const [room, setRoom] = useState<RoomView>();
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const controller = new AbortController();
        roomsApi.view(thread.id, controller.signal).then(setRoom, (error) => {
            if (controller.signal.aborted) {
                return;
            }
            toast.error(failure(error, t('rooms.nav:errors.read')));
            close.current();
        });
        return () => controller.abort();
    }, [thread.id, t]);
    if (!room) {
        return null;
    }
    const me = shell.workspace.user.id;
    return (
        <LeaveRoomDialog
            thread={room}
            lastAdmin={soleAdmin(room, me)}
            successors={successorsOf(room, me)}
            onClose={onClose}
            onLeft={onLeft}
        />
    );
}

/** What a room's menu opens. */
export type RoomDialog = 'rename' | 'leave' | 'topic';

/**
 * A room's menu items: Members, its Telegram topic (CB-214), and for its
 * admins Rename and Archive (or Unarchive); what of the room notifies the
 * reader (CB-216); Leave for everyone. With Rooms off a room is
 * read-only: Members, notifications and Leave.
 */
function RoomMenuItems({
    thread,
    onDialog,
    onLeave,
}: {
    thread: Conversation;
    onDialog: (dialog: RoomDialog) => void;
    onLeave?: () => void;
}) {
    const { t } = useTranslation(['rooms.nav']);
    const { state } = useShell();
    const navigate = useNavigate();
    const { archive, unarchive } = useArchiveRoom();
    const admin = thread.roomRole === 'admin' && roomsOn(state);
    return (
        <>
            <DropdownMenuItem
                className={touchTarget}
                onSelect={() => {
                    onLeave?.();
                    void navigate(membersPath(thread.id));
                }}
            >
                <Users /> {t('rooms.nav:menu.members')}
            </DropdownMenuItem>
            <DropdownMenuItem className={touchTarget} onSelect={() => onDialog('topic')}>
                <Send /> {t('rooms.nav:menu.topic')}
            </DropdownMenuItem>
            {admin && !thread.archivedAt && (
                <DropdownMenuItem className={touchTarget} onSelect={() => onDialog('rename')}>
                    <Pencil /> {t('rooms.nav:menu.rename')}
                </DropdownMenuItem>
            )}
            {admin &&
                (thread.archivedAt ? (
                    <DropdownMenuItem className={touchTarget} onSelect={() => void unarchive(thread)}>
                        <ArchiveRestore /> {t('rooms.nav:menu.unarchive')}
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem className={touchTarget} onSelect={() => void archive(thread)}>
                        <Archive /> {t('rooms.nav:menu.archive')}
                    </DropdownMenuItem>
                ))}
            <RoomNotifyItems thread={thread} />
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" className={touchTarget} onSelect={() => onDialog('leave')}>
                <LogOut /> {t('rooms.nav:menu.leave')}
            </DropdownMenuItem>
        </>
    );
}

/** The dialog a room's menu opened, if any. */
export function RoomDialogs({
    thread,
    dialog,
    onClose,
    onLeave,
}: {
    thread: Conversation;
    dialog?: RoomDialog;
    onClose: () => void;
    onLeave?: () => void;
}) {
    return (
        <>
            {dialog === 'rename' && <RenameRoomDialog thread={thread} onClose={onClose} />}
            {dialog === 'topic' && <RoomTopicDialog thread={thread} onClose={onClose} />}
            {dialog === 'leave' && <LeaveFromMenu thread={thread} onClose={onClose} onLeft={onLeave} />}
        </>
    );
}

/**
 * A room's ⋯ menu (CB-212), on its sidebar row and in its header
 * (RoomMenuItems).
 */
export function RoomMenu({
    thread,
    trigger,
    open,
    onOpenChange,
    onLeave,
    align = 'start',
}: {
    thread: Conversation;
    trigger: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Before leaving the page (closes the mobile sidebar sheet). */
    onLeave?: () => void;
    align?: 'start' | 'end';
}) {
    const [dialog, setDialog] = useState<RoomDialog>();
    return (
        <>
            <DropdownMenu open={open} onOpenChange={onOpenChange}>
                <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                <DropdownMenuContent align={align} data-slot="room-menu">
                    <RoomMenuItems thread={thread} onDialog={setDialog} onLeave={onLeave} />
                </DropdownMenuContent>
            </DropdownMenu>
            <RoomDialogs thread={thread} dialog={dialog} onClose={() => setDialog(undefined)} onLeave={onLeave} />
        </>
    );
}

/**
 * A room's menu in the phone header's ⋯ menu, where its title has no ⋯ of
 * its own: the same items under "Room". The dialogs wait for ⋯ to close
 * (header-menu.tsx) and are the header title's (ChatTitleCrumb).
 */
export function RoomMenuSection({
    thread,
    onDialog,
}: {
    thread: Conversation;
    onDialog: (dialog: RoomDialog, from: HTMLElement | null) => void;
}) {
    const { t } = useTranslation(['rooms.nav']);
    const { defer } = useHeaderMenu();
    return (
        <DropdownMenuGroup data-slot="header-room-items">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t('rooms.nav:menu.section')}
            </DropdownMenuLabel>
            <RoomMenuItems thread={thread} onDialog={(dialog) => defer((from) => onDialog(dialog, from))} />
        </DropdownMenuGroup>
    );
}
