import { MessageCircle, MoreHorizontal, Plus, Send, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useMatch } from 'react-router';

import { isRoom } from '@socio/shared/rooms/room-view';
import type { Conversation, Dot } from '@socio/shared/types';

import { Mascot } from '../../locals/Mascot';
import { RoomIcon } from '../rooms/RoomsNav';

import { ChatMenu, ChatTitleInput, ownsChat, useChatTitle } from './chat-menu';
import { DotMenu, DotNameInput } from './dot-menu';

import { DotVisibilityBadge } from '@/components/dot-visibility-badge';
import { SidebarNote } from '@/components/nav-spaces';
import { NavButton, useSidebarNav } from '@/components/sidebar-nav';
import {
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

/** Recent chats shown before "Show all". */
export const RECENT_CHATS = 5;

/**
 * A Dot's home page (CB-89): where its sidebar item always goes, with its
 * chats, runs, goals and schedules.
 */
export const dotPath = (dot: Pick<Dot, 'id'>) => `/dots/${encodeURIComponent(dot.id)}`;

/** A new chat with a Dot: its home page's New chat, its menus, the launcher. */
export const newChatPath = (dot: Pick<Dot, 'id'>) => `${dotPath(dot)}/new`;

/**
 * The sidebar's Dots: each opens its home page. Anyone adds a Dot of
 * their own; admins edit every Dot, people their own.
 */
export function DotsGroup() {
    const nav = useSidebarNav();
    const { workspace } = nav.context;
    return (
        <SidebarGroup>
            <SidebarGroupLabel>Socios</SidebarGroupLabel>
            <SidebarGroupAction aria-label="Create socio" title="Create socio" onClick={nav.go(nav.onCreateDot)}>
                <Plus />
            </SidebarGroupAction>
            <SidebarMenu>
                {workspace.dots
                    .filter((dot) => !dot.archivedAt)
                    .map((dot) => (
                        <DotRow key={dot.id} dot={dot} />
                    ))}
            </SidebarMenu>
        </SidebarGroup>
    );
}

/**
 * One Dot: opens its home page. Its owner and admins get the Dot menu:
 * a ⋯ shown on hover and focus (always on touch screens) and on
 * right-click; Rename turns the row into a text box.
 */
function DotRow({ dot }: { dot: Dot }) {
    const nav = useSidebarNav();
    const { workspace, admin } = nav.context;
    const [menu, setMenu] = useState(false);
    const [editing, setEditing] = useState(false);
    const active = nav.activeDotId === dot.id;
    const mine = !!dot.ownerId && dot.ownerId === workspace.user.id;
    const editable = admin || mine;
    const mascot = (
        <Mascot
            identity={dot.id}
            character={dot.character}
            name={dot.name}
            small
            decorative
            className="size-5! group-data-[collapsible=icon]:size-4!"
        />
    );
    return (
        <SidebarMenuItem
            data-dot-row={dot.id}
            onContextMenu={
                editable && !editing
                    ? (event) => {
                          event.preventDefault();
                          setMenu(true);
                      }
                    : undefined
            }
        >
            {editing ? (
                <div className="flex h-8 items-center gap-2 px-2">
                    {mascot}
                    <DotNameInput dot={dot} onDone={() => setEditing(false)} />
                </div>
            ) : (
                <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={`${dot.name} (${dot.ownerId ? 'personal' : 'workspace'})`}
                >
                    <Link
                        to={dotPath(dot)}
                        title={
                            dot.ownerId
                                ? 'Personal socio: only you see and chat with it.'
                                : 'Workspace socio: everyone can see and use it.'
                        }
                        aria-current={active ? 'page' : undefined}
                        onClick={nav.close}
                    >
                        {mascot}
                        <span className="min-w-0 truncate">{dot.name}</span>
                        <DotVisibilityBadge dot={dot} className="ml-1 group-data-[collapsible=icon]:hidden" />
                    </Link>
                </SidebarMenuButton>
            )}
            {editable && !editing && (
                <DotMenu
                    dot={dot}
                    admin={admin}
                    open={menu}
                    onOpenChange={setMenu}
                    onRename={() => setEditing(true)}
                    onSettings={nav.go(() => nav.onEditDot(dot))}
                    onLeave={nav.close}
                    trigger={
                        <SidebarMenuAction
                            showOnHover
                            aria-label={`${dot.name} options`}
                            className="pointer-coarse:opacity-100"
                        >
                            <MoreHorizontal />
                        </SidebarMenuAction>
                    }
                />
            )}
        </SidebarMenuItem>
    );
}

/** The conversation's icon: room, team, Telegram or a plain chat. */
export function ChatIcon({ thread, className }: { thread: Conversation; className?: string }) {
    return isRoom(thread) ? (
        <RoomIcon className={className} />
    ) : thread.team ? (
        <Users aria-label="Team conversation" className={className} />
    ) : thread.source === 'telegram' ? (
        <Send aria-label="Telegram conversation" className={className} />
    ) : (
        <MessageCircle className={className} />
    );
}

/**
 * The sidebar's recent chats: the first few, the open one, "Show all".
 * Rooms have their own group (CB-212).
 */
export function RecentChatsGroup() {
    const nav = useSidebarNav();
    const { workspace, configured } = nav.context;
    const [allChats, setAllChats] = useState(false);
    const chats = workspace.conversations.filter((thread) => !isRoom(thread));
    const selectedThread = useMatch('/chats/:threadId')?.params.threadId;
    const shownChats = allChats
        ? chats
        : chats.filter((thread, index) => index < RECENT_CHATS || thread.id === selectedThread);
    return (
        // Titles need the width: hidden while collapsed to icons.
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Recent chats</SidebarGroupLabel>
            {configured && (
                <SidebarGroupAction
                    aria-label="New conversation"
                    title="New conversation"
                    onClick={nav.go(nav.onNewChat)}
                >
                    <Plus />
                </SidebarGroupAction>
            )}
            <SidebarMenu>
                {!configured ? (
                    <SidebarNote>Set up text chat to begin a persistent conversation.</SidebarNote>
                ) : !chats.length ? (
                    <SidebarNote>Your first conversation will live here.</SidebarNote>
                ) : (
                    shownChats.map((thread) => (
                        <ChatRow
                            key={thread.id}
                            thread={thread}
                            dotName={workspace.dots.find((dot) => dot.id === thread.dotId)?.name}
                        />
                    ))
                )}
                {configured && chats.length > RECENT_CHATS && (
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            size="sm"
                            className="text-sidebar-muted-foreground"
                            aria-expanded={allChats}
                            onClick={() => setAllChats(!allChats)}
                        >
                            <MoreHorizontal />
                            <span>{allChats ? 'Show fewer' : `Show all ${chats.length}`}</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                )}
            </SidebarMenu>
        </SidebarGroup>
    );
}

/**
 * One recent chat. The user's own get the chat menu (CB-66): a ⋯ shown on
 * hover and focus (always on touch screens) and on right-click; Rename
 * turns the row into a text box.
 */
function ChatRow({ thread, dotName }: { thread: Conversation; dotName?: string }) {
    const nav = useSidebarNav();
    const owned = ownsChat(thread, nav.context.workspace.user.id);
    const title = useChatTitle(thread);
    const [menu, setMenu] = useState(false);
    const [editing, setEditing] = useState(false);
    return (
        <SidebarMenuItem
            data-chat-row={thread.id}
            onContextMenu={
                owned && !editing
                    ? (event) => {
                          event.preventDefault();
                          setMenu(true);
                      }
                    : undefined
            }
        >
            {editing ? (
                <div className="flex h-8 items-center gap-2 px-2 pointer-coarse:h-11 [&>svg]:size-4 [&>svg]:shrink-0">
                    <ChatIcon thread={thread} />
                    <ChatTitleInput thread={thread} onDone={() => setEditing(false)} />
                </div>
            ) : (
                <NavButton
                    to={`/chats/${encodeURIComponent(thread.id)}`}
                    title={title}
                    onNavigate={nav.close}
                    // With a mouse the ⋯ takes the Dot's name's place while shown;
                    // on touch screens it always shows, beside it.
                    className={owned ? 'md:not-pointer-coarse:pr-2!' : undefined}
                >
                    <ChatIcon thread={thread} />
                    <span data-thread-title className="min-w-0 flex-1 truncate">
                        {title}
                    </span>
                    <span
                        className={cn(
                            'max-w-24 shrink-0 text-xs text-sidebar-muted-foreground',
                            owned &&
                                'md:not-pointer-coarse:group-focus-within/menu-item:invisible md:not-pointer-coarse:group-hover/menu-item:invisible md:not-pointer-coarse:group-has-data-[state=open]/menu-item:invisible',
                        )}
                    >
                        {dotName}
                        {thread.team ? ' · Team' : ''}
                    </span>
                </NavButton>
            )}
            {owned && !editing && (
                <ChatMenu
                    thread={thread}
                    open={menu}
                    onOpenChange={setMenu}
                    onRename={() => setEditing(true)}
                    onLeave={nav.close}
                    trigger={
                        <SidebarMenuAction
                            showOnHover
                            aria-label={`Options for ${title}`}
                            className="pointer-coarse:opacity-100"
                        >
                            <MoreHorizontal />
                        </SidebarMenuAction>
                    }
                />
            )}
        </SidebarMenuItem>
    );
}
