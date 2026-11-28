import { ArrowUp, X, MessageCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { Page } from '@socio/shared/pages/page-library';
import type { Conversation, WorkspaceState } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useIsAdmin } from '../../shell/current-user';
import { ClientChat } from '../chat/ClientChat';

import { PageChatRequests } from './page-chat-requests';
import { PageIconButton } from './page-chrome';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function PageConversation({
    page,
    workspace,
    paused,
    beforeChat,
    onRefresh,
    onSchedule,
    onSettings,
    onCreateDot,
    onOpenChange,
    seed,
    onSeedConsumed,
}: {
    page: Page;
    workspace: WorkspaceState;
    paused: boolean;
    beforeChat: () => Promise<boolean>;
    onRefresh: () => void;
    onSchedule: (id: string) => void;
    onSettings: () => void;
    onCreateDot: () => void;
    onOpenChange: (value: boolean) => void;
    /**
     * Open the chat seeded with a prompt and specialist (CB-281): the goal
     * destination of "Create follow-up" asks the specialist to set a goal,
     * reusing this conversation as the existing goal-set path. Each new seed
     * (by reference) fires once; the caller clears it via onSeedConsumed.
     */
    seed?: { prompt: string; dotId: string } | null;
    onSeedConsumed?: () => void;
}) {
    const { t } = useTranslation(['pages']);
    const dots = workspace.dots.filter((dot) => !dot.archivedAt && dot.spaceIds.includes(page.spaceId));
    const [dotId, setDotId] = useState('');
    const dot = dots.find((dot) => dot.id === dotId) ?? dots[0];
    const [thread, setThread] = useState<Conversation>();
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState<string>();
    const [busy, setBusy] = useState(false);
    const admin = useIsAdmin();
    const [error, setError] = useState('');
    const requests = useRef(new PageChatRequests());
    const scope = `${page.id}:${dot?.id ?? ''}`;
    requests.current.select(scope);
    useEffect(() => {
        setThread(undefined);
        setPending(undefined);
        setBusy(false);
        onOpenChange(false);
    }, [scope, onOpenChange]);
    useEffect(() => {
        const current = requests.current;
        return () => current.select('');
    }, []);
    const open = async (seeded?: string) => {
        if (!dot || busy) {
            return;
        }
        setBusy(true);
        setError('');
        const prompt = (seeded ?? draft).trim();
        await requests.current.run(
            scope,
            async () => {
                if (!(await beforeChat())) {
                    throw new Error(t('pages:chat.save-first'));
                }
                return api<Conversation>(`/spaces/${page.spaceId}/pages/${page.id}/conversation`, 'POST', {
                    dotId: dot.id,
                });
            },
            {
                success: (next) => {
                    setThread(next);
                    setPending(prompt || undefined);
                    setDraft('');
                    onOpenChange(true);
                    onRefresh();
                },
                failure: (e) => setError(e instanceof Error ? e.message : t('pages:chat.failed')),
                settled: () => setBusy(false),
            },
        );
    };
    // CB-281: an external seed (the "Create follow-up" goal destination) opens
    // the chat with a prompt already filled in, so the specialist proposes a
    // goal the person then approves. Fires once per seed reference. The dot is
    // the page's first available specialist (the same one the dialog chose).
    useEffect(() => {
        if (!seed) {
            return;
        }
        setDraft(seed.prompt);
        onSeedConsumed?.();
        void open(seed.prompt);
        // `seed` is the only trigger: open and the setters are stable enough for
        // a one-shot prompt, matching the existing open() call in the form.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [seed]);
    if (thread && dot && thread.dotId === dot.id) {
        return (
            // No data-slot here: the transcript's Markdown keeps its legacy resets.
            <aside
                className="flex h-full min-h-0 flex-col bg-card"
                aria-label={t('pages:chat.label')}
                data-tour="page-conversation"
            >
                <div
                    data-slot="page-chat-heading"
                    className="flex min-h-15.5 items-center justify-between border-b border-border/70 px-4 py-2.5"
                >
                    <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <MessageCircle size={16} /> {t('pages:chat.label')}
                    </span>
                    <PageIconButton
                        aria-label={t('pages:chat.close')}
                        onClick={() => {
                            setThread(undefined);
                            onOpenChange(false);
                        }}
                    >
                        <X className="size-[17px]" />
                    </PageIconButton>
                </div>
                <ClientChat
                    key={thread.id}
                    placement="page"
                    thread={thread}
                    dot={dot}
                    initialPrompt={pending}
                    onConsumed={() => setPending(undefined)}
                    voiceReady={workspace.setup.voice}
                    calls={workspace.calls.filter((call) => call.threadId === thread.id)}
                    paused={paused}
                    onSaved={onRefresh}
                    onSchedule={() => onSchedule(thread.id)}
                />
            </aside>
        );
    }
    if (!dot) {
        return (
            <ChatSetup
                text={admin ? t('pages:chat.setup.add-specialist') : t('pages:chat.setup.ask-admin')}
                action={admin ? t('pages:chat.setup.create-specialist') : undefined}
                onAction={onCreateDot}
            />
        );
    }
    if (workspace.setup.missing.length) {
        return (
            <ChatSetup
                text={t('pages:chat.setup.connect')}
                action={t('pages:chat.setup.set-up')}
                onAction={onSettings}
            />
        );
    }
    return (
        <div
            data-slot="page-chat-dock"
            data-tour="page-conversation"
            className="rounded-[17px] border bg-card px-[15px] pt-3.5 pb-2.5 shadow-[0_5px_25px_rgb(0_0_0/0.05)] focus-within:border-ring/60"
        >
            {error && (
                <p role="alert" className="mt-0 mb-3 px-1 text-xs/normal text-destructive">
                    {error}
                </p>
            )}
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void open();
                }}
            >
                <label className="sr-only" htmlFor="page-prompt">
                    {t('pages:chat.ask-label')}
                </label>
                <Input
                    id="page-prompt"
                    placeholder={t('pages:chat.ask-placeholder')}
                    className="h-auto rounded-none border-0 bg-transparent px-1.5 pt-[3px] pb-[15px] text-base text-foreground shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={paused || busy}
                />
                <div className="flex items-center gap-3">
                    {/* shadcn Select, like the chat's model picker (CB-257). */}
                    <Select value={dot.id} disabled={busy} onValueChange={setDotId}>
                        <SelectTrigger
                            aria-label={t('pages:chat.specialist')}
                            className="max-w-40 min-w-0 gap-1 rounded-[7px] border-0 bg-muted py-[7px] pr-2 pl-[9px] text-base text-muted-foreground shadow-none data-[size=default]:h-auto md:text-[11px] dark:bg-muted dark:hover:bg-muted max-[700px]:min-h-10 [&>svg]:size-3 [&>svg]:opacity-100"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper" align="start">
                            {dots.map((item) => (
                                <SelectItem key={item.id} value={item.id}>
                                    {item.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <span className="flex-1 text-[10px] text-muted-foreground">
                        {paused ? t('pages:chat.paused') : t('pages:chat.uses-saved')}
                    </span>
                    <Button
                        type="submit"
                        aria-label={t('pages:chat.send')}
                        disabled={busy || paused}
                        className="size-8 rounded-full bg-foreground p-0 text-background hover:bg-foreground/90 max-[700px]:size-10 [&_svg:not([class*='size-'])]:size-4.5"
                    >
                        <ArrowUp />
                    </Button>
                </div>
            </form>
        </div>
    );
}

/** In place of the page's chat box: what to set up first, and the way to it. */
function ChatSetup({ text, action, onAction }: { text: string; action?: string; onAction: () => void }) {
    return (
        <div
            data-slot="page-chat-setup"
            className="flex items-center justify-between gap-4 rounded-[12px] border bg-card px-4.5 py-4 shadow-[0_4px_20px_rgb(0_0_0/0.02)] max-[700px]:gap-2.5 max-[700px]:p-3"
        >
            <span className="text-xs/normal text-muted-foreground max-[700px]:text-[11px]">{text}</span>
            {action && (
                <Button
                    variant="outline"
                    className="h-auto min-h-9.5 shrink-0 rounded-[9px] px-[13px] py-[9px] text-xs font-normal max-[700px]:min-h-11 max-[700px]:px-2.5 max-[700px]:py-2 max-[700px]:text-[11px]"
                    onClick={onAction}
                >
                    {action}
                </Button>
            )}
        </div>
    );
}
