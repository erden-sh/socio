import { Radar, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { MODULE_IDS } from '@socio/shared/modules';
import type { RadarEntry, SpaceRadar as RadarState } from '@socio/shared/pages/page-radar';
import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { SectionTitle } from '../../shell/Home';
import { PageHeader } from '../../views/WorkspacePage';

import { SpaceTabs, spaceTitle } from './space-tabs';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const day = (value: number) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
const relative = (value: number) => {
    const diff = Date.now() - value;
    const days = Math.floor(diff / 86_400_000);
    if (days <= 0) {
        return 'today';
    }
    if (days === 1) {
        return '1 day ago';
    }
    if (days < 30) {
        return `${days} days ago`;
    }
    const months = Math.floor(days / 30);
    return months === 1 ? 'about a month ago' : `${months} months ago`;
};
const failure = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * `/spaces/:id/radar` (CB-282): a project change radar for the Space.
 * Three signals over its existing pages — recent changes, open
 * decisions/experiments (heuristic), and stale pages — each linking to
 * the page. Opt-in (its own tab); read-gated on the server (a Space the
 * person may not read is a 404). Dismissals are client-only for this
 * session: marking a page "not stale" or an open item "resolved" hides it
 * until the tab closes; nothing is written. That is a documented first-
 * cut limitation (CB-282): a persistent flag would need a new table or a
 * light existing mechanism, neither warranted yet.
 */
export function SpaceRadar({ space }: { space: Space }) {
    const [state, setState] = useState<RadarState>();
    const [missing, setMissing] = useState(false);
    const [error, setError] = useState('');
    /** Client-only dismissals this session: page ids the user cleared. */
    const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
    const base = `/spaces/${encodeURIComponent(space.id)}`;
    const load = useCallback(async () => {
        try {
            setState(await api<RadarState>(`${base}/radar`));
            setMissing(false);
            setError('');
        } catch (failed) {
            if ((failed as { status?: number }).status === 404) {
                setMissing(true);
            } else {
                setError(failure(failed, 'Could not load the change radar.'));
            }
        }
    }, [base]);
    useEffect(() => {
        void load();
    }, [load]);
    const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));
    const clear = () => setDismissed(new Set());
    const keep = <T extends RadarEntry>(items: T[]) => items.filter((item) => !dismissed.has(item.id));

    return (
        <section data-slot="space-radar" className="w-full pb-8" aria-label={`${space.name} change radar`}>
            <PageHeader
                module={MODULE_IDS.spaces}
                title={spaceTitle(space)}
                actions={
                    state && (
                        <Button size="sm" variant="outline" onClick={() => void load()} aria-label="Refresh radar">
                            <RefreshCw className="size-4" /> Refresh
                        </Button>
                    )
                }
            >
                A project change radar: what changed, what stays open, and what may be stale across this Space's pages.
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="px-4 pt-5 md:px-6">
                {missing ? (
                    <p
                        data-slot="space-radar-missing"
                        className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                    >
                        Space not found.
                    </p>
                ) : !state ? (
                    <p className="text-xs text-muted-foreground">{error || 'Loading radar…'}</p>
                ) : (
                    <>
                        <p
                            data-slot="space-radar-scope"
                            className="mb-6 max-w-3xl text-xs leading-[1.7] text-muted-foreground"
                        >
                            {state.total} live {state.total === 1 ? 'page' : 'pages'} in this Space. Stale is older than{' '}
                            {state.staleDays} days, relative to the most recent change. Markers are a simple heuristic,
                            not deep scan. Dismissals last only this session.
                        </p>

                        <section aria-labelledby="radar-recent" className="mb-8">
                            <SectionTitle id="radar-recent">Recent changes</SectionTitle>
                            <RadarList
                                slot="space-radar-recent"
                                entries={keep(state.recent)}
                                empty="No pages yet."
                                spaceId={space.id}
                            />
                        </section>

                        <section aria-labelledby="radar-open" className="mb-8">
                            <SectionTitle id="radar-open">Open decisions &amp; experiments</SectionTitle>
                            {keep(state.open).length === 0 ? (
                                <p
                                    data-slot="space-radar-open-empty"
                                    className="max-w-3xl text-xs leading-[1.8] text-muted-foreground"
                                >
                                    Nothing flagged. A page shows here when its title or excerpt carries a marker like{' '}
                                    <em>todo</em>, <em>decision</em>,<em> experiment</em>, <em>tbd</em> or{' '}
                                    <em>unresolved</em>.
                                </p>
                            ) : (
                                <div
                                    data-slot="space-radar-open"
                                    className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1"
                                >
                                    {keep(state.open).map((entry) => (
                                        <Card
                                            role="article"
                                            key={entry.id}
                                            data-page={entry.id}
                                            className="gap-0 rounded-xl p-5.5 shadow-none"
                                        >
                                            <RadarCardHead entry={entry} spaceId={space.id} />
                                            <div className="mt-2 mb-3 flex flex-wrap gap-1.5">
                                                {entry.markers.map((marker) => (
                                                    <Badge key={marker} variant="secondary" className="py-0 leading-5">
                                                        {marker}
                                                    </Badge>
                                                ))}
                                            </div>
                                            <DismissButton onClick={() => dismiss(entry.id)} />
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </section>

                        <section aria-labelledby="radar-stale" className="mb-8">
                            <SectionTitle id="radar-stale">Potentially stale</SectionTitle>
                            {keep(state.stale).length === 0 ? (
                                <p
                                    data-slot="space-radar-stale-empty"
                                    className="max-w-3xl text-xs leading-[1.8] text-muted-foreground"
                                >
                                    Nothing stale. Every page was updated within {state.staleDays} days of the most
                                    recent change.
                                </p>
                            ) : (
                                <div
                                    data-slot="space-radar-stale"
                                    className="grid grid-cols-2 gap-4 max-[920px]:grid-cols-1"
                                >
                                    {keep(state.stale).map((entry) => (
                                        <Card
                                            role="article"
                                            key={entry.id}
                                            data-page={entry.id}
                                            className="gap-0 rounded-xl p-5.5 shadow-none"
                                        >
                                            <RadarCardHead entry={entry} spaceId={space.id} />
                                            <small className="mt-1 mb-3 block text-xs text-muted-foreground">
                                                {entry.ageDays === 0
                                                    ? 'Updated today'
                                                    : `${entry.ageDays} ${entry.ageDays === 1 ? 'day' : 'days'} since the last edit`}
                                            </small>
                                            <DismissButton label="Not stale" onClick={() => dismiss(entry.id)} />
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </section>

                        {dismissed.size > 0 && (
                            <p className="text-xs text-muted-foreground">
                                <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={clear}>
                                    Clear {dismissed.size} dismissed this session
                                </Button>
                            </p>
                        )}
                    </>
                )}
            </div>
        </section>
    );
}

/** The head of a radar card: title link, excerpt, and last-edited time. */
function RadarCardHead({ entry, spaceId }: { entry: RadarEntry; spaceId: string }) {
    return (
        <>
            <div className="flex h-4.5 items-center gap-2">
                <Radar size={18} className="text-slate-400" />
                <Link
                    className="min-w-0 flex-1 truncate text-[13px] font-medium hover:underline underline-offset-2"
                    to={`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(entry.id)}`}
                >
                    {entry.title.trim() || 'Untitled page'}
                </Link>
            </div>
            {entry.excerpt && (
                <p className="mt-3 mb-2 line-clamp-2 text-[13px] leading-[1.6] text-muted-foreground">
                    {entry.excerpt}
                </p>
            )}
            <small className="block text-xs leading-[1.6] text-muted-foreground">
                <LocalTime value={entry.updatedAt} format={day} title={relative} />
                {entry.revisions > 0 && (
                    <>
                        {' · '}
                        {entry.revisions} {entry.revisions === 1 ? 'revision' : 'revisions'} kept
                    </>
                )}
            </small>
        </>
    );
}

/** A small dismiss/clear button for a radar entry. */
function DismissButton({ onClick, label = 'Resolved' }: { onClick: () => void; label?: string }) {
    return (
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={onClick}>
            {label}
        </Button>
    );
}

/** A flat list of radar entries (used for recent changes). */
function RadarList({
    slot,
    entries,
    empty,
    spaceId,
}: {
    slot: string;
    entries: RadarEntry[];
    empty: string;
    spaceId: string;
}) {
    if (!entries.length) {
        return (
            <p data-slot={`${slot}-empty`} className="max-w-3xl text-xs leading-[1.8] text-muted-foreground">
                {empty}
            </p>
        );
    }
    return (
        <ul data-slot={slot} className="grid gap-2 text-[13px]">
            {entries.map((entry) => (
                <li key={entry.id} data-page={entry.id} className="flex items-start gap-2 rounded-lg border p-3">
                    <Link
                        className="min-w-0 flex-1 truncate font-medium hover:underline underline-offset-2"
                        to={`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(entry.id)}`}
                    >
                        {entry.title.trim() || 'Untitled page'}
                    </Link>
                    <small className="shrink-0 text-xs text-muted-foreground">
                        <LocalTime value={entry.updatedAt} format={day} title={relative} />
                        {entry.revisions > 0 && ` · ${entry.revisions}↺`}
                    </small>
                </li>
            ))}
        </ul>
    );
}
