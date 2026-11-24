import { BellOff, Mail, MessagesSquare, MoreHorizontal, Plus } from 'lucide-react';
import { useState } from 'react';
import { useMatch } from 'react-router';

import { isRoom, roomsOn } from '@socio/shared/rooms/room-view';
import { unreadLabel } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import { CreateRoomDialog, InvitesDialog, roomPath } from './RoomDialogs';
import { RoomMenu } from './RoomMenu';
import { roomMuted } from './RoomNotifySettings';
import { useRoomInvites } from './use-room';

import { SidebarNote } from '@/components/nav-spaces';
import { NavButton, useSidebarNav } from '@/components/sidebar-nav';
import {
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/**
 * What sits where the row's ⋯ shows: hidden while it does (hover, focus,
 * the menu open), on screens with a pointer.
 */
const underMenu =
    'shrink-0 md:not-pointer-coarse:group-focus-within/menu-item:invisible md:not-pointer-coarse:group-hover/menu-item:invisible md:not-pointer-coarse:group-has-data-[state=open]/menu-item:invisible';

/** Rooms shown before "Show all". */
export const RECENT_ROOMS = 5;

/** A room's icon: speech bubbles, named for screen readers where it says. */
export function RoomIcon({ className }: { className?: string }) {
    return <MessagesSquare aria-label="Room" className={className} />;
}

/**
 * The sidebar's Rooms (CB-212), under the recent chats, while Settings →
 * Rooms is on: New room, the reader's invitations, and the rooms they are
 * in. Hidden entirely while Rooms are off, invitations and all.
 */
export function RoomsGroup() {
    const nav = useSidebarNav();
    const { workspace, state } = nav.context;
    const on = roomsOn(state);
    const [creating, setCreating] = useState(false);
    const [inbox, setInbox] = useState(false);
    const [all, setAll] = useState(false);
    const { invites, reload } = useRoomInvites(on, workspace);
    const rooms = workspace.conversations.filter(isRoom);
    const selected = useMatch('/chats/:threadId')?.params.threadId;
    if (!on) {
        return null;
    }
    const shown = all
        ? rooms
        : // A room with something new shows too (CB-215).
          rooms.filter((room, index) => index < RECENT_ROOMS || room.id === selected || !!room.unread);
    return (
        // Titles need the width: hidden while collapsed to icons.
        <SidebarGroup className="group-data-[collapsible=icon]:hidden" data-slot="rooms-group">
            <SidebarGroupLabel>Rooms</SidebarGroupLabel>
            <SidebarGroupAction
                aria-label="New room"
                title="New room"
                // Not `nav.go`: on a phone the dialog opens over the sidebar's
                // sheet, which closes once it leads to the new room.
                onClick={() => setCreating(true)}
            >
                <Plus />
            </SidebarGroupAction>
            <SidebarMenu>
                {invites.length > 0 && (
                    <SidebarMenuItem>
                        <SidebarMenuButton aria-haspopup="dialog" onClick={() => setInbox(true)}>
                            <Mail />
                            {/* The count is said with the name: the badge is outside
                  the button, and a label on a plain div is never read. */}
                            <span>
                                Invitations
                                <span className="sr-only">{`, ${invites.length} waiting`}</span>
                            </span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge aria-hidden>{invites.length}</SidebarMenuBadge>
                    </SidebarMenuItem>
                )}
                {!rooms.length ? (
                    <SidebarNote>
                        Rooms you create or join show here: one conversation for several people and a socio.
                    </SidebarNote>
                ) : (
                    shown.map((room) => (
                        <RoomRow
                            key={room.id}
                            room={room}
                            // The open room clears as it is read: no count on it.
                            unread={room.id === selected ? 0 : (room.unread ?? 0)}
                        />
                    ))
                )}
                {rooms.length > RECENT_ROOMS && (
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            size="sm"
                            className="text-sidebar-muted-foreground"
                            aria-expanded={all}
                            onClick={() => setAll(!all)}
                        >
                            <MoreHorizontal />
                            <span>{all ? 'Show fewer' : `Show all ${rooms.length}`}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                )}
            </SidebarMenu>
            <CreateRoomDialog open={creating} onOpenChange={setCreating} onNavigate={nav.close} />
            <InvitesDialog
                open={inbox}
                onOpenChange={setInbox}
                invites={invites}
                onChanged={() => void reload()}
                onNavigate={nav.close}
            />
        </SidebarGroup>
    );
}

/**
 * One room: opens it. Something new there since the reader last looked
 * (CB-215) makes its title bold, with the count; in a room the reader
 * muted (CB-216) the count shows without the bold, beside a crossed
 * bell. Its ⋯ (shown on hover
 * and focus, always on touch screens, and on right-click) is the room menu.
 */
function RoomRow({ room, unread }: { room: Conversation; unread: number }) {
    const nav = useSidebarNav();
    const [menu, setMenu] = useState(false);
    // Muted for the reader (CB-216): what's new shows, quietly.
    const muted = roomMuted(room);
    return (
        <SidebarMenuItem
            data-room-row={room.id}
            onContextMenu={(event) => {
                event.preventDefault();
                setMenu(true);
            }}
        >
            <NavButton
                to={roomPath(room.id)}
                title={room.title}
                onNavigate={nav.close}
                className="md:not-pointer-coarse:pr-2!"
            >
                <RoomIcon />
                <span
                    data-thread-title
                    className={cn(
                        'min-w-0 flex-1 truncate',
                        unread > 0 && !muted && 'font-semibold text-sidebar-foreground',
                    )}
                >
                    {room.title}
                </span>
                {muted && (
                    <span className={cn(underMenu, 'text-sidebar-muted-foreground')}>
                        <BellOff className="size-3.5" aria-hidden />
                        <span className="sr-only">, muted</span>
                    </span>
                )}
                {unread > 0 && (
                    <span data-room-unread={unread} className={cn(underMenu, 'flex')}>
                        <span
                            aria-hidden
                            className={cn(
                                'min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-medium tabular-nums',
                                muted
                                    ? 'bg-sidebar-accent text-sidebar-muted-foreground'
                                    : // 4.5:1 or more in both themes (globals.css).
                                      'bg-sidebar-primary text-sidebar-primary-foreground',
                            )}
                        >
                            {unreadLabel(unread)}
                        </span>
                        <span className="sr-only">{`, ${unreadLabel(unread)} unread`}</span>
                    </span>
                )}
                {room.roomRole === 'admin' && (
                    <span className={cn(underMenu, 'text-xs text-sidebar-muted-foreground')}>Admin</span>
                )}
            </NavButton>
            <RoomMenu
                thread={room}
                open={menu}
                onOpenChange={setMenu}
                onLeave={nav.close}
                trigger={
                    <SidebarMenuAction
                        showOnHover
                        aria-label={`Options for ${room.title}`}
                        className="pointer-coarse:opacity-100"
                    >
                        <MoreHorizontal />
                    </SidebarMenuAction>
                }
            />
        </SidebarMenuItem>
    );
}
