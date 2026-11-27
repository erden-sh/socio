import { Bot, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    AUTO_GUIDANCE_MAX,
    type ApprovalPolicy,
    type ApprovalView,
    type ApprovalsState,
} from '@socio/shared/approvals';
import { dateTimeFormat } from '@socio/shared/locale';
import { MODULE_IDS } from '@socio/shared/modules';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { ApprovalCard, AutoReview, useStatusLabel } from './ApprovalCard';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

/** The audit's events this client words (`audit.events.<event>`); another reads as stored. */
const EVENTS = [
    'requested',
    'approved',
    'denied',
    'expired',
    'bypassed',
    'executed',
    'failed',
    'policy_changed',
    'auto_approved',
    'auto_denied',
    'auto_escalated',
    'undone',
    'undo_failed',
    'guidance_changed',
] as const;
const isEvent = (event: string): event is (typeof EVENTS)[number] => (EVENTS as readonly string[]).includes(event);

/** The Recent decisions filter (`recent.filters.<filter>`). */
type DecisionFilter = 'all' | 'auto' | 'user' | 'bypass';
const FILTERS: readonly DecisionFilter[] = ['all', 'auto', 'user', 'bypass'];
const dateTime = (value: number) =>
    dateTimeFormat({
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
    }).format(value);
const SELECT =
    'h-9 min-w-0 max-w-full shrink-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs dark:bg-input/30';

/**
 * `/approvals`: the signed-in user's approvals. What their Dots are waiting
 * for, the approval policy per Dot and capability (`?dot=` preselects a
 * Dot), their guidance for auto reviews, recent decisions (filterable to
 * auto reviews, which they can undo where the capability allows) and the
 * audit. Each user has their own; nobody else, admins included, sees or
 * decides them.
 */
export function ApprovalsPage({
    initial,
}: {
    /** The page's loader data: shown at once, with no second read. */
    initial?: ApprovalsState;
} = {}) {
    const { t } = useTranslation(['approvals', 'approvals.card']);
    const statusLabel = useStatusLabel();
    const shell = useShell();
    const [params, setParams] = useSearchParams();
    const [state, setState] = useState<ApprovalsState | undefined>(initial);
    const seeded = useRef(!!initial);
    useLoaderSeed(initial, setState);
    const [filter, setFilter] = useState<DecisionFilter>('all');
    const [guidance, setGuidance] = useState<string>();
    const [savingGuidance, setSavingGuidance] = useState(false);
    const load = useCallback(
        () =>
            api<ApprovalsState>(filter === 'auto' ? '/approvals?review=auto' : '/approvals')
                .then(setState)
                .catch((e) => toast.error(e instanceof Error ? e.message : t('approvals:errors.load'))),
        [filter, t],
    );
    // Decided, undone or set in another tab.
    useLiveTopic('approvals', load);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void load();
    }, [load]);
    const dots = shell.workspace.dots;
    const dotId = params.get('dot') ?? dots[0]?.id ?? '';
    const dotName = (id: string) => dots.find((dot) => dot.id === id)?.name ?? t('approvals:deleted-socio');
    const policyOf = (capability: string): ApprovalPolicy =>
        state?.policies.find((entry) => entry.dotId === dotId && entry.capability === capability)?.policy ?? 'manual';
    const setPolicy = async (capability: string, policy: ApprovalPolicy) => {
        try {
            await api('/approvals/policies', 'PUT', { dotId, capability, policy });
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('approvals:errors.policy'));
        }
    };
    const autoOn = state?.capabilities.filter((capability) => policyOf(capability.id) === 'auto') ?? [];
    const turnOffAuto = async () => {
        try {
            for (const capability of autoOn) {
                await api('/approvals/policies', 'PUT', {
                    dotId,
                    capability: capability.id,
                    policy: 'manual',
                });
            }
            toast.success(t('approvals:toasts.auto-off'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('approvals:errors.auto-off'));
        }
        await load();
    };
    const savedGuidance = state?.guidance ?? '';
    const guidanceText = guidance ?? savedGuidance;
    const saveGuidance = async () => {
        setSavingGuidance(true);
        try {
            await api('/approvals/guidance', 'PUT', { guidance: guidanceText });
            setGuidance(undefined);
            await load();
            toast.success(t('approvals:toasts.guidance'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('approvals:errors.guidance'));
        } finally {
            setSavingGuidance(false);
        }
    };
    const undo = async (item: ApprovalView) => {
        try {
            await api(`/approvals/${encodeURIComponent(item.id)}/undo`, 'POST');
            toast.success(t('approvals:toasts.undone'));
        } catch (e) {
            toast.error(e instanceof Error ? e.message : t('approvals:errors.undo'));
        }
        await load();
    };
    const recent =
        state?.recent.filter((item) =>
            filter === 'auto' ? !!item.auto : filter === 'all' ? true : item.decidedVia === filter,
        ) ?? [];
    return (
        <WorkspacePage
            slot="approvals-page"
            module={MODULE_IDS.approvals}
            title={t('approvals:title')}
            description={t('approvals:description')}
        >
            {!state ? (
                <Skeleton className="h-40" />
            ) : (
                // One column no wider than the page: the guidance box sizes to its
                // placeholder, which pushed the page past a phone screen (CB-96).
                <div className="grid grid-cols-1 gap-6">
                    <Card data-tour="approval-requests">
                        <CardHeader>
                            <CardTitle>{t('approvals:waiting.title')}</CardTitle>
                            <CardDescription>
                                {state.pending.length
                                    ? t('approvals:waiting.count', { count: state.pending.length })
                                    : t('approvals:waiting.none')}
                            </CardDescription>
                        </CardHeader>
                        {!!state.pending.length && (
                            <CardContent className="grid gap-3">
                                {state.pending.map((item) => (
                                    <ApprovalCard
                                        key={item.id}
                                        id={item.id}
                                        initial={item}
                                        onDecided={() => void load()}
                                    />
                                ))}
                            </CardContent>
                        )}
                    </Card>
                    <Card data-slot="approval-policies">
                        <CardHeader>
                            <CardTitle>{t('approvals:policies.title')}</CardTitle>
                            <CardDescription>{t('approvals:policies.description')}</CardDescription>
                        </CardHeader>
                        <CardContent className="grid min-w-0 grid-cols-1 gap-4">
                            <label className="grid min-w-0 w-full max-w-xs grid-cols-1 gap-1 text-sm">
                                {t('approvals:policies.socio')}
                                <select
                                    data-slot="approval-dot"
                                    className={`${SELECT} w-full`}
                                    value={dotId}
                                    onChange={(event) => setParams({ dot: event.target.value }, { replace: true })}
                                >
                                    {dots.map((dot) => (
                                        <option key={dot.id} value={dot.id}>
                                            {dot.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {!!autoOn.length && (
                                <div
                                    role="status"
                                    data-slot="auto-banner"
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                                >
                                    <span className="flex items-start gap-2">
                                        <Bot className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                                        <span>
                                            {t('approvals:policies.auto-on', {
                                                socio: dotName(dotId),
                                                capabilities: autoOn.map((capability) => capability.label),
                                            })}
                                        </span>
                                    </span>
                                    <Button size="sm" variant="outline" onClick={() => void turnOffAuto()}>
                                        {t('approvals:policies.turn-off')}
                                    </Button>
                                </div>
                            )}
                            <div className="grid min-w-0 grid-cols-1 gap-3">
                                {state.capabilities.map((capability) => {
                                    const policy = capability.manualOnly ? 'manual' : policyOf(capability.id);
                                    const auto = capability.auto;
                                    return (
                                        <div
                                            key={capability.id}
                                            className="flex min-w-0 flex-col items-start gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:justify-between sm:gap-4"
                                            data-capability={capability.id}
                                            data-policy={policy}
                                        >
                                            <div className="grid min-w-0 grid-cols-1 gap-1">
                                                <span className="font-medium">
                                                    {capability.label}{' '}
                                                    <Badge
                                                        variant={
                                                            policy === 'bypass'
                                                                ? 'destructive'
                                                                : policy === 'auto'
                                                                  ? 'default'
                                                                  : 'secondary'
                                                        }
                                                    >
                                                        {t(`approvals:policies.policy.${policy}`)}
                                                    </Badge>
                                                </span>
                                                <span className="text-muted-foreground">{capability.description}</span>
                                                {policy === 'auto' && auto && (
                                                    <span
                                                        className="text-xs text-muted-foreground"
                                                        data-slot="auto-limits"
                                                    >
                                                        {t('approvals:policies.limits', {
                                                            risk: t(`approvals:policies.risk.${auto.maxRisk}`),
                                                        })}
                                                        {auto.rules.length
                                                            ? ` ${t('approvals:policies.always', { rules: auto.rules.join('; ') })}`
                                                            : ''}{' '}
                                                        {auto.undo
                                                            ? t('approvals:policies.undo')
                                                            : t('approvals:policies.no-undo')}
                                                    </span>
                                                )}
                                            </div>
                                            <select
                                                data-slot="approval-policy"
                                                aria-label={t('approvals:policies.select', {
                                                    capability: capability.label,
                                                })}
                                                className={SELECT}
                                                value={policy}
                                                disabled={!dotId || capability.manualOnly}
                                                onChange={(event) =>
                                                    void setPolicy(capability.id, event.target.value as ApprovalPolicy)
                                                }
                                            >
                                                <option value="manual">{t('approvals:policies.policy.manual')}</option>
                                                <option value="auto" disabled={auto ? !auto.allowed : false}>
                                                    {auto && !auto.allowed
                                                        ? t('approvals:policies.auto-unavailable')
                                                        : t('approvals:policies.policy.auto')}
                                                </option>
                                                <option value="bypass" disabled={capability.manualOnly}>
                                                    {t('approvals:policies.policy.bypass')}
                                                </option>
                                            </select>
                                        </div>
                                    );
                                })}
                            </div>
                        </CardContent>
                    </Card>
                    <Card data-slot="auto-guidance">
                        <CardHeader>
                            <CardTitle>{t('approvals:guidance.title')}</CardTitle>
                            <CardDescription>{t('approvals:guidance.description')}</CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-2">
                            <Textarea
                                aria-label={t('approvals:guidance.label')}
                                value={guidanceText}
                                maxLength={AUTO_GUIDANCE_MAX}
                                rows={3}
                                onChange={(event) => setGuidance(event.target.value)}
                            />
                            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    {t('approvals:guidance.length', {
                                        length: guidanceText.length,
                                        max: AUTO_GUIDANCE_MAX,
                                    })}
                                </span>
                                <Button
                                    size="sm"
                                    disabled={savingGuidance || guidanceText === savedGuidance}
                                    onClick={() => void saveGuidance()}
                                >
                                    {t('approvals:guidance.save')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                    <Card data-slot="approval-recent">
                        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle>{t('approvals:recent.title')}</CardTitle>
                            <select
                                data-slot="approval-filter"
                                aria-label={t('approvals:recent.filter')}
                                className={SELECT}
                                value={filter}
                                onChange={(event) => setFilter(event.target.value as DecisionFilter)}
                            >
                                {FILTERS.map((value) => (
                                    <option key={value} value={value}>
                                        {t(`approvals:recent.filters.${value}`)}
                                    </option>
                                ))}
                            </select>
                        </CardHeader>
                        <CardContent>
                            {!recent.length ? (
                                <p className="text-sm text-muted-foreground">{t('approvals:recent.none')}</p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('approvals:recent.asked')}</TableHead>
                                            <TableHead>{t('approvals:recent.socio')}</TableHead>
                                            <TableHead>{t('approvals:recent.request')}</TableHead>
                                            <TableHead>{t('approvals:recent.status')}</TableHead>
                                            <TableHead>{t('approvals:recent.outcome')}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {recent.map((item) => (
                                            <TableRow key={item.id} data-request={item.id}>
                                                <TableCell className="whitespace-nowrap">
                                                    <LocalTime value={item.createdAt} format={dateTime} />
                                                </TableCell>
                                                <TableCell>{item.dotName}</TableCell>
                                                <TableCell className="max-w-96 whitespace-normal">
                                                    <span className="line-clamp-2">{item.summary}</span>
                                                    <AutoReview view={item} />
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{statusLabel(item)}</Badge>
                                                </TableCell>
                                                <TableCell className="max-w-80 whitespace-normal text-muted-foreground">
                                                    <span className="line-clamp-2">{item.outcome}</span>
                                                    {item.auto?.undoable && (
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="mt-1"
                                                            onClick={() => void undo(item)}
                                                        >
                                                            <Undo2 /> {t('approvals:recent.undo')}
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('approvals:audit.title')}</CardTitle>
                            <CardDescription>{t('approvals:audit.description')}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Table data-slot="approval-audit">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('approvals:audit.when')}</TableHead>
                                        <TableHead>{t('approvals:audit.socio')}</TableHead>
                                        <TableHead>{t('approvals:audit.capability')}</TableHead>
                                        <TableHead>{t('approvals:audit.event')}</TableHead>
                                        <TableHead>{t('approvals:audit.detail')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {state.audit.map((entry) => (
                                        <TableRow key={entry.id}>
                                            <TableCell className="whitespace-nowrap">
                                                <LocalTime value={entry.createdAt} format={dateTime} />
                                            </TableCell>
                                            <TableCell>{entry.dotId ? dotName(entry.dotId) : '—'}</TableCell>
                                            <TableCell>
                                                {state.capabilities.find(
                                                    (capability) => capability.id === entry.capability,
                                                )?.label ??
                                                    (entry.capability || '—')}
                                            </TableCell>
                                            <TableCell>
                                                {isEvent(entry.event)
                                                    ? t(`approvals:audit.events.${entry.event}`)
                                                    : entry.event}
                                            </TableCell>
                                            <TableCell className="max-w-80 truncate text-muted-foreground">
                                                {entry.detail}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>
            )}
        </WorkspacePage>
    );
}
