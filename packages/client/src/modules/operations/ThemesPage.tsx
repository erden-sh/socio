import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { ClassifyUseView, SessionLabelRow } from '@socio/shared/classify';
import { formatNumber } from '@socio/shared/locale';
import { intentName, type OpsThemeRow, type OpsThemes } from '@socio/shared/operations/operations-themes';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { api } from '../../lib/api';

import { formatShare, StatusNote } from './activity-parts';
import { formatWhen, useOpsFormat } from './format';
import { IntentTable, OutcomeBar, OutcomeLegend } from './outcome-parts';
import { opsPath } from './sections';
import { SessionLabelPanel } from './SessionLabelPanel';
import { useOpsAnswer, useOpsQuery, useOpsSettings } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** A use's switch and evaluation, for the page's notes. */
function useUseView(use: 'intent' | 'themes') {
    const [view, setView] = useState<ClassifyUseView>();
    useEffect(() => {
        const controller = new AbortController();
        api<ClassifyUseView>(`/classify/uses/${use}`, 'GET', undefined, controller.signal)
            .then((next) => !controller.signal.aborted && setView(next))
            // The notes stay away; the numbers say what they can.
            .catch(() => undefined);
        return () => controller.abort();
    }, [use]);
    return view;
}

function UseNote({ use, view }: { use: 'intent' | 'themes'; view: ClassifyUseView | undefined }) {
    const { t } = useTranslation(['operations.themes']);
    if (!view || (view.enabled && view.versionPassed)) {
        return null;
    }
    return (
        <li>
            <Trans
                t={t}
                i18nKey={view.enabled ? 'operations.themes:notes.unevaluated' : 'operations.themes:notes.off'}
                context={use}
                components={{ link: <Link to={opsPath('settings')} className="underline" /> }}
            />
        </li>
    );
}

/**
 * Themes (CB-199): what people come to socios for. People's sessions by
 * intent, and by theme (clusters of the topics the model names), with
 * how they ended, per week; themes fewer than the floor of people share
 * are counted and never named. Then the review, where admins set
 * sessions' intent and topics: the golden set the model is evaluated
 * against.
 */
export function ThemesPage() {
    const { t } = useTranslation(['operations.themes', 'operations', 'operations.dashboard']);
    const { search } = useOpsQuery();
    const { timeZone } = useOpsSettings();
    const answer = useOpsAnswer<OpsThemes>(`/operations/themes${search}`);
    const intentUse = useUseView('intent');
    const themesUse = useUseView('themes');
    const data = answer.data;
    const facts = data?.facts;
    return (
        <>
            <StatusNote answer={data} timeZone={timeZone} error={answer.error} />
            {(intentUse || themesUse) && (
                <ul
                    data-slot="ops-themes-notes"
                    className="m-0 grid list-disc gap-1 pl-5 text-sm text-muted-foreground empty:hidden"
                >
                    <UseNote use="intent" view={intentUse} />
                    <UseNote use="themes" view={themesUse} />
                </ul>
            )}
            <section
                aria-label={t('operations.dashboard:totals')}
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
                data-slot="ops-themes-totals"
            >
                {(
                    [
                        ['sessions', facts ? formatNumber(facts.sessions) : null],
                        [
                            'with-intent',
                            facts ? formatShare(facts.sessions ? facts.withIntent / facts.sessions : null) : null,
                        ],
                        [
                            'with-themes',
                            facts ? formatShare(facts.sessions ? facts.withThemes / facts.sessions : null) : null,
                        ],
                    ] as const
                ).map(([id, value]) =>
                    data ? (
                        <Card key={id} className="gap-1 px-4 py-3 shadow-xs">
                            <span className="text-xs text-muted-foreground">{t(`operations.themes:totals.${id}`)}</span>
                            <strong className="text-2xl font-semibold tabular-nums">{value ?? '–'}</strong>
                        </Card>
                    ) : (
                        <Skeleton key={id} className="h-18 rounded-xl" />
                    ),
                )}
            </section>
            <Card data-slot="ops-themes-intents" className="gap-4">
                <CardHeader>
                    <CardTitle>{t('operations.themes:intents.title')}</CardTitle>
                    <CardDescription>{t('operations.themes:intents.description')}</CardDescription>
                </CardHeader>
                <CardContent>
                    {facts?.intents.length ? (
                        <IntentTable rows={facts.intents} />
                    ) : data ? (
                        <p className="m-0 py-2 text-sm text-muted-foreground">{t('operations.themes:intents.empty')}</p>
                    ) : (
                        <Skeleton className="h-32 w-full" />
                    )}
                </CardContent>
            </Card>
            <ThemesCard answer={data} />
            <ReviewCard timeZone={timeZone} />
        </>
    );
}

function ThemesCard({ answer }: { answer: OpsThemes | undefined }) {
    const { t } = useTranslation(['operations.themes']);
    const { bucketLabel } = useOpsFormat();
    const facts = answer?.facts;
    const [chart, setChart] = useState('all');
    const theme = facts?.themes.find((row) => row.key === chart);
    const series = theme ? theme.weeks : facts?.weekSessions;
    return (
        <Card data-slot="ops-themes" className="gap-4">
            <CardHeader>
                <CardTitle>{t('operations.themes:themes.title')}</CardTitle>
                <CardDescription>
                    {t('operations.themes:themes.description', { count: facts?.minPeople ?? 3 })}
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                {facts ? (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                                {theme
                                    ? t('operations.themes:themes.chart-topic', { topic: theme.topic })
                                    : t('operations.themes:themes.chart-all')}
                            </span>
                            <Select value={chart} onValueChange={setChart}>
                                <SelectTrigger
                                    size="sm"
                                    aria-label={t('operations.themes:themes.chart')}
                                    className="w-56"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">{t('operations.themes:themes.every')}</SelectItem>
                                    {facts.themes.map((row) => (
                                        <SelectItem key={row.key} value={row.key}>
                                            {row.topic}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {series && series.some(Boolean) && answer ? (
                            <SeriesChart
                                kind="bar"
                                label={
                                    theme
                                        ? t('operations.themes:themes.series-topic', { topic: theme.topic })
                                        : t('operations.themes:themes.chart-all')
                                }
                                xName="week"
                                yName={t('operations.themes:themes.axis')}
                                points={facts.weeks.map((at, index) => ({
                                    label: bucketLabel(at, 'week', answer.window.timeZone),
                                    value: series[index] ?? 0,
                                }))}
                            />
                        ) : (
                            <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                                {t('operations.themes:themes.empty')}
                            </p>
                        )}
                        {facts.themes.length > 0 && <ThemeTable rows={facts.themes} />}
                        {(facts.hidden.themes > 0 || facts.more > 0) && (
                            <p className="m-0 text-xs text-muted-foreground" data-slot="ops-themes-hidden">
                                {[
                                    facts.hidden.themes > 0 &&
                                        t('operations.themes:hidden.themes', {
                                            count: facts.hidden.themes,
                                            min: facts.minPeople,
                                        }),
                                    facts.more > 0 &&
                                        t('operations.themes:hidden.more', {
                                            count: facts.more,
                                            shown: facts.themes.length,
                                        }),
                                    facts.hidden.sessions > 0 &&
                                        t('operations.themes:hidden.sessions', { count: facts.hidden.sessions }),
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            </p>
                        )}
                    </>
                ) : answer ? (
                    <p className="m-0 py-2 text-sm text-muted-foreground">{t('operations.themes:themes.no-answer')}</p>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function ThemeTable({ rows }: { rows: OpsThemeRow[] }) {
    const { t } = useTranslation(['operations.themes', 'operations', 'operations.dashboard']);
    return (
        <div className="grid gap-3">
            <Table aria-label={t('operations.themes:themes.title')}>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('operations.themes:table.theme')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.sessions')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.people')}</TableHead>
                        <TableHead className="text-right">{t('operations.dashboard:intents.abandoned')}</TableHead>
                        <TableHead>{t('operations.themes:table.mostly')}</TableHead>
                        <TableHead>{t('operations.themes:table.hint')}</TableHead>
                        <TableHead className="w-32">{t('operations.dashboard:intents.outcomes')}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => {
                        const hinted = row.hints.resolved + row.hints.unresolved;
                        return (
                            <TableRow key={row.key} data-slot="ops-theme">
                                <TableCell className="max-w-64 font-medium break-words whitespace-normal">
                                    {row.topic}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.sessions)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.people)}</TableCell>
                                <TableCell className="text-right tabular-nums">
                                    {formatShare(row.sessions ? row.abandoned / row.sessions : null)}
                                </TableCell>
                                <TableCell>
                                    {row.intents[0]?.intent
                                        ? intentName(row.intents[0].intent)
                                        : t('operations.dashboard:intents.none')}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                    {hinted
                                        ? t('operations.themes:table.unresolved', {
                                              share: formatShare(row.hints.unresolved / hinted),
                                          })
                                        : t('operations.themes:outcome.unclear')}
                                </TableCell>
                                <TableCell>
                                    <OutcomeBar row={row} />
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
            <OutcomeLegend />
        </div>
    );
}

/**
 * The review (CB-199): sessions the model labeled, newest first; open
 * one to see what the model read and set its intent and topics. Each
 * admin's label is in force at once and joins the use's golden set.
 */
function ReviewCard({ timeZone }: { timeZone: string }) {
    const { t } = useTranslation(['operations.themes']);
    const [use, setUse] = useState<'intent' | 'themes'>('intent');
    const [unreviewed, setUnreviewed] = useState(true);
    return (
        <Card data-slot="ops-session-review" className="gap-4">
            <CardHeader>
                <CardTitle>{t('operations.themes:review.title')}</CardTitle>
                <CardDescription>{t('operations.themes:review.description')}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <Select value={use} onValueChange={(value) => setUse(value as 'intent' | 'themes')}>
                        <SelectTrigger size="sm" aria-label={t('operations.themes:review.labels')} className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="intent">{t('operations.themes:review.intent')}</SelectItem>
                            <SelectItem value="themes">{t('operations.themes:review.themes')}</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select
                        value={unreviewed ? 'unreviewed' : 'all'}
                        onValueChange={(value) => setUnreviewed(value === 'unreviewed')}
                    >
                        <SelectTrigger size="sm" aria-label={t('operations.themes:review.which')} className="w-48">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="unreviewed">{t('operations.themes:review.unreviewed')}</SelectItem>
                            <SelectItem value="all">{t('operations.themes:review.all')}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <ReviewList use={use} unreviewed={unreviewed} timeZone={timeZone} />
            </CardContent>
        </Card>
    );
}

function ReviewList({
    use,
    unreviewed,
    timeZone,
}: {
    use: 'intent' | 'themes';
    unreviewed: boolean;
    timeZone: string;
}) {
    const { t } = useTranslation(['operations.themes']);
    const list = useCursorList<SessionLabelRow>(
        `/classify/sessions?use=${use}${unreviewed ? '&unreviewed=1' : ''}&via=themes`,
        { limit: 20 },
    );
    return (
        <InfiniteList
            list={list}
            label={t('operations.themes:review.list')}
            itemKey={(row) => row.runId}
            empty={unreviewed ? t('operations.themes:review.empty-unreviewed') : t('operations.themes:review.empty')}
            renderItem={(row) => <ReviewItem row={row} use={use} timeZone={timeZone} />}
        />
    );
}

function ReviewItem({ row, use, timeZone }: { row: SessionLabelRow; use: 'intent' | 'themes'; timeZone: string }) {
    const { t } = useTranslation(['operations.themes', 'operations', 'operations.dashboard']);
    const [open, setOpen] = useState(false);
    const Icon = open ? ChevronDown : ChevronRight;
    const intent = row.intent.label ?? row.intent.suggestion;
    const themes = row.themes.label ?? row.themes.suggestion;
    const reviewed = use === 'intent' ? row.intent.label?.source === 'admin' : row.themes.label?.source === 'admin';
    return (
        <div data-slot="ops-review-item" className="grid gap-2 py-2">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className="flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md text-left text-sm hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">
                    {use === 'intent'
                        ? intent
                            ? intentName(intent.value)
                            : t('operations.dashboard:intents.none')
                        : themes
                          ? themes.topics.join(' · ')
                          : t('operations.themes:review.no-topics')}
                </span>
                {reviewed ? (
                    <Badge variant="secondary">{t('operations.themes:review.reviewed')}</Badge>
                ) : (
                    (use === 'intent' ? row.intent.suggestion : row.themes.suggestion) && (
                        <span className="text-xs text-muted-foreground">
                            {t('operations.themes:sure', {
                                confidence:
                                    (use === 'intent' ? row.intent.suggestion : row.themes.suggestion)?.confidence ?? 0,
                            })}
                        </span>
                    )
                )}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {formatWhen(row.startedAt, timeZone)}
                </span>
            </button>
            {open && (
                <div className="rounded-lg border bg-muted/30 p-3">
                    <SessionLabelPanel runId={row.runId} timeZone={timeZone} />
                </div>
            )}
        </div>
    );
}
