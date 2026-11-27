import {
    ArrowUp,
    CalendarClock,
    CircleDot,
    Database,
    FileText,
    MessageCircleQuestion,
    Sparkles,
    X,
    type LucideIcon,
} from 'lucide-react';
import {
    useEffect,
    useEffectEvent,
    useRef,
    useState,
    type FormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Link } from 'react-router';

import { askContextNoun, type AskContextKind, type AskLookup, type AskOpened } from '@socio/shared/ask';
import type { Conversation } from '@socio/shared/types';

import { api } from '../../lib/api';
import { HeaderMenuItem } from '../../shell/header-menu';
import { useRouteParams, useShell } from '../../shell/shell-context';
import { useUiHints } from '../../shell/ui-hints';
import { ClientChat } from '../chat/ClientChat';
import type { SlotProps } from '../types';

import { askableSocios, askContextOf, askShortcut, isAskShortcut, OPEN_ASK, openAsk } from './ask-context';

import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const KIND_ICON: Record<AskContextKind, LucideIcon> = {
    page: FileText,
    issue: CircleDot,
    dataset: Database,
    schedule: CalendarClock,
    general: Sparkles,
};

/**
 * "Ask a socio" in the phone header's ⋯ menu: opens the panel of the
 * header's button (AskButton), which stays mounted while hidden there.
 */
export function AskMenuItem(_props: SlotProps['header.menu']) {
    return (
        <HeaderMenuItem open={openAsk} aria-keyshortcuts="Meta+J Control+J">
            <MessageCircleQuestion />
            Ask a socio
        </HeaderMenuItem>
    );
}

/**
 * The "Ask a socio" header button and its panel (CB-26), on every screen:
 * a side panel beside the view on wide screens, which stays open while the
 * person works in the view, and a bottom sheet over it on phones. ⌘J or
 * Ctrl+J toggles it from anywhere, and the palette opens it. Focus goes to
 * its message box on opening and back where it was on closing.
 */
export function AskButton(_props: SlotProps['header.actions']) {
    const [open, setOpen] = useState(false);
    const mobile = useIsMobile();
    const hints = useUiHints();
    const shortcut = askShortcut(hints);
    const before = useRef<HTMLElement | null>(null);
    const content = useRef<HTMLDivElement>(null);
    const change = (value: boolean) => {
        if (value && !open && document.activeElement instanceof HTMLElement) {
            before.current = document.activeElement;
        }
        setOpen(value);
    };
    const onWindow = useEffectEvent((next?: boolean) => change(next ?? !open));
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!isAskShortcut(event)) {
                return;
            }
            event.preventDefault();
            onWindow();
        };
        const onOpen = () => onWindow(true);
        window.addEventListener('keydown', onKey);
        window.addEventListener(OPEN_ASK, onOpen);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener(OPEN_ASK, onOpen);
        };
    }, []);
    return (
        <Sheet open={open} onOpenChange={change} modal={mobile}>
            <SheetTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Ask a socio"
                    aria-keyshortcuts="Meta+J Control+J"
                    title={`Ask a socio (${shortcut})`}
                >
                    <MessageCircleQuestion className="size-4.5" />
                </Button>
            </SheetTrigger>
            <SheetContent
                ref={content}
                side={mobile ? 'bottom' : 'right'}
                showCloseButton={false}
                className={cn(
                    'gap-0 p-0 motion-reduce:animate-none! motion-reduce:transition-none!',
                    mobile ? 'h-[85dvh] rounded-t-2xl' : 'w-[min(440px,100vw)] sm:max-w-110',
                )}
                // Beside the view on wide screens: working in the view keeps it open.
                onInteractOutside={(event) => {
                    if (!mobile) {
                        event.preventDefault();
                    }
                }}
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    (
                        content.current?.querySelector<HTMLElement>('textarea:not([disabled])') ?? content.current
                    )?.focus();
                }}
                onCloseAutoFocus={(event) => {
                    const back = before.current;
                    before.current = null;
                    if (back?.isConnected) {
                        event.preventDefault();
                        back.focus();
                    }
                }}
            >
                <AskPanel shortcut={shortcut} onLeave={() => mobile && setOpen(false)} />
            </SheetContent>
        </Sheet>
    );
}

/**
 * The panel's body: the screen's item, the socio (the person's last
 * asked, or the one picked here), and their conversation about the item
 * with it, or a box to start it.
 */
export function AskPanel({
    shortcut,
    onLeave,
}: {
    shortcut: string;
    /** A link in the panel was followed (closes the sheet on phones). */
    onLeave: () => void;
}) {
    const shell = useShell();
    const { workspace, state } = shell;
    const params = useRouteParams();
    const screen = askContextOf(params);
    // A folder (CB-426) hides its body: no "Ask about this page" on it. Once the lookup says
    // the screen's page is one, the panel asks as on a screen with no item of its own.
    const [folderId, setFolderId] = useState<string>();
    const ref: ReturnType<typeof askContextOf> =
        screen.kind === 'page' && screen.id === folderId ? { kind: 'general', id: '' } : screen;
    const dots = askableSocios(workspace.dots, ref.spaceId);
    const [picked, setPicked] = useState<string>();
    // A pick that can't answer here gives way to the person's default.
    const pick = dots.some((dot) => dot.id === picked) ? picked : undefined;
    const path = `/ask/conversation?${new URLSearchParams({
        kind: ref.kind,
        id: ref.id,
        ...(pick ? { dotId: pick } : {}),
    })}`;
    const [attempt, setAttempt] = useState(0);
    const [lookup, setLookup] = useState<{
        path: string;
        data?: AskLookup;
        error?: string;
    }>({ path });
    useEffect(() => {
        let active = true;
        void api<AskLookup>(path)
            .then((data) => {
                if (active) {
                    if (data.context.folder) {
                        setFolderId(data.context.id);
                    }
                    setLookup({ path, data });
                }
            })
            .catch((error: unknown) => {
                if (active) {
                    setLookup({
                        path,
                        error: error instanceof Error ? error.message : 'Could not load this conversation.',
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [path, attempt]);
    const current = lookup.path === path ? lookup : { path };
    const dotId = pick ?? current.data?.dotId ?? undefined;
    const dot = dots.find((item) => item.id === dotId);
    const scope = `${ref.kind}:${ref.id}:${dot?.id ?? ''}`;
    const [opened, setOpened] = useState<{
        scope: string;
        conversation: Conversation;
    }>();
    const thread =
        (opened?.scope === scope ? opened.conversation : undefined) ??
        (current.data?.conversation?.dotId === dot?.id ? current.data?.conversation : undefined) ??
        undefined;
    // The first message, for the thread it was asked in only.
    const [pending, setPending] = useState<{ threadId: string; text: string }>();
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const paused = state.settings.paused;
    const context = current.data?.context;
    const noun = askContextNoun[ref.kind];
    const Icon = KIND_ICON[ref.kind];
    // The box takes the focus once it can be used, if the panel holds it
    // (it opened while the socio was still loading).
    const box = useRef<HTMLTextAreaElement>(null);
    const ready = !!dot && !thread && !current.error;
    useEffect(() => {
        const active = document.activeElement;
        if (
            ready &&
            box.current &&
            !box.current.disabled &&
            (active === document.body || active?.getAttribute('data-slot') === 'sheet-content')
        ) {
            box.current.focus();
        }
    }, [ready]);

    const send = async (event?: FormEvent) => {
        event?.preventDefault();
        const prompt = draft.trim();
        if (!dot || busy || paused || !prompt) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            const next = await api<AskOpened>('/ask/conversation', 'POST', {
                kind: ref.kind,
                id: ref.id,
                dotId: dot.id,
            });
            setOpened({ scope, conversation: next.conversation });
            setPending({ threadId: next.conversation.id, text: prompt });
            setDraft('');
            void shell.refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not ask the socio.');
        } finally {
            setBusy(false);
        }
    };
    const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            void send(event);
        }
    };
    const choose = (id: string) => {
        setPicked(id);
        setError('');
        // Remembered for the next screen; the panel works without it.
        void api('/ask/socio', 'PUT', { dotId: id }).catch(() => {});
    };

    return (
        <div className="flex h-full min-h-0 flex-col" data-slot="ask-panel">
            <div className="flex items-center gap-2 border-b px-4 py-3">
                <MessageCircleQuestion aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <SheetTitle className="text-sm">Ask a socio</SheetTitle>
                <kbd className="ml-1 rounded border bg-muted px-1.5 font-sans text-[10px] text-muted-foreground max-md:hidden">
                    {shortcut}
                </kbd>
                <SheetClose asChild>
                    <Button variant="ghost" size="icon" className="ml-auto size-8" aria-label="Close Ask a socio">
                        <X />
                    </Button>
                </SheetClose>
            </div>
            <div className="grid grid-cols-1 gap-2 border-b px-4 py-3">
                <SheetDescription asChild>
                    <div
                        data-slot="ask-context"
                        className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
                    >
                        <Icon aria-hidden className="size-3.5 shrink-0" />
                        {current.error ? (
                            <span>This {noun} isn’t available.</span>
                        ) : !context ? (
                            <Skeleton className="h-4 w-40" aria-label="Loading" />
                        ) : context.title && context.path ? (
                            <span className="min-w-0 truncate">
                                About this {noun}:{' '}
                                <Link
                                    to={context.path}
                                    onClick={onLeave}
                                    className="font-medium text-foreground underline-offset-2 hover:underline"
                                >
                                    {context.title}
                                </Link>
                            </span>
                        ) : (
                            <span>Nothing on this screen is shared. Ask anything.</span>
                        )}
                    </div>
                </SheetDescription>
                {dots.length > 0 && (
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        Socio
                        <select
                            data-slot="native-select"
                            aria-label="Socio to ask"
                            className="h-8 max-w-56 min-w-0 flex-1 rounded-md border bg-background px-2 text-base text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-xs max-md:h-10"
                            value={dot?.id ?? ''}
                            disabled={busy || (!dot && !current.error && !current.data)}
                            onChange={(event) => choose(event.target.value)}
                        >
                            {!dot && <option value="">Choose a socio</option>}
                            {dots.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.name}
                                    {item.ownerId ? ' (yours)' : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>
            {current.error ? (
                <Notice text={current.error} action="Retry" onAction={() => setAttempt((value) => value + 1)} />
            ) : !dots.length ? (
                <Notice
                    text={
                        ref.spaceId
                            ? 'No socio can use this Space yet. Ask an admin to give one access.'
                            : 'There is no socio to ask yet. Ask an admin to add one.'
                    }
                />
            ) : workspace.setup.missing.length ? (
                <Notice
                    text="Connect your assistant to ask a socio."
                    action={shell.admin ? 'Set up assistant' : undefined}
                    onAction={() => shell.openDialog({ type: 'settings' })}
                />
            ) : thread && params.threadId === thread.id ? (
                // One chat per conversation on screen: it is the view's.
                <Notice text="This conversation is open in the main view." />
            ) : thread && dot ? (
                // Plain elements in the transcript keep their legacy resets.
                <div className="legacy-view flex min-h-0 flex-1 flex-col">
                    <ClientChat
                        key={thread.id}
                        placement="page"
                        thread={thread}
                        dot={dot}
                        initialPrompt={pending?.threadId === thread.id ? pending.text : undefined}
                        onConsumed={() => setPending(undefined)}
                        voiceReady={workspace.setup.voice}
                        calls={workspace.calls.filter((call) => call.threadId === thread.id)}
                        paused={paused || !!dot.archivedAt}
                        onSaved={() => void shell.refresh()}
                        onComputer={() => shell.setPane(true)}
                        onSchedule={() => shell.openDialog({ type: 'schedule', threadId: thread.id })}
                    />
                </div>
            ) : (
                <form className="mt-auto grid grid-cols-1 gap-2 p-4" onSubmit={(event) => void send(event)}>
                    <p className="text-xs text-muted-foreground">
                        {context?.title
                            ? `Your conversation about this ${noun} is private to you. ${dot?.name ?? 'The socio'} sees the ${noun} as you can see it now.`
                            : 'Your conversation is private to you.'}
                    </p>
                    {error && (
                        <p role="alert" className="text-xs text-destructive">
                            {error}
                        </p>
                    )}
                    <label className="sr-only" htmlFor="ask-prompt">
                        Ask {dot?.name ?? 'a socio'}
                    </label>
                    <Textarea
                        ref={box}
                        id="ask-prompt"
                        rows={3}
                        className="max-h-48 resize-none"
                        placeholder={context?.title ? `Ask about this ${noun}…` : 'Ask anything…'}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={onKeyDown}
                        disabled={paused || busy || !dot}
                    />
                    <div className="flex items-center gap-2">
                        <span className="flex-1 text-[11px] text-muted-foreground">
                            {paused ? 'Socios are paused' : 'Enter to send, Shift+Enter for a new line'}
                        </span>
                        <Button
                            type="submit"
                            size="icon"
                            aria-label={`Send to ${dot?.name ?? 'socio'}`}
                            disabled={busy || paused || !dot || !draft.trim()}
                            className="size-9 rounded-full"
                        >
                            <ArrowUp />
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}

function Notice({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
    return (
        <div
            data-slot="ask-notice"
            className="m-4 flex items-center justify-between gap-3 rounded-lg border p-3 text-xs text-muted-foreground"
        >
            <span>{text}</span>
            {action && onAction && (
                <Button variant="outline" size="sm" onClick={onAction}>
                    {action}
                </Button>
            )}
        </div>
    );
}
