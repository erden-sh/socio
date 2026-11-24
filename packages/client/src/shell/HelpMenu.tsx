import { BookOpen, CircleHelp, Gift, Keyboard, MoreHorizontal } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { askShortcut } from '../modules/ask/ask-context';
import { openGuides } from '../modules/onboarding/events';
import { usePluginReleaseNotes } from '../modules/whats-new/use-plugin-release-notes';
import { useWhatsNew } from '../modules/whats-new/use-whats-new';
import { WhatsNewPanel } from '../modules/whats-new/WhatsNewMenu';
import { OPEN_WHATS_NEW, WhatsNewModal } from '../modules/whats-new/WhatsNewModal';

import { HeaderMenuProvider, type HeaderMenu } from './header-menu';
import { setHelpAnchor } from './help-anchor';
import { paletteShortcut, useUiHints } from './ui-hints';

import { ThemeSegments } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const kbd = 'rounded border border-b-2 px-1 font-mono text-[11px] leading-4 text-muted-foreground';

/** Whether `event` is the "?" that opens the shortcuts, not typing. */
export function isShortcutsKey(event: KeyboardEvent) {
    if (event.key !== '?' || event.defaultPrevented) {
        return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
        return false;
    }
    const target = event.target;
    return !(
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))
    );
}

/** The shortcuts that work anywhere in the app, in a dialog. */
function ShortcutsDialog({
    open,
    onOpenChange,
    returnFocus,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Where the focus goes back on closing, when a menu opened it. */
    returnFocus?: { current: HTMLElement | null };
}) {
    const hints = useUiHints();
    const mod = hints.mac ? '⌘' : 'Ctrl ';
    const rows: [string, string][] = [
        ['Search', paletteShortcut(hints)],
        ['Ask a socio', askShortcut(hints)],
        ['Collapse or expand the sidebar', `${mod}B`],
        ['Keyboard shortcuts', '?'],
    ];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                data-slot="shortcuts-dialog"
                className="sm:max-w-sm"
                onCloseAutoFocus={(event) => {
                    const back = returnFocus?.current;
                    if (!back) {
                        return;
                    }
                    returnFocus.current = null;
                    event.preventDefault();
                    back.focus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>They work on every page.</DialogDescription>
                </DialogHeader>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-sm">
                    {rows.map(([what, keys]) => (
                        <div key={what} className="contents">
                            <dt>{what}</dt>
                            <dd>
                                <kbd className={kbd}>{keys}</kbd>
                            </dd>
                        </div>
                    ))}
                </dl>
            </DialogContent>
        </Dialog>
    );
}

/** The Help menu's items: in the Help menu, and in the phone header's ⋯. */
function HelpItems({
    unreadCount,
    onGuides,
    onWhatsNew,
    onShortcuts,
}: {
    unreadCount: number;
    onGuides: () => void;
    onWhatsNew: () => void;
    onShortcuts: () => void;
}) {
    return (
        <>
            <DropdownMenuItem className="h-8.5" onSelect={onGuides}>
                <BookOpen />
                Help and guides
            </DropdownMenuItem>
            <DropdownMenuItem className="h-8.5" data-slot="whats-new-button" onSelect={onWhatsNew}>
                <Gift />
                What’s new
                {unreadCount > 0 && (
                    <span
                        data-slot="whats-new-count"
                        aria-label={`${unreadCount} new`}
                        className="ml-auto rounded-sm bg-primary/12 px-1.5 font-mono text-xs text-primary tabular-nums dark:bg-primary/20"
                    >
                        {unreadCount}
                    </span>
                )}
            </DropdownMenuItem>
            <DropdownMenuItem className="h-8.5" aria-keyshortcuts="Shift+?" onSelect={onShortcuts}>
                <Keyboard />
                Keyboard shortcuts
                <kbd className={`ml-auto ${kbd}`}>?</kbd>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="mx-1 my-1.5" />
            <ThemeSegments />
        </>
    );
}

/** The dot on a header button while there is a new release. */
const newReleaseDot = (
    <span
        aria-hidden
        data-slot="whats-new-dot"
        className="absolute top-1.5 right-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
    />
);

/**
 * The header's Help menu (CB-308): Help and guides, What's new (with its
 * count of new releases, and a dot on the button while there are any),
 * Keyboard shortcuts ("?" opens them from anywhere) and the theme. What's
 * new opens as a popover from the same button; the onboarding offer is
 * anchored to it too (help-anchor.ts).
 *
 * With `overflow`, phones get the header's ⋯ menu in its place: those
 * items (the header's other controls), then the Help menu's. Only one of
 * the two buttons shows at a time (Help from `md` up, ⋯ below), and What's
 * new and the onboarding offer open from whichever does.
 */
export function HelpMenu({ overflow }: { overflow?: ReactNode }) {
    const workspaceNews = useWhatsNew();
    // CB-527: a plugin the person may open with a newer version counts too.
    const pluginNews = usePluginReleaseNotes();
    const unread = workspaceNews.unread || pluginNews.unreadCount > 0;
    const unreadCount = workspaceNews.unreadCount + pluginNews.unreadCount;
    const markSeen = () => {
        workspaceNews.markSeen();
        pluginNews.markSeen();
    };
    const [menu, setMenu] = useState(false);
    const [more, setMore] = useState(false);
    const [whatsNew, setWhatsNew] = useState(false);
    const [shortcuts, setShortcuts] = useState(false);
    // An item that opens something else waits until the menu has closed:
    // opened while the menu's layer is still up, a popover or dialog takes
    // the menu's own closing for a click outside and closes at once. Focus
    // then goes to what opened, not back to the button.
    const handoff = useRef<(() => void) | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    // The ⋯ menu's items hand off the same way, but with the focus on ⋯
    // first, so what they open gives it back there (header-menu.tsx).
    const moreHandoff = useRef<((from: HTMLElement | null) => void) | null>(null);
    const moreRef = useRef<HTMLButtonElement | null>(null);
    // Where What's new gives the focus back: the button it opened from.
    const returnTo = useRef<HTMLButtonElement | null>(null);
    // The shortcuts opened from ⋯ give the focus back to it.
    const shortcutsFrom = useRef<HTMLElement | null>(null);
    const headerMenu = useMemo<HeaderMenu>(
        () => ({
            defer: (open) => {
                moreHandoff.current = open;
            },
        }),
        [],
    );
    const title = useId();
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!isShortcutsKey(event)) {
                return;
            }
            event.preventDefault();
            setShortcuts((open) => !open);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    const openWhatsNew = (from: HTMLButtonElement | null) => {
        returnTo.current = from;
        setWhatsNew(true);
        markSeen();
    };
    // The What's new modal's "See everything" (CB-527): from whichever button shows.
    const openFromEvent = useRef(openWhatsNew);
    openFromEvent.current = openWhatsNew;
    useEffect(() => {
        const onOpen = () => {
            const more = moreRef.current;
            openFromEvent.current(more && more.offsetParent !== null ? more : buttonRef.current);
        };
        window.addEventListener(OPEN_WHATS_NEW, onOpen);
        return () => window.removeEventListener(OPEN_WHATS_NEW, onOpen);
    }, []);
    const label = unread ? 'Help (new release)' : 'Help';
    const moreLabel = unread ? 'More options (new release)' : 'More options';
    return (
        <>
            <Popover
                open={whatsNew}
                onOpenChange={(next) => {
                    setWhatsNew(next);
                    if (next) {
                        markSeen();
                    }
                }}
            >
                <PopoverAnchor asChild>
                    {/* Measures as whichever button shows: the popover and the
                        onboarding offer open from it. */}
                    <div ref={setHelpAnchor} data-slot="help-anchor" className="flex items-center">
                        <DropdownMenu open={menu} onOpenChange={setMenu}>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    ref={buttonRef}
                                    variant="ghost"
                                    size="icon"
                                    className={cn('relative', overflow !== undefined && 'max-md:hidden')}
                                    data-slot="help-menu-button"
                                    aria-label={label}
                                    title={label}
                                >
                                    <CircleHelp className="size-4.5" />
                                    {unread && newReleaseDot}
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                collisionPadding={8}
                                data-slot="help-menu"
                                className="w-64 p-1.5"
                                onCloseAutoFocus={(event) => {
                                    const open = handoff.current;
                                    if (!open) {
                                        return;
                                    }
                                    handoff.current = null;
                                    event.preventDefault();
                                    open();
                                }}
                            >
                                <HelpItems
                                    unreadCount={unreadCount}
                                    onGuides={() => {
                                        handoff.current = () => openGuides();
                                    }}
                                    onWhatsNew={() => {
                                        handoff.current = () => openWhatsNew(buttonRef.current);
                                    }}
                                    onShortcuts={() => {
                                        handoff.current = () => setShortcuts(true);
                                    }}
                                />
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {overflow !== undefined && (
                            <DropdownMenu open={more} onOpenChange={setMore}>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        ref={moreRef}
                                        variant="ghost"
                                        size="icon"
                                        className="relative md:hidden"
                                        data-slot="header-overflow-button"
                                        aria-label={moreLabel}
                                        title={moreLabel}
                                    >
                                        <MoreHorizontal className="size-4.5" />
                                        {unread && newReleaseDot}
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    collisionPadding={8}
                                    data-slot="header-overflow-menu"
                                    className="w-64 p-1.5"
                                    onCloseAutoFocus={(event) => {
                                        const open = moreHandoff.current;
                                        if (!open) {
                                            return;
                                        }
                                        moreHandoff.current = null;
                                        event.preventDefault();
                                        moreRef.current?.focus();
                                        open(moreRef.current);
                                    }}
                                >
                                    <HeaderMenuProvider value={headerMenu}>{overflow}</HeaderMenuProvider>
                                    <DropdownMenuSeparator className="mx-1 my-1.5" />
                                    <HelpItems
                                        unreadCount={unreadCount}
                                        onGuides={() => {
                                            moreHandoff.current = () => openGuides();
                                        }}
                                        onWhatsNew={() => {
                                            moreHandoff.current = () => openWhatsNew(moreRef.current);
                                        }}
                                        onShortcuts={() => {
                                            moreHandoff.current = () => {
                                                shortcutsFrom.current = moreRef.current;
                                                setShortcuts(true);
                                            };
                                        }}
                                    />
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>
                </PopoverAnchor>
                <PopoverContent
                    align="end"
                    aria-labelledby={title}
                    data-slot="whats-new-menu"
                    collisionPadding={8}
                    // Opened from a menu, it has no trigger of its own: focus goes
                    // back to the button whose menu opened it.
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        (returnTo.current ?? buttonRef.current)?.focus();
                    }}
                    className="grid w-[min(22rem,calc(100vw-1.5rem))] grid-cols-1 gap-0 p-0"
                >
                    <WhatsNewPanel titleId={title} onClose={() => setWhatsNew(false)} />
                </PopoverContent>
            </Popover>
            <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} returnFocus={shortcutsFrom} />
            <WhatsNewModal />
        </>
    );
}
