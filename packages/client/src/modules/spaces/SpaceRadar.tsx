import { Radar, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';
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

const mediumDate = dateTimeFormat({ dateStyle: 'medium' });
const day = (value: number) => mediumDate.format(value);

/** How long ago a page changed, in the reader's words: days, then months past 30. */
function useRelative() {
    const { t } = useTranslation(['spaces.radar']);
    return (value: number) => {
        const days = Math.max(0, Math.floor((Date.now() - value) / 86_400_000));
        return days < 30
            ? t('spaces.radar:ago-days', { days: -days })
            : t('spaces.radar:ago-months', { months: -Math.floor(days / 30) });
    };
}
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
    const { t } = useTranslation(['spaces.radar']);
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
                setError(failure(failed, t('spaces.radar:load-failed')));
            }
        }
    }, [base, t]);
    useEffect(() => {
        void load();
    }, [load]);
    const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));
    const clear = () => setDismissed(new Set());
    const keep = <T extends RadarEntry>(items: T[]) => items.filter((item) => !dismissed.has(item.id));

    return (
        <section
            data-slot="space-radar"
            className="w-full pb-8"
            aria-label={t('spaces.radar:label', { space: space.name })}
        >
            <PageHeader
                module={MODULE_IDS.spaces}
                title={spaceTitle(space)}
                actions={
                    state && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void load()}
                            aria-label={t('spaces.radar:refresh-label')}
                        >
                            <RefreshCw className="size-4" /> {t('spaces.radar:refresh')}
                        </Button>
                    )
                }
            >
                {t('spaces.radar:description')}
            </PageHeader>
            <SpaceTabs space={space} />
            <div className="px-4 pt-5 md:px-6">
                {missing ? (
                    <p
                        data-slot="space-radar-missing"
                        className="rounded-xl border border-dashed p-4 text-xs text-muted-foreground"
                    >
                        {t('spaces.radar:missing')}
                    </p>
                ) : !state ? (
                    <p className="text-xs text-muted-foreground">{error || t('spaces.radar:loading')}</p>
                ) : (
                    <>
                        <p
                            data-slot="space-radar-scope"
                            className="mb-6 max-w-3xl text-xs leading-[1.7] text-muted-foreground"
                        >
                            {t('spaces.radar:scope', { count: state.total, days: state.staleDays })}
                        </p>

                        <section aria-labelledby="radar-recent" className="mb-8">
                            <SectionTitle id="radar-recent">{t('spaces.radar:recent.title')}</SectionTitle>
                            <RadarList
                                slot="space-radar-recent"
                                entries={keep(state.recent)}
                                empty={t('spaces.radar:recent.empty')}
                                spaceId={space.id}
                            />
                        </section>

                        <section aria-labelledby="radar-open" className="mb-8">
                            <SectionTitle id="radar-open">{t('spaces.radar:open.title')}</SectionTitle>
                            {keep(state.open).length === 0 ? (
                                <p
                                    data-slot="space-radar-open-empty"
                                    className="max-w-3xl text-xs leading-[1.8] text-muted-foreground"
                                >
                                    <Trans t={t} i18nKey="spaces.radar:open.empty" components={{ em: <em /> }} />
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
                            <SectionTitle id="radar-stale">{t('spaces.radar:stale.title')}</SectionTitle>
                            {keep(state.stale).length === 0 ? (
                                <p
                                    data-slot="space-radar-stale-empty"
                                    className="max-w-3xl text-xs leading-[1.8] text-muted-foreground"
                                >
                                    {t('spaces.radar:stale.empty', { count: state.staleDays })}
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
                                                    ? t('spaces.radar:stale.today')
                                                    : t('spaces.radar:stale.age', { count: entry.ageDays })}
                                            </small>
                                            <DismissButton
                                                label={t('spaces.radar:stale.dismiss')}
                                                onClick={() => dismiss(entry.id)}
                                            />
                                        </Card>
                                    ))}
                                </div>
                            )}
                        </section>

                        {dismissed.size > 0 && (
                            <p className="text-xs text-muted-foreground">
                                <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={clear}>
                                    {t('spaces.radar:clear', { count: dismissed.size })}
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
    const { t } = useTranslation(['spaces.radar']);
    const relative = useRelative();
    return (
        <>
            <div className="flex h-4.5 items-center gap-2">
                <Radar size={18} className="text-slate-400" />
                <Link
                    className="min-w-0 flex-1 truncate text-[13px] font-medium hover:underline underline-offset-2"
                    to={`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(entry.id)}`}
                >
                    {entry.title.trim() || t('spaces.radar:untitled')}
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
                        {t('spaces.radar:revisions', { count: entry.revisions })}
                    </>
                )}
            </small>
        </>
    );
}

/** A small dismiss/clear button for a radar entry. */
function DismissButton({ onClick, label }: { onClick: () => void; label?: string }) {
    const { t } = useTranslation(['spaces.radar']);
    return (
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={onClick}>
            {label ?? t('spaces.radar:resolved')}
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
    const { t } = useTranslation(['spaces.radar']);
    const relative = useRelative();
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
                        {entry.title.trim() || t('spaces.radar:untitled')}
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
