import { Check, ChevronDown, LayoutGrid, MessageSquarePlus } from 'lucide-react';
import { Link } from 'react-router';

import { shownChats } from '@socio/shared/rooms/room-view';
import type { Dot } from '@socio/shared/types';

import { useShell } from '../../shell/shell-context';

import { ChatIcon, dotPath, newChatPath } from './nav';

import { DotVisibilityBadge } from '@/components/dot-visibility-badge';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Chats the Dot's crumb menu lists; the rest are on its home page. */
export const DOT_CRUMB_CHATS = 8;

/**
 * The Dot's crumb above a chat (CB-89), a menu as VS Code's breadcrumbs
 * are: the Dot's latest chats (the open one checked), All chats (its home
 * page) and New chat, so the next chat with the same Dot is one pick
 * away.
 */
export function DotCrumb({ dot, threadId }: { dot: Dot; threadId?: string }) {
    const { workspace, state } = useShell();
    const chats = shownChats(workspace.conversations, state).filter((item) => item.dotId === dot.id);
    const shown = chats.slice(0, DOT_CRUMB_CHATS);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                data-slot="dot-crumb"
                aria-label={`${dot.name}: switch chat`}
                className="flex min-w-0 items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:text-foreground"
            >
                <span className="truncate">{dot.name}</span>
                <DotVisibilityBadge dot={dot} className="shrink-0" />
                <ChevronDown aria-hidden className="size-3.5 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72" data-slot="dot-crumb-menu">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Chats with {dot.name}
                </DropdownMenuLabel>
                {shown.length ? (
                    shown.map((thread) => {
                        const open = thread.id === threadId;
                        return (
                            <DropdownMenuItem key={thread.id} asChild>
                                <Link
                                    to={`/chats/${encodeURIComponent(thread.id)}`}
                                    data-chat={thread.id}
                                    aria-current={open ? 'page' : undefined}
                                >
                                    <ChatIcon thread={thread} />
                                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                                    {open && <Check aria-hidden className="ml-auto" />}
                                </Link>
                            </DropdownMenuItem>
                        );
                    })
                ) : (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No chats yet.</p>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link to={dotPath(dot)} data-slot="dot-crumb-home">
                        <LayoutGrid />
                        <span className="flex-1">All chats</span>
                        {chats.length > shown.length && (
                            <span className="text-xs text-muted-foreground">{chats.length}</span>
                        )}
                    </Link>
                </DropdownMenuItem>
                {!dot.archivedAt && (
                    <DropdownMenuItem asChild>
                        <Link to={newChatPath(dot)} data-slot="dot-crumb-new">
                            <MessageSquarePlus /> New chat
                        </Link>
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
