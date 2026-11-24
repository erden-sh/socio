import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { THEME_OUTCOME_LABELS, type ClassifyUseView, type SessionLabelRow } from '@socio/shared/classify';
import { formatNumber } from '@socio/shared/locale';
import { intentName, type OpsThemeRow, type OpsThemes } from '@socio/shared/operations/operations-themes';

import { SeriesChart } from '../../components/charts/SeriesChart';
import { InfiniteList } from '../../components/infinite-list/InfiniteList';
import { useCursorList } from '../../components/infinite-list/use-cursor-list';
import { api } from '../../lib/api';

import { counts, formatShare, StatusNote } from './activity-parts';
import { bucketLabel, formatWhen } from './format';
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

function UseNote({ name, view }: { name: string; view: ClassifyUseView | undefined }) {
    if (!view) {
        return null;
    }
    const text = !view.enabled
        ? `${name} labels are off, so new sessions get none. Turn them on in`
        : !view.versionPassed
          ? `${name} labels are on, but the model’s answers are suggestions until its version passes an evaluation: review sessions below, then evaluate it in`
          : null;
    if (!text) {
        return null;
    }
    return (
        <li>
            {text}{' '}
            <Link to={opsPath('settings')} className="underline">
                Settings
            </Link>
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
                    <UseNote name="Intent" view={intentUse} />
                    <UseNote name="Theme" view={themesUse} />
                </ul>
            )}
            <section
                aria-label="Totals"
                className="grid grid-cols-2 gap-3 sm:grid-cols-3"
                data-slot="ops-themes-totals"
            >
                {(
                    [
                        ['People’s sessions', facts ? formatNumber(facts.sessions) : null],
                        [
                            'With an intent',
                            facts ? formatShare(facts.sessions ? facts.withIntent / facts.sessions : null) : null,
                        ],
                        [
                            'With themes',
                            facts ? formatShare(facts.sessions ? facts.withThemes / facts.sessions : null) : null,
                        ],
                    ] as const
                ).map(([label, value]) =>
                    data ? (
                        <Card key={label} className="gap-1 px-4 py-3 shadow-xs">
                            <span className="text-xs text-muted-foreground">{label}</span>
                            <strong className="text-2xl font-semibold tabular-nums">{value ?? '–'}</strong>
                        </Card>
                    ) : (
                        <Skeleton key={label} className="h-18 rounded-xl" />
                    ),
                )}
            </section>
            <Card data-slot="ops-themes-intents" className="gap-4">
                <CardHeader>
                    <CardTitle>Intents</CardTitle>
                    <CardDescription>
                        What people came for, by session, and how those sessions ended. A session takes the intent of
                        the first labelled turn in it.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {facts?.intents.length ? (
                        <IntentTable rows={facts.intents} />
                    ) : data ? (
                        <p className="m-0 py-2 text-sm text-muted-foreground">No sessions in this range.</p>
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
    const facts = answer?.facts;
    const [chart, setChart] = useState('all');
    const theme = facts?.themes.find((row) => row.key === chart);
    const series = theme ? theme.weeks : facts?.weekSessions;
    return (
        <Card data-slot="ops-themes" className="gap-4">
            <CardHeader>
                <CardTitle>Themes</CardTitle>
                <CardDescription>
                    Topics the model named for people’s sessions, grouped when they use the same words. A theme is named
                    only when at least {facts?.minPeople ?? 3} different people had sessions on it in this range;
                    smaller ones are counted together. The hint is the model’s read of the first messages; the outcome
                    is what happened.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                {facts ? (
                    <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                                {theme ? `“${theme.topic}”` : 'Sessions with themes'} by week
                            </span>
                            <Select value={chart} onValueChange={setChart}>
                                <SelectTrigger size="sm" aria-label="Chart" className="w-56">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">Every theme</SelectItem>
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
                                label={`${theme ? theme.topic : 'Sessions with themes'} by week`}
                                xName="week"
                                yName="sessions"
                                points={facts.weeks.map((at, index) => ({
                                    label: bucketLabel(at, 'week', answer.window.timeZone),
                                    value: series[index] ?? 0,
                                }))}
                            />
                        ) : (
                            <p className="m-0 py-6 text-center text-sm text-muted-foreground">
                                No sessions with themes in this range.
                            </p>
                        )}
                        {facts.themes.length > 0 && <ThemeTable rows={facts.themes} />}
                        {(facts.hidden.themes > 0 || facts.more > 0) && (
                            <p className="m-0 text-xs text-muted-foreground" data-slot="ops-themes-hidden">
                                {facts.hidden.themes > 0 &&
                                    `${counts([facts.hidden.themes, 'smaller theme', 'smaller themes'])} not named: fewer than ${facts.minPeople} people each. `}
                                {facts.more > 0 &&
                                    `${counts([facts.more, 'more theme', 'more themes'])} past the first ${facts.themes.length}. `}
                                {facts.hidden.sessions > 0 &&
                                    `${counts([facts.hidden.sessions, 'session is', 'sessions are'])} on none of the themes shown.`}
                            </p>
                        )}
                    </>
                ) : answer ? (
                    <p className="m-0 py-2 text-sm text-muted-foreground">Analytics has no answer yet.</p>
                ) : (
                    <Skeleton className="h-60 w-full" />
                )}
            </CardContent>
        </Card>
    );
}

function ThemeTable({ rows }: { rows: OpsThemeRow[] }) {
    return (
        <div className="grid gap-3">
            <Table aria-label="Themes">
                <TableHeader>
                    <TableRow>
                        <TableHead>Theme</TableHead>
                        <TableHead className="text-right">Sessions</TableHead>
                        <TableHead className="text-right">People</TableHead>
                        <TableHead className="text-right">Abandoned</TableHead>
                        <TableHead>Mostly</TableHead>
                        <TableHead>Hint</TableHead>
                        <TableHead className="w-32">Outcomes</TableHead>
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
                                <TableCell>{intentName(row.intents[0]?.intent ?? null)}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                    {hinted
                                        ? `${formatShare(row.hints.unresolved / hinted)} ${THEME_OUTCOME_LABELS.unresolved.toLowerCase()}`
                                        : THEME_OUTCOME_LABELS.unclear}
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
    const [use, setUse] = useState<'intent' | 'themes'>('intent');
    const [unreviewed, setUnreviewed] = useState(true);
    return (
        <Card data-slot="ops-session-review" className="gap-4">
            <CardHeader>
                <CardTitle>Review</CardTitle>
                <CardDescription>
                    Sessions the model labelled. Open one to read its title and first messages, scrubbed as the model
                    got them, and set its intent or topics: yours count at once and form the golden set the model is
                    evaluated against. Opening one, and this list, is recorded in the access log.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                <div className="flex flex-wrap items-center gap-3">
                    <Select value={use} onValueChange={(value) => setUse(value as 'intent' | 'themes')}>
                        <SelectTrigger size="sm" aria-label="Labels" className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="intent">Intent</SelectItem>
                            <SelectItem value="themes">Themes</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select
                        value={unreviewed ? 'unreviewed' : 'all'}
                        onValueChange={(value) => setUnreviewed(value === 'unreviewed')}
                    >
                        <SelectTrigger size="sm" aria-label="Which sessions" className="w-48">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="unreviewed">Not reviewed yet</SelectItem>
                            <SelectItem value="all">Every labeled session</SelectItem>
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
    const list = useCursorList<SessionLabelRow>(
        `/classify/sessions?use=${use}${unreviewed ? '&unreviewed=1' : ''}&via=themes`,
        { limit: 20 },
    );
    return (
        <InfiniteList
            list={list}
            label="Sessions to review"
            itemKey={(row) => row.runId}
            empty={
                unreviewed
                    ? 'Nothing waits for review. Sessions appear here once the model has labeled them.'
                    : 'No session has a label yet.'
            }
            renderItem={(row) => <ReviewItem row={row} use={use} timeZone={timeZone} />}
        />
    );
}

function ReviewItem({ row, use, timeZone }: { row: SessionLabelRow; use: 'intent' | 'themes'; timeZone: string }) {
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
                            : 'No intent'
                        : themes
                          ? themes.topics.join(' · ')
                          : 'No topics'}
                </span>
                {reviewed ? (
                    <Badge variant="secondary">Reviewed</Badge>
                ) : (
                    (use === 'intent' ? row.intent.suggestion : row.themes.suggestion) && (
                        <span className="text-xs text-muted-foreground">
                            {Math.round(
                                ((use === 'intent' ? row.intent.suggestion : row.themes.suggestion)?.confidence ?? 0) *
                                    100,
                            )}
                            % sure
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
