import type { LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { api } from '../lib/api';
import { useLiveTopic } from '../lib/change-channel';
import type { Tone } from '../modules/types';

import { toneTile } from './tones';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** How often a Dot's home page reads its panels again. */
export const DOT_PANEL_POLL_MS = 10_000;

/**
 * What one of a Dot's home panels shows (CB-89): read from `path` at once,
 * then every 10 s and when another tab changes `topic`. Undefined while
 * the first read is out; a failed read keeps what was shown (`failed`
 * when there was nothing). A new `path` (another Dot) starts over.
 */
export function useDotPanelData<T>(path: string, topic?: string) {
    const [state, setState] = useState<{
        path: string;
        data?: T;
        failed?: boolean;
    }>({ path });
    if (state.path !== path) {
        setState({ path });
    }
    const load = useCallback(
        (isActive: () => boolean = () => true) =>
            api<T>(path)
                .then((data) => {
                    if (isActive()) {
                        setState({ path, data });
                    }
                })
                .catch(() => {
                    if (isActive()) {
                        setState((current) =>
                            current.path === path && current.data !== undefined ? current : { path, failed: true },
                        );
                    }
                }),
        [path],
    );
    useEffect(() => {
        let active = true;
        const isActive = () => active;
        void load(isActive);
        const timer = setInterval(() => void load(isActive), DOT_PANEL_POLL_MS);
        return () => {
            active = false;
            clearInterval(timer);
        };
    }, [load]);
    useLiveTopic(topic, () => load());
    const current = state.path === path ? state : { path };
    return { data: current.data, failed: !!current.failed };
}

/** What a panel lists: still loading, nothing, something, or a failed read. */
export type DotPanelStatus = 'loading' | 'empty' | 'full' | 'failed';

/**
 * Where a Dot's home page hears each panel's status (CB-308), so it can
 * fold them into one line when every one is empty; null once a panel
 * goes away.
 */
export const DotPanelReport = createContext<((slot: string, status: DotPanelStatus | null) => void) | null>(null);

/**
 * One panel on a Dot's home page (a `dot.present`, `dot.past` or
 * `dot.future` contribution, or the page's own): an identity tile, a
 * title and count, an optional action (a link to the whole list), then
 * its rows; `empty` when there are none, skeleton rows while `loading`.
 */
export function DotPanel({
    icon: Icon,
    tone,
    title,
    count,
    action,
    loading,
    failed,
    empty,
    slot,
    children,
}: {
    icon: LucideIcon;
    tone: Tone;
    title: string;
    count?: number;
    action?: ReactNode;
    loading?: boolean;
    /** Its read failed: `empty` says so, and it never counts as empty. */
    failed?: boolean;
    /** Shown when nothing is listed. */
    empty: string;
    /** Its `data-panel`, for tests. */
    slot: string;
    children?: ReactNode;
}) {
    const rows = Array.isArray(children) ? children.flat() : children;
    const none = !loading && (!rows || (Array.isArray(rows) && !rows.length));
    const status: DotPanelStatus = loading ? 'loading' : none ? (failed ? 'failed' : 'empty') : 'full';
    const report = useContext(DotPanelReport);
    useEffect(() => {
        if (!report) {
            return;
        }
        report(slot, status);
        return () => report(slot, null);
    }, [report, slot, status]);
    return (
        <section
            data-slot="dot-panel"
            data-panel={slot}
            aria-label={title}
            className="grid grid-cols-1 gap-0.5 rounded-xl border bg-card p-1.5 text-card-foreground shadow-xs"
        >
            <div className="flex min-w-0 items-center gap-2 px-2 pt-1 pb-1.5">
                <span
                    aria-hidden
                    className={cn('flex size-6 shrink-0 items-center justify-center rounded-md', toneTile[tone])}
                >
                    <Icon className="size-3.5" />
                </span>
                <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
                {!!count && (
                    <Badge variant="secondary" className="py-0 leading-5">
                        {count}
                    </Badge>
                )}
                {action && <span className="ml-auto shrink-0">{action}</span>}
            </div>
            {loading ? (
                <div className="grid grid-cols-1 gap-1 px-1 pb-1" aria-hidden>
                    <Skeleton className="h-7" />
                    <Skeleton className="h-7" />
                </div>
            ) : none ? (
                <p data-slot="dot-panel-empty" className="px-2 pb-2 text-sm text-muted-foreground">
                    {empty}
                </p>
            ) : (
                <ul className="grid grid-cols-1 gap-0.5">{children}</ul>
            )}
        </section>
    );
}

/**
 * The small link (`to`) or button at the end of a panel's title row: the
 * whole list, on its own page or below.
 */
export function DotPanelAction({ to, onClick, children }: { to?: string; onClick?: () => void; children: ReactNode }) {
    const className = 'font-normal text-muted-foreground';
    return to ? (
        <Button asChild variant="ghost" size="xs" className={className}>
            <Link to={to}>{children}</Link>
        </Button>
    ) : (
        <Button variant="ghost" size="xs" className={className} onClick={onClick}>
            {children}
        </Button>
    );
}

/**
 * One row of a panel: a link with an icon, a title, a muted note at the
 * end (a time, a status) and an optional second line.
 */
export function DotPanelItem({
    to,
    icon,
    title,
    meta,
    detail,
}: {
    to: string;
    icon?: ReactNode;
    title: string;
    meta?: ReactNode;
    detail?: ReactNode;
}) {
    return (
        <li data-slot="dot-panel-item">
            <Link
                to={to}
                className="grid min-w-0 grid-cols-1 gap-0.5 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                <span className="flex min-w-0 items-center gap-2.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
                    {icon}
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {meta && (
                        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{meta}</span>
                    )}
                </span>
                {detail && (
                    <span className={cn('truncate text-xs text-muted-foreground', icon && 'pl-6.5')}>{detail}</span>
                )}
            </Link>
        </li>
    );
}
