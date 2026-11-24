import { ChevronLeft, ChevronRight, Moon, Plus, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { AvatarFilter, Calendar, MiniMonth, PluginPage, markedDayKeys, type CalendarEvent } from '@socio/plugin-ui';
import { POST_STATUSES, POST_STATUS_LABEL, SUGGESTED_ACCOUNTS } from '@socio/shared/planner';

import { loadState, plannerCall } from './api';
import {
    accountColor,
    dayKey,
    defaultLocal,
    formatClock,
    formatDayKey,
    localStamp,
    matchesPost,
    monthKeys,
    monthTitle,
    onDay,
    placeOn,
    plannerTime,
    rangeLabel,
    shiftAnchor,
    weekKeys,
} from './dates';
import { Editor } from './Editor';
import { GridView } from './GridView';
import { Replies } from './Replies';
import type { BadgeVariant, PlannedPost, PlannerState, PlannerView } from './types';
import { VoiceRail, VoiceSheet } from './VoiceRail';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const VIEWS: { id: PlannerView; label: string }[] = [
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' },
    { id: 'agenda', label: 'Agenda' },
    { id: 'grid', label: 'Grid' },
    { id: 'replies', label: 'Replies' },
];

function readView(): PlannerView {
    const value = new URLSearchParams(location.search).get('view');
    return VIEWS.some((item) => item.id === value) ? (value as PlannerView) : 'week';
}

export function App({ initial }: { initial?: PlannerState }) {
    const [state, setState] = useState(initial);
    const [loading, setLoading] = useState(!initial);
    const [notice, setNotice] = useState<string>();
    const [error, setError] = useState<string>();
    const [view, setView] = useState<PlannerView>(readView);
    const [anchor, setAnchor] = useState(initial?.now ?? Date.now());
    const [account, setAccount] = useState('all');
    const [status, setStatus] = useState('all');
    const [topic, setTopic] = useState('');
    const [badge, setBadge] = useState<BadgeVariant>('colored');
    const [editing, setEditing] = useState<PlannedPost | 'new'>();
    const [seed, setSeed] = useState<string>();
    const [voiceOpen, setVoiceOpen] = useState(true);
    const [voiceSheet, setVoiceSheet] = useState(false);
    const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
    const embedded = window.parent !== window;
    useEffect(() => {
        if (initial) {
            return;
        }
        let cancelled = false;
        loadState()
            .then((next) => {
                if (cancelled) {
                    return;
                }
                setState(next);
                setAnchor(next.now);
                setLoading(false);
            })
            .catch((reason) => {
                if (cancelled) {
                    return;
                }
                setLoading(false);
                setError(reason instanceof Error ? reason.message : 'The plan could not be loaded.');
            });
        return () => {
            cancelled = true;
        };
    }, [initial]);
    const posts = useMemo(
        () => (state?.posts ?? []).filter((post) => matchesPost(post, { account, status, topic })),
        [state, account, status, topic],
    );
    const accounts = useMemo(() => {
        const found = new Set<string>(SUGGESTED_ACCOUNTS);
        for (const post of state?.posts ?? []) {
            found.add(post.account);
        }
        return [...found];
    }, [state]);
    const events = useMemo(() => posts.map(toEvent), [posts]);
    const filterAccounts = useMemo(
        () =>
            accounts.map((id) => ({
                id,
                label: `@${id}`,
                color: accountColor(id),
                initial: id.slice(0, 1).toUpperCase(),
            })),
        [accounts],
    );
    const calendarView = view === 'week' || view === 'month' || view === 'agenda';
    const nav = view === 'month' ? 'month' : 'week';
    const keys = view === 'month' ? monthKeys(anchor) : weekKeys(anchor);
    const today = dayKey(state?.now ?? Date.now());
    const title = view === 'month' ? monthTitle(anchor) : rangeLabel(weekKeys(anchor));

    const chooseView = (next: PlannerView) => {
        setView(next);
        const params = new URLSearchParams(location.search);
        if (next === 'week') {
            params.delete('view');
        } else {
            params.set('view', next);
        }
        const query = params.toString();
        history.replaceState(null, '', query ? `?${query}` : location.pathname);
    };

    const apply = (next: PlannerState, message?: string) => {
        setState(next);
        setLoading(false);
        if (message) {
            setNotice(message);
        }
        setError(undefined);
    };

    const fail = (message: string) => setError(message);

    const startNew = (day: string, hour: number, minute: number) => {
        setSeed(localStamp(day, hour, minute));
        setEditing('new');
    };

    const move = async (post: PlannedPost, key: string, hour?: number, minute?: number) => {
        const plannedAt =
            hour === undefined ? onDay(post.plannedAt, key) : (placeOn(key, hour, minute ?? 0) ?? post.plannedAt);
        if (plannedAt === post.plannedAt) {
            return;
        }
        const previous = state;
        if (previous) {
            setState({
                ...previous,
                posts: previous.posts.map((item) => (item.id === post.id ? { ...item, plannedAt } : item)),
            });
        }
        try {
            apply(await plannerCall<PlannerState>('PATCH', `/api/posts/${encodeURIComponent(post.id)}`, { plannedAt }));
            setNotice(`Moved to ${formatDayKey(key)}.`);
        } catch (reason) {
            if (previous) {
                setState(previous);
            }
            fail(reason instanceof Error ? reason.message : 'Could not reschedule.');
        }
    };

    return (
        <PluginPage>
            {calendarView && (
                <aside className="hidden w-64 shrink-0 flex-col gap-4 border-r p-3 lg:flex">
                    <MiniMonth
                        anchor={anchor}
                        today={today}
                        marked={markedDayKeys(
                            posts.map((post) => post.plannedAt),
                            plannerTime,
                        )}
                        time={plannerTime}
                        onPick={setAnchor}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        Times are America/New_York. Drag a post between days or onto a time. Click an empty slot to
                        draft one.
                    </p>
                </aside>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            {calendarView && (
                                <div className="flex items-center gap-1">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="icon-sm"
                                        aria-label={nav === 'week' ? 'Previous week' : 'Previous month'}
                                        onClick={() => setAnchor((value) => shiftAnchor(value, nav, -1))}
                                    >
                                        <ChevronLeft />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setAnchor(state?.now ?? Date.now())}
                                    >
                                        Today
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="icon-sm"
                                        aria-label={nav === 'week' ? 'Next week' : 'Next month'}
                                        onClick={() => setAnchor((value) => shiftAnchor(value, nav, 1))}
                                    >
                                        <ChevronRight />
                                    </Button>
                                </div>
                            )}
                            <div>
                                <p className="text-[12px] font-semibold tracking-[1.7px] text-[#999ca8] dark:text-[#9ea1ad]">
                                    PLANNER
                                </p>
                                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Tabs value={view} onValueChange={(value) => chooseView(value as PlannerView)}>
                                <TabsList aria-label="Planner views">
                                    {VIEWS.map((item) => (
                                        <TabsTrigger key={item.id} value={item.id}>
                                            {item.label}
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                            </Tabs>
                            <Button type="button" size="sm" onClick={() => startNew(dayKey(anchor), 9, 30)}>
                                <Plus /> New post
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="lg:hidden"
                                onClick={() => setVoiceSheet(true)}
                            >
                                Voice
                            </Button>
                            {!embedded && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={dark ? 'Switch to light' : 'Switch to dark'}
                                    onClick={() => {
                                        const next = !dark;
                                        document.documentElement.classList.toggle('dark', next);
                                        document.documentElement.style.colorScheme = next ? 'dark' : 'light';
                                        setDark(next);
                                    }}
                                >
                                    {dark ? <Sun /> : <Moon />}
                                </Button>
                            )}
                        </div>
                    </div>
                    {view !== 'replies' && (
                        <div className="flex flex-wrap items-center gap-2">
                            <AvatarFilter accounts={filterAccounts} value={account} onChange={setAccount} />
                            <Select value={status} onValueChange={setStatus}>
                                <SelectTrigger className="w-44" aria-label="Status">
                                    <SelectValue placeholder="Status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All statuses</SelectItem>
                                    {POST_STATUSES.map((item) => (
                                        <SelectItem key={item} value={item}>
                                            {POST_STATUS_LABEL[item]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Input
                                value={topic}
                                onChange={(event) => setTopic(event.target.value)}
                                placeholder="Product tag"
                                aria-label="Product tag"
                                className="w-40"
                            />
                            {calendarView && (
                                <div className="flex items-center gap-1" role="group" aria-label="Badge style">
                                    {(['colored', 'dot'] as const).map((item) => (
                                        <Button
                                            key={item}
                                            type="button"
                                            size="sm"
                                            variant={badge === item ? 'default' : 'outline'}
                                            onClick={() => setBadge(item)}
                                        >
                                            {item === 'colored' ? 'Color' : 'Marker'}
                                        </Button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </header>
                {notice && (
                    <p className="px-4 pt-2 text-sm text-muted-foreground" aria-live="polite">
                        {notice}
                    </p>
                )}
                {error && (
                    <p className="px-4 pt-3 text-sm text-destructive" role="alert">
                        {error}
                    </p>
                )}
                {loading && <Loading view={view} />}
                {!loading && state && view === 'replies' && (
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                        <Replies
                            replies={state.replies}
                            onChange={(next) => apply(next, 'Reply saved.')}
                            onError={fail}
                        />
                    </div>
                )}
                {!loading && state && view === 'grid' && (
                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                        {posts.length === 0 ? (
                            <EmptyPlan
                                filtered={state.posts.length > 0}
                                onNew={() => startNew(dayKey(anchor), 9, 30)}
                                onClear={() => {
                                    setAccount('all');
                                    setStatus('all');
                                    setTopic('');
                                }}
                            />
                        ) : (
                            <GridView posts={posts} onOpen={setEditing} />
                        )}
                    </div>
                )}
                {!loading && state && calendarView && (
                    <>
                        {state.posts.length === 0 && (
                            <p className="px-4 pt-3 text-sm text-muted-foreground">
                                Nothing planned yet. Click a time slot, or add a post. It stays a draft until you open
                                it in X.
                            </p>
                        )}
                        <Calendar
                            view={view}
                            anchor={anchor}
                            todayKey={today}
                            keys={keys}
                            events={events}
                            now={state.now}
                            variant={badge}
                            time={plannerTime}
                            addLabel="Add post"
                            emptyLabel="No posts"
                            onOpen={(event) => {
                                const post = posts.find((item) => item.id === event.id);
                                if (post) {
                                    setEditing(post);
                                }
                            }}
                            onMove={(event, key, hour, minute) => {
                                const post = posts.find((item) => item.id === event.id);
                                if (post) {
                                    void move(post, key, hour, minute);
                                }
                            }}
                            onCreate={startNew}
                        />
                    </>
                )}
            </div>
            <VoiceRail
                notes={state?.voice.notes ?? ''}
                open={voiceOpen}
                onOpenChange={setVoiceOpen}
                onSaved={(next) => apply(next, 'Voice saved.')}
                onError={fail}
            />
            <VoiceSheet
                notes={state?.voice.notes ?? ''}
                open={voiceSheet}
                onOpenChange={setVoiceSheet}
                onSaved={(next) => apply(next, 'Voice saved.')}
                onError={fail}
            />
            {editing && state && (
                <Editor
                    key={editing === 'new' ? `new-${seed ?? ''}` : editing.id}
                    post={editing === 'new' ? undefined : editing}
                    posts={state.posts}
                    plannedLocal={seed ?? defaultLocal(anchor)}
                    onClose={() => setEditing(undefined)}
                    onSaved={(next) => {
                        apply(next, 'Post saved.');
                        const created =
                            editing === 'new'
                                ? next.posts.find((post) => !state.posts.some((item) => item.id === post.id))
                                : undefined;
                        if (created) {
                            setEditing(created);
                        }
                    }}
                />
            )}
        </PluginPage>
    );
}

function toEvent(post: PlannedPost): CalendarEvent {
    const title = post.parts.find((part) => part.text.trim())?.text.trim() || post.topic || 'Untitled';
    return {
        id: post.id,
        title,
        start: post.plannedAt,
        color: accountColor(post.account),
        hint: `${formatClock(post.plannedAt)} · @${post.account} · ${POST_STATUS_LABEL[post.status]}`,
        detail: POST_STATUS_LABEL[post.status],
        meta: `@${post.account}`,
    };
}

function EmptyPlan({ filtered, onNew, onClear }: { filtered: boolean; onNew: () => void; onClear: () => void }) {
    return (
        <div className="mx-auto grid max-w-md justify-items-center gap-2 py-16 text-center">
            <p className="text-base font-semibold">
                {filtered ? 'No posts match these filters' : 'Nothing planned yet'}
            </p>
            <p className="text-sm text-muted-foreground">
                {filtered
                    ? 'Clear a filter to see the rest of the plan.'
                    : 'Add a post for the week. It stays a draft until you open it in X.'}
            </p>
            {filtered ? (
                <Button type="button" variant="outline" onClick={onClear}>
                    Clear filters
                </Button>
            ) : (
                <Button type="button" onClick={onNew}>
                    <Plus /> New post
                </Button>
            )}
        </div>
    );
}

function Loading({ view }: { view: PlannerView }) {
    if (view === 'replies' || view === 'grid') {
        return (
            <div className="grid gap-3 px-4 py-4" aria-busy="true" aria-label="Loading the plan">
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
            </div>
        );
    }
    return (
        <div className="grid flex-1 grid-cols-7 gap-2 px-4 py-4" aria-busy="true" aria-label="Loading the plan">
            {Array.from({ length: view === 'week' ? 7 : 14 }, (_, index) => (
                <Skeleton key={index} className="h-36" />
            ))}
        </div>
    );
}
