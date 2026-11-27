import {
    Archive,
    CheckCheck,
    CircleCheck,
    CircleAlert,
    CircleStop,
    History,
    LoaderCircle,
    MessageCircle,
    Plus,
    Settings2,
    Sparkles,
} from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { isRoom, shownChats } from '@socio/shared/rooms/room-view';
import type { Conversation, Dot, DotRun } from '@socio/shared/types';

import { LocalTime } from '../../lib/local-time';
import { Mascot } from '../../locals/Mascot';
import { DotStateLabel, dotState } from '../../shell/dot-state';
import {
    DotPanel,
    DotPanelAction,
    DotPanelItem,
    DotPanelReport,
    useDotPanelData,
    type DotPanelStatus,
} from '../../shell/DotPanel';
import { SectionTitle } from '../../shell/Home';
import { useShell } from '../../shell/shell-context';
import { ChatLayout, useUnarchiveDot } from '../../views/ChatViews';
import { NotFound } from '../../views/NotFound';
import { relative } from '../activity/TaskPresentation';
import { DotApps } from '../apps/DotApps';
import { Slot, useModules, useSlot } from '../context';

import { ChatIcon, dotPath, newChatPath } from './nav';

import { DotVisibilityBadge } from '@/components/dot-visibility-badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** Chats in the Now and Earlier panels; the tabs below list them all. */
export const DOT_HOME_PANEL_CHATS = 3;

const runIcon = (status: DotRun['status']) =>
    status === 'running' ? (
        <LoaderCircle className="animate-spin" />
    ) : status === 'finished' ? (
        <CheckCheck />
    ) : status === 'stopped' ? (
        <CircleStop />
    ) : (
        <CircleAlert />
    );
const chatPath = (thread: Conversation) => `/chats/${encodeURIComponent(thread.id)}`;

/** A chat's row: its icon, title, and Team or when it began (or was archived). */
function ChatItem({ thread }: { thread: Conversation }) {
    const { t } = useTranslation(['chat.dot-home']);
    return (
        <DotPanelItem
            to={chatPath(thread)}
            icon={<ChatIcon thread={thread} />}
            title={thread.title}
            meta={
                thread.team ? (
                    t('chat.dot-home:team')
                ) : isRoom(thread) ? (
                    t('chat.dot-home:room')
                ) : (
                    <LocalTime value={thread.archivedAt ?? thread.createdAt} format={relative} />
                )
            }
        />
    );
}

/** A column of panels: Now, Earlier or Next. */
function Column({ id, title, children }: { id: string; title: string; children: ReactNode }) {
    return (
        <section aria-labelledby={id} data-slot="dot-home-column" className="grid grid-cols-1 content-start gap-3">
            <SectionTitle id={id}>{title}</SectionTitle>
            {children}
        </section>
    );
}

/**
 * `/dots/:dotId` (CB-89): a Dot's home page, where its sidebar item goes.
 * A dashboard of what it does for the signed-in person: Now (active
 * chats, turns in progress, approvals waiting), Earlier (archived chats,
 * recent turns, what it filed on the board) and Next (goals, schedules),
 * then all their chats with it in Active and Archived tabs. New chat is
 * here. Only the person's own: the shell's chats are theirs, and the
 * panels' reads are too. Other modules add panels through `dot.present`,
 * `dot.past` and `dot.future`. An archived Dot's page is read-only, with
 * Unarchive for its owner or an admin.
 */
export function DotHome() {
    const { t } = useTranslation(['chat.dot-home']);
    const { workspace, state, admin, openDialog } = useShell();
    const { dotId } = useParams();
    const dot = workspace.dots.find((item) => item.id === dotId);
    // Its turns: In progress and Recent turns, and whether it is working.
    const runs = useDotPanelData<DotRun[]>(`/dots/${encodeURIComponent(dotId ?? '')}/runs`);
    if (!dot) {
        return <NotFound what="Socio" />;
    }
    const mine = !!dot.ownerId && dot.ownerId === workspace.user.id;
    const now = dotState(dot.id, state, !!runs.data?.some((run) => run.status === 'running'));
    return (
        <ChatLayout dot={dot}>
            <main
                data-slot="dot-home"
                className="@container mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 px-4 py-6 md:px-8 md:py-8"
            >
                <div className="grid grid-cols-1 items-center gap-4 @xl:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="flex min-w-0 items-center gap-5">
                        <Mascot
                            identity={dot.id}
                            character={dot.character}
                            name={dot.name}
                            small
                            decorative
                            state={now}
                            className="size-18! shrink-0"
                        />
                        <div className="grid min-w-0 grid-cols-1 gap-1">
                            <h1
                                data-slot="dot-home-title"
                                className="flex min-w-0 items-center gap-2 text-2xl font-medium tracking-tight md:text-[1.75rem] md:leading-9"
                            >
                                <span className="truncate">{dot.name}</span>
                                <DotVisibilityBadge dot={dot} className="py-0 leading-5" />
                            </h1>
                            <p
                                data-slot="dot-home-subtitle"
                                className="line-clamp-2 max-w-160 text-sm text-muted-foreground"
                            >
                                {dot.instructions || t('chat.dot-home:ready')}
                            </p>
                            <DotStateLabel state={now} className="mt-0.5" />
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {/* Anyone who uses it may read its Soul (CB-179). */}
                        <Button variant="outline" asChild>
                            <Link to={`${dotPath(dot)}/soul`} data-slot="dot-home-soul">
                                <Sparkles />
                                {t('chat.dot-home:soul')}
                            </Link>
                        </Button>
                        {!dot.archivedAt && (admin || mine) && (
                            <Button
                                variant="outline"
                                onClick={() => openDialog({ type: 'dot', dot, spaceId: dot.spaceId })}
                            >
                                <Settings2 />
                                {t('chat.dot-home:settings')}
                            </Button>
                        )}
                        {!dot.archivedAt && (
                            <Button asChild>
                                <Link to={newChatPath(dot)} data-slot="dot-home-new-chat">
                                    <Plus />
                                    {t('chat.dot-home:new-chat')}
                                </Link>
                            </Button>
                        )}
                    </div>
                </div>
                {dot.archivedAt && <ArchivedBanner dot={dot} />}
                <Dashboard key={dot.id} dot={dot} runs={runs} />
            </main>
        </ChatLayout>
    );
}

/** An archived Dot: read-only, with Unarchive for its owner or an admin. */
function ArchivedBanner({ dot }: { dot: Dot }) {
    const { t } = useTranslation(['chat.dot-home']);
    const { allowed, busy, unarchive } = useUnarchiveDot(dot);
    return (
        <div
            role="status"
            data-slot="dot-archived"
            className="flex items-center gap-3 rounded-lg border bg-muted/60 px-4 py-2 text-sm text-foreground"
        >
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="flex-1">{t('chat.dot-home:archived.banner')}</p>
            {allowed && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void unarchive()}>
                    {t('chat.dot-home:archived.unarchive')}
                </Button>
            )}
        </div>
    );
}

/**
 * One line instead of the panels when every one of them is empty
 * (CB-308), with links to where things would show up.
 */
function QuietNow() {
    const { t } = useTranslation(['chat.dot-home']);
    const modules = useModules();
    const links = [
        ['approvals', '/approvals', t('chat.dot-home:quiet.approvals')],
        ['schedules', '/schedules', t('chat.dot-home:quiet.schedules')],
        ['issues', '/issues', t('chat.dot-home:quiet.board')],
    ].filter(([id]) => modules.some((module) => module.id === id));
    return (
        <section aria-labelledby="dot-now-quiet">
            <SectionTitle id="dot-now-quiet">{t('chat.dot-home:columns.now')}</SectionTitle>
            <div
                data-slot="dot-home-quiet"
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3.5 text-sm text-muted-foreground shadow-xs"
            >
                <CircleCheck aria-hidden className="size-4 shrink-0" />
                <p className="min-w-0 flex-1">{t('chat.dot-home:quiet.text')}</p>
                {links.length > 0 && (
                    <nav
                        aria-label={t('chat.dot-home:quiet.links')}
                        className="flex min-w-0 flex-wrap gap-x-4 text-[13px]"
                    >
                        {links.map(([id, to, label]) => (
                            <Link
                                key={id}
                                to={to!}
                                className="rounded outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            >
                                {label}
                            </Link>
                        ))}
                    </nav>
                )}
            </div>
        </section>
    );
}

/**
 * The three columns of panels, then the chats' tabs. While every panel is
 * empty they fold into one line; they stay mounted out of sight, so they
 * keep reading and come back as soon as one has something.
 */
function Dashboard({ dot, runs }: { dot: Dot; runs: ReturnType<typeof useDotPanelData<DotRun[]>> }) {
    const { t } = useTranslation(['chat.dot-home']);
    const { workspace, state } = useShell();
    const [panels, setPanels] = useState<Record<string, DotPanelStatus>>({});
    const report = useCallback(
        (slot: string, status: DotPanelStatus | null) =>
            setPanels((current) => {
                if (status === null) {
                    if (!(slot in current)) {
                        return current;
                    }
                    const { [slot]: _gone, ...rest } = current;
                    return rest;
                }
                return current[slot] === status ? current : { ...current, [slot]: status };
            }),
        [],
    );
    const statuses = Object.values(panels);
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') === 'archived' ? 'archived' : 'active';
    const chatsRef = useRef<HTMLElement>(null);
    const future = useSlot('dot.future');
    const active = shownChats(workspace.conversations, state).filter((item) => item.dotId === dot.id);
    const archived = shownChats(workspace.archived ?? [], state).filter((item) => item.dotId === dot.id);
    const running = runs.data?.filter((run) => run.status === 'running') ?? [];
    const recent = runs.data?.filter((run) => run.status !== 'running') ?? [];
    const runsLoading = !runs.data && !runs.failed;
    // Next without panels says "Nothing planned": nothing to wait for.
    const quiet = !!statuses.length && statuses.every((status) => status === 'empty');
    // `?tab=archived` picks the tab, so it can be linked to.
    const pickTab = (next: string) =>
        setParams(next === 'archived' ? { tab: next } : {}, {
            replace: true,
            preventScrollReset: true,
        });
    // A panel's "All": that tab, scrolled to.
    const showTab = (next: 'active' | 'archived') => {
        pickTab(next);
        chatsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const allChats = (next: 'active' | 'archived', count: number) =>
        count > DOT_HOME_PANEL_CHATS ? (
            <DotPanelAction onClick={() => showTab(next)}>{t('chat.dot-home:all', { count })}</DotPanelAction>
        ) : undefined;
    const archivedDot = dot.archivedAt ? 'archived' : undefined;
    return (
        <DotPanelReport.Provider value={report}>
            {quiet && <QuietNow />}
            <div
                data-slot="dot-home-panels"
                hidden={quiet}
                className="grid grid-cols-1 gap-8 @3xl:grid-cols-3 @3xl:gap-6"
            >
                <Column id="dot-now" title={t('chat.dot-home:columns.now')}>
                    <DotPanel
                        slot="active-chats"
                        icon={MessageCircle}
                        tone="mint"
                        title={t('chat.dot-home:panels.active')}
                        count={active.length}
                        empty={t('chat.dot-home:panels.active-empty', { name: dot.name, context: archivedDot })}
                        action={allChats('active', active.length)}
                    >
                        {active.slice(0, DOT_HOME_PANEL_CHATS).map((thread) => (
                            <ChatItem key={thread.id} thread={thread} />
                        ))}
                    </DotPanel>
                    <DotPanel
                        slot="running"
                        icon={LoaderCircle}
                        tone="sky"
                        title={t('chat.dot-home:panels.running')}
                        count={running.length}
                        loading={runsLoading}
                        failed={runs.failed}
                        empty={
                            runs.failed
                                ? t('chat.dot-home:panels.load-failed')
                                : t('chat.dot-home:panels.running-empty')
                        }
                    >
                        {running.map((run) => (
                            <DotPanelItem
                                key={run.runId}
                                to={`/chats/${encodeURIComponent(run.threadId)}`}
                                icon={runIcon(run.status)}
                                title={run.title}
                                meta={<LocalTime value={run.startedAt} format={relative} />}
                            />
                        ))}
                    </DotPanel>
                    <Slot name="dot.present" props={{ dot }} />
                </Column>
                <Column id="dot-earlier" title={t('chat.dot-home:columns.earlier')}>
                    <DotPanel
                        slot="archived-chats"
                        icon={Archive}
                        tone="slate"
                        title={t('chat.dot-home:panels.archived')}
                        count={archived.length}
                        empty={t('chat.dot-home:panels.archived-empty')}
                        action={allChats('archived', archived.length)}
                    >
                        {archived.slice(0, DOT_HOME_PANEL_CHATS).map((thread) => (
                            <ChatItem key={thread.id} thread={thread} />
                        ))}
                    </DotPanel>
                    <DotPanel
                        slot="recent-runs"
                        icon={History}
                        tone="indigo"
                        title={t('chat.dot-home:panels.recent')}
                        loading={runsLoading}
                        failed={runs.failed}
                        empty={
                            runs.failed ? t('chat.dot-home:panels.load-failed') : t('chat.dot-home:panels.recent-empty')
                        }
                    >
                        {recent.slice(0, 5).map((run) => (
                            <DotPanelItem
                                key={run.runId}
                                to={`/chats/${encodeURIComponent(run.threadId)}`}
                                icon={runIcon(run.status)}
                                title={run.title}
                                meta={
                                    <>
                                        {run.status === 'finished' ? '' : `${t(`chat.dot-home:run.${run.status}`)} · `}
                                        <LocalTime value={run.startedAt} format={relative} />
                                    </>
                                }
                            />
                        ))}
                    </DotPanel>
                    <Slot name="dot.past" props={{ dot }} />
                </Column>
                <Column id="dot-next" title={t('chat.dot-home:columns.next')}>
                    {future.length ? (
                        <Slot name="dot.future" props={{ dot }} />
                    ) : (
                        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                            {t('chat.dot-home:panels.nothing-planned')}
                        </p>
                    )}
                </Column>
            </div>
            <DotApps dot={dot} />
            <section ref={chatsRef} aria-labelledby="dot-chats" className="scroll-mt-4">
                <SectionTitle id="dot-chats">{t('chat.dot-home:chats.title')}</SectionTitle>
                <Tabs value={tab} onValueChange={pickTab} className="gap-3">
                    <TabsList aria-label={t('chat.dot-home:chats.tabs', { name: dot.name })}>
                        <TabsTrigger value="active" data-slot="dot-chats-active">
                            {t('chat.dot-home:chats.active')}
                            <span className="text-xs text-muted-foreground">{active.length}</span>
                        </TabsTrigger>
                        <TabsTrigger value="archived" data-slot="dot-chats-archived">
                            {t('chat.dot-home:chats.archived')}
                            <span className="text-xs text-muted-foreground">{archived.length}</span>
                        </TabsTrigger>
                    </TabsList>
                    <TabsContent value="active">
                        <ChatList
                            chats={active}
                            empty={t('chat.dot-home:chats.active-empty', { name: dot.name, context: archivedDot })}
                        />
                    </TabsContent>
                    <TabsContent value="archived">
                        <ChatList
                            chats={archived}
                            empty={t('chat.dot-home:chats.archived-empty', { name: dot.name })}
                        />
                    </TabsContent>
                </Tabs>
            </section>
        </DotPanelReport.Provider>
    );
}

/** Every chat of one tab, newest first. */
function ChatList({ chats, empty }: { chats: Conversation[]; empty: string }) {
    return chats.length ? (
        <ul data-slot="dot-chat-list" className="grid grid-cols-1 gap-0.5 rounded-xl border bg-card p-1.5 shadow-xs">
            {chats.map((thread) => (
                <ChatItem key={thread.id} thread={thread} />
            ))}
        </ul>
    ) : (
        <p
            data-slot="dot-chat-list-empty"
            className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
        >
            {empty}
        </p>
    );
}
