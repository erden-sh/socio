import { ArrowRight, MessageSquarePlus, Plus } from 'lucide-react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { formatNumber } from '@socio/shared/locale';
import { isRoom, shownChats } from '@socio/shared/rooms/room-view';

import { Mascot } from '../locals/Mascot';
import { dotPath, newChatPath } from '../modules/chat/nav';
import { Slot, useModuleContext, useModules } from '../modules/context';
import { launcherCards, type ModuleEntry } from '../modules/derive';
import { RoomInvitesNotice } from '../modules/rooms/RoomInvitesNotice';
import { ReleaseFeed } from '../modules/whats-new/ReleaseFeed';
import { useWhatsNew } from '../modules/whats-new/use-whats-new';
import { allReleasesLink } from '../modules/whats-new/WhatsNewMenu';

import { DotStateLabel, dotState, useDotStateLabel } from './dot-state';
import { useShell } from './shell-context';
import { toneTile } from './tones';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Recent conversations listed on the home page. */
export const HOME_RECENT_CHATS = 6;

const card =
    'group/card flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 text-left text-card-foreground shadow-xs outline-none transition-colors hover:border-ring/40 hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50';

const appRow =
    'flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * A module's one-line description, cut to its first clause, without the
 * closing period: "What your socios ask to do, and which actions need
 * you." reads "What your socios ask to do".
 */
export const firstClause = (text: string) =>
    text
        .split(/[,;:—]|\.(?:\s|$)/)[0]!
        .trim()
        .replace(/\.$/, '');

/** A module's row in the Apps card: identity tile, name, its first clause. */
function AppRow({ entry }: { entry: ModuleEntry }) {
    const { openTarget } = useShell();
    const body = (
        <>
            <span
                aria-hidden
                className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', toneTile[entry.tone])}
            >
                <entry.icon className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1 grid-cols-1">
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{entry.title}</span>
                    {entry.badge !== undefined && entry.badge !== '0' && (
                        <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground tabular-nums">
                            {entry.badge}
                        </span>
                    )}
                </span>
                <span className="truncate text-[13px] text-muted-foreground">{firstClause(entry.description)}</span>
            </span>
        </>
    );
    return 'path' in entry.opens ? (
        <Link
            data-slot="module-card"
            data-module={entry.id}
            to={entry.opens.path}
            reloadDocument={entry.opens.reloadDocument}
            title={entry.description}
            className={appRow}
        >
            {body}
        </Link>
    ) : (
        <button
            type="button"
            data-slot="module-card"
            data-module={entry.id}
            title={entry.description}
            className={appRow}
            onClick={() => openTarget(entry.opens)}
        >
            {body}
        </button>
    );
}

/** A section's small title, in sentence case (a Dot's home page has them too). */
export function SectionTitle({
    id,
    count,
    children,
}: {
    id: string;
    /** How many it lists, in mono after the title. */
    count?: number;
    children: string;
}) {
    return (
        <h2
            id={id}
            data-slot="home-section-title"
            className="mb-3 flex min-w-0 items-baseline gap-2 text-sm font-medium text-muted-foreground"
        >
            <span className="min-w-0 truncate">{children}</span>
            {count !== undefined && (
                <span className="font-mono text-xs font-normal text-muted-foreground/80 tabular-nums">
                    {formatNumber(count)}
                </span>
            )}
        </h2>
    );
}

/** How many release cards Home shows before its "All releases" link (CB-333). */
const HOME_RELEASE_CARDS = 5;

/**
 * What's new (CB-166, CB-333): on Home, the five most recent releases as
 * cards and a link to all of them — the page no longer grows as the person
 * scrolls. Beside the apps the list scrolls in its own box; stacked on a
 * phone it is last, and the page scrolls. Nothing when there are none to
 * show.
 */
function WhatsNew() {
    const { t } = useTranslation(['shell.home']);
    const { releases, loading } = useWhatsNew();
    if (!releases.length && !loading) {
        return null;
    }
    return (
        <section aria-labelledby="home-whats-new" data-slot="home-whats-new">
            <SectionTitle id="home-whats-new">{t('shell.home:whats-new')}</SectionTitle>
            <div className="grid grid-cols-1 gap-2">
                <div
                    data-slot="home-whats-new-list"
                    className="grid grid-cols-1 @4xl:-mx-1 @4xl:max-h-[34rem] @4xl:overflow-y-auto @4xl:overscroll-contain @4xl:px-1 @4xl:py-0.5"
                >
                    <ReleaseFeed limit={HOME_RELEASE_CARDS} />
                </div>
                <Link to="/releases" className={cn(allReleasesLink, 'justify-self-start')}>
                    {t('shell.home:all-releases')}
                    <ArrowRight className="size-3.5" />
                </Link>
            </div>
        </section>
    );
}

/**
 * The line under Home's title (CB-308): real counts from what the shell
 * has already loaded, the socios always, the rest when there are any.
 */
export function useHomeCounts() {
    const { t } = useTranslation(['shell.home']);
    return ({ socios, spaces, chats, tasks }: { socios: number; spaces: number; chats: number; tasks: number }) =>
        [
            t('shell.home:counts.socios', { count: socios }),
            spaces ? t('shell.home:counts.spaces', { count: spaces }) : '',
            chats ? t('shell.home:counts.chats', { count: chats }) : '',
            tasks ? t('shell.home:counts.tasks', { count: tasks }) : '',
        ]
            .filter(Boolean)
            .join(t('shell.home:counts.separator'));
}

/**
 * `/`: the launcher. Its title, Home, over a line of counts; the Dots
 * (each opens its home page, with its state and a New chat button), the
 * modules this user can use as a dense list from the registry, the
 * modules' `home.widgets` in one At a glance card, recent conversations
 * and What's new.
 *
 * The page is laid out with CSS Grid only (flex stays inside a card or a
 * row). Every grid names its columns (`grid-cols-1` is `minmax(0, 1fr)`),
 * so a long title truncates instead of widening its column and the page.
 * The columns follow the page's own width (container queries), not the
 * window's, so they reflow the same with the sidebar open or collapsed.
 */
export function Home() {
    const { t } = useTranslation(['shell.home']);
    const homeCounts = useHomeCounts();
    const stateLabel = useDotStateLabel();
    const shell = useShell();
    const { workspace, state, configured, busy, homeDot } = shell;
    const modules = useModules();
    const context = useModuleContext();
    const cards = launcherCards(modules, context);
    const recent = shownChats(workspace.conversations, state).slice(0, HOME_RECENT_CHATS);
    const dots = workspace.dots.filter((dot) => !dot.archivedAt);
    return (
        <main
            data-slot="home"
            data-tour="home"
            className="@container mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 px-4 pt-(--page-top) pb-6 md:px-8 md:pb-8"
        >
            <div className="grid grid-cols-1 items-end gap-4 @xl:grid-cols-[minmax(0,1fr)_auto]">
                <div className="grid grid-cols-1 gap-1">
                    <h1
                        data-slot="home-title"
                        className="text-2xl font-medium tracking-tight break-words md:text-[1.75rem] md:leading-9"
                    >
                        {t('shell.home:title')}
                    </h1>
                    <p data-slot="home-subtitle" className="text-sm text-muted-foreground tabular-nums">
                        {homeCounts({
                            socios: dots.length,
                            spaces: workspace.spaces.length,
                            chats: shownChats(workspace.conversations, state).length,
                            tasks: state.tasks.length,
                        })}
                    </p>
                </div>
                {/* The sidebar has Search and Ctrl K; the page doesn't repeat it. */}
                <div className="flex flex-wrap gap-2">
                    <Button disabled={!configured || busy} onClick={() => void shell.newConversation(homeDot)}>
                        <Plus />
                        {t('shell.home:new-chat')}
                    </Button>
                </div>
            </div>

            <RoomInvitesNotice />
            <section aria-labelledby="home-dots" data-tour="socios">
                <SectionTitle id="home-dots">{t('shell.home:socios')}</SectionTitle>
                <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
                    {dots.map((dot) => {
                        const now = dotState(dot.id, state);
                        return (
                            <div key={dot.id} data-slot="dot-card" className={cn(card, 'py-2 pr-2')}>
                                <Link
                                    data-slot="dot-link"
                                    to={dotPath(dot)}
                                    prefetch="intent"
                                    aria-label={t('shell.home:open-socio', { name: dot.name, state: stateLabel(now) })}
                                    className="flex min-w-0 flex-1 items-start gap-4 rounded-lg py-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                >
                                    <Mascot
                                        identity={dot.id}
                                        character={dot.character}
                                        name={dot.name}
                                        state={now}
                                        small
                                        decorative
                                        className="size-14! shrink-0"
                                    />
                                    <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
                                        <span className="truncate text-[15px] font-medium">{dot.name}</span>
                                        <span className="line-clamp-2 text-[13px] leading-5 text-muted-foreground">
                                            {dot.instructions || t('shell.home:ready')}
                                        </span>
                                        <DotStateLabel state={now} className="mt-1.5" />
                                    </span>
                                </Link>
                                <Link
                                    data-slot="dot-new-chat"
                                    to={newChatPath(dot)}
                                    prefetch="intent"
                                    aria-label={t('shell.home:new-chat-with', { name: dot.name })}
                                    title={t('shell.home:new-chat')}
                                    className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:size-9"
                                >
                                    <MessageSquarePlus className="size-4" />
                                </Link>
                            </div>
                        );
                    })}
                </div>
            </section>

            <div className="grid grid-cols-1 gap-8 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
                <section aria-labelledby="home-apps" className="@container/apps">
                    <SectionTitle id="home-apps" count={cards.length}>
                        {t('shell.home:apps')}
                    </SectionTitle>
                    <div
                        data-slot="home-apps"
                        className="grid grid-cols-1 rounded-xl border bg-card p-1 text-card-foreground shadow-xs @md/apps:grid-cols-2"
                    >
                        {cards.map((entry) => (
                            <AppRow key={entry.id} entry={entry} />
                        ))}
                    </div>
                </section>
                <div className="grid grid-cols-1 content-start gap-8">
                    <section aria-labelledby="home-glance">
                        <SectionTitle id="home-glance">{t('shell.home:glance')}</SectionTitle>
                        {/* One card, a hairline between its rows. */}
                        <div
                            data-slot="home-glance"
                            className="grid grid-cols-1 divide-y rounded-xl border bg-card text-card-foreground shadow-xs empty:hidden"
                        >
                            <Slot name="home.widgets" props={{}} />
                        </div>
                    </section>
                    <section aria-labelledby="home-recent">
                        <SectionTitle id="home-recent">{t('shell.home:recent')}</SectionTitle>
                        {recent.length ? (
                            <ul
                                data-slot="home-recent"
                                className="grid grid-cols-1 gap-0.5 rounded-xl border bg-card p-1.5 shadow-xs"
                            >
                                {recent.map((thread) => {
                                    const dot = workspace.dots.find((item) => item.id === thread.dotId);
                                    return (
                                        <li key={thread.id} data-slot="home-recent-item">
                                            <Link
                                                data-slot="home-recent-link"
                                                to={`/chats/${encodeURIComponent(thread.id)}`}
                                                prefetch="intent"
                                                className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                            >
                                                {dot && (
                                                    <Mascot
                                                        identity={dot.id}
                                                        character={dot.character}
                                                        name={dot.name}
                                                        small
                                                        decorative
                                                        className="size-5! shrink-0"
                                                    />
                                                )}
                                                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                                                <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
                                                    {thread.team
                                                        ? t('shell.home:recent-kind', {
                                                              name: dot?.name ?? '',
                                                              context: 'team',
                                                          })
                                                        : isRoom(thread)
                                                          ? t('shell.home:recent-kind', {
                                                                name: dot?.name ?? '',
                                                                context: 'room',
                                                            })
                                                          : dot?.name}
                                                </span>
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : (
                            <p
                                data-slot="home-empty"
                                className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
                            >
                                {configured ? t('shell.home:empty') : t('shell.home:empty-setup')}
                            </p>
                        )}
                    </section>
                    <WhatsNew />
                </div>
            </div>
        </main>
    );
}
