import { Bot, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import {
    AUTO_GUIDANCE_MAX,
    type ApprovalPolicy,
    type ApprovalView,
    type ApprovalsState,
} from '@socio/shared/approvals';
import { MODULE_IDS } from '@socio/shared/modules';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { ApprovalCard, AutoReview, statusLabel } from './ApprovalCard';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const EVENT: Record<string, string> = {
    requested: 'Asked',
    approved: 'Approved by you',
    denied: 'Denied by you',
    expired: 'Expired',
    bypassed: 'Approved by bypass',
    executed: 'Done',
    failed: 'Failed',
    policy_changed: 'Policy changed',
    auto_approved: 'Approved by auto review',
    auto_denied: 'Denied by auto review',
    auto_escalated: 'Passed to you by auto review',
    undone: 'Undone by you',
    undo_failed: 'Undo failed',
    guidance_changed: 'Auto guidance changed',
};

const POLICY_LABEL: Record<ApprovalPolicy, string> = {
    manual: 'Manual',
    auto: 'Auto',
    bypass: 'Bypass',
};

/** The Recent decisions filter. */
type DecisionFilter = 'all' | 'auto' | 'user' | 'bypass';
const FILTERS: Array<[DecisionFilter, string]> = [
    ['all', 'All decisions'],
    ['auto', 'Auto reviews'],
    ['user', 'Decided by you'],
    ['bypass', 'Bypass'],
];
const dateTime = (value: number) => new Date(value).toLocaleString();
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
                .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load approvals.')),
        [filter],
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
    const dotName = (id: string) => dots.find((dot) => dot.id === id)?.name ?? 'A deleted socio';
    const policyOf = (capability: string): ApprovalPolicy =>
        state?.policies.find((entry) => entry.dotId === dotId && entry.capability === capability)?.policy ?? 'manual';
    const setPolicy = async (capability: string, policy: ApprovalPolicy) => {
        try {
            await api('/approvals/policies', 'PUT', { dotId, capability, policy });
            await load();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not save the policy.');
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
            toast.success('Auto approvals are off for this socio.');
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not turn auto approvals off.');
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
            toast.success('Guidance saved.');
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not save the guidance.');
        } finally {
            setSavingGuidance(false);
        }
    };
    const undo = async (item: ApprovalView) => {
        try {
            await api(`/approvals/${encodeURIComponent(item.id)}/undo`, 'POST');
            toast.success('Undone.');
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not undo it.');
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
            title="Approvals"
            description="Actions with side effects wait for you: a new dataset, changes to a shared one, access to your data. Approve or deny them here or in the chat, or let auto review decide the routine ones. Reading and querying data a socio may use never needs approval."
        >
            {!state ? (
                <Skeleton className="h-40" />
            ) : (
                // One column no wider than the page: the guidance box sizes to its
                // placeholder, which pushed the page past a phone screen (CB-96).
                <div className="grid grid-cols-1 gap-6">
                    <Card data-tour="approval-requests">
                        <CardHeader>
                            <CardTitle>Waiting for you</CardTitle>
                            <CardDescription>
                                {state.pending.length
                                    ? `${state.pending.length} request(s). Nothing happens until you decide; requests expire after a week.`
                                    : 'Nothing is waiting.'}
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
                            <CardTitle>Policies</CardTitle>
                            <CardDescription>
                                Per socio and per capability: Manual asks you every time; Auto lets a decision model on
                                your inference decide in your place, and it passes anything unclear or above the
                                capability’s risk limit to you; Bypass lets the socio go ahead. Quotas and the audit
                                apply either way, and every change of policy is recorded.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid min-w-0 grid-cols-1 gap-4">
                            <label className="grid min-w-0 w-full max-w-xs grid-cols-1 gap-1 text-sm">
                                Socio
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
                                            Auto approvals are on for {dotName(dotId)}:{' '}
                                            {autoOn.map((capability) => capability.label).join(', ')}. A decision model
                                            decides these in your place; what it is unsure about still comes to you, and
                                            every decision is listed below with its reason.
                                        </span>
                                    </span>
                                    <Button size="sm" variant="outline" onClick={() => void turnOffAuto()}>
                                        Turn off auto
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
                                                        {POLICY_LABEL[policy]}
                                                    </Badge>
                                                </span>
                                                <span className="text-muted-foreground">{capability.description}</span>
                                                {policy === 'auto' && auto && (
                                                    <span
                                                        className="text-xs text-muted-foreground"
                                                        data-slot="auto-limits"
                                                    >
                                                        Approved automatically up to {auto.maxRisk} risk; anything
                                                        riskier comes to you.
                                                        {auto.rules.length
                                                            ? ` Always to you: ${auto.rules.join('; ')}.`
                                                            : ''}
                                                        {auto.undo
                                                            ? ' You can undo automatic approvals.'
                                                            : ' Automatic approvals can’t be undone here.'}
                                                    </span>
                                                )}
                                            </div>
                                            <select
                                                data-slot="approval-policy"
                                                aria-label={`Approval policy for ${capability.label}`}
                                                className={SELECT}
                                                value={policy}
                                                disabled={!dotId || capability.manualOnly}
                                                onChange={(event) =>
                                                    void setPolicy(capability.id, event.target.value as ApprovalPolicy)
                                                }
                                            >
                                                <option value="manual">Manual</option>
                                                <option value="auto" disabled={auto ? !auto.allowed : false}>
                                                    Auto
                                                    {auto && !auto.allowed ? ' (not available)' : ''}
                                                </option>
                                                <option value="bypass" disabled={capability.manualOnly}>
                                                    Bypass
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
                            <CardTitle>Guidance for auto approvals</CardTitle>
                            <CardDescription>
                                Optional. A few lines the decision model reads with every request it decides for you,
                                e.g. “Datasets for my budget are fine; never give a socio write access to shared data.”
                                It applies to all your socios. Leave out passwords and other secrets.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-2">
                            <Textarea
                                aria-label="Guidance for auto approvals"
                                value={guidanceText}
                                maxLength={AUTO_GUIDANCE_MAX}
                                rows={3}
                                onChange={(event) => setGuidance(event.target.value)}
                            />
                            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    {guidanceText.length}/{AUTO_GUIDANCE_MAX}
                                </span>
                                <Button
                                    size="sm"
                                    disabled={savingGuidance || guidanceText === savedGuidance}
                                    onClick={() => void saveGuidance()}
                                >
                                    Save guidance
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                    <Card data-slot="approval-recent">
                        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
                            <CardTitle>Recent decisions</CardTitle>
                            <select
                                data-slot="approval-filter"
                                aria-label="Show decisions"
                                className={SELECT}
                                value={filter}
                                onChange={(event) => setFilter(event.target.value as DecisionFilter)}
                            >
                                {FILTERS.map(([value, label]) => (
                                    <option key={value} value={value}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </CardHeader>
                        <CardContent>
                            {!recent.length ? (
                                <p className="text-sm text-muted-foreground">None yet.</p>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>Asked</TableHead>
                                            <TableHead>Socio</TableHead>
                                            <TableHead>Request</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead>Outcome</TableHead>
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
                                                            <Undo2 /> Undo
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
                            <CardTitle>Audit</CardTitle>
                            <CardDescription>Every request, decision and policy change.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Table data-slot="approval-audit">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>When</TableHead>
                                        <TableHead>Socio</TableHead>
                                        <TableHead>Capability</TableHead>
                                        <TableHead>Event</TableHead>
                                        <TableHead>Detail</TableHead>
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
                                            <TableCell>{EVENT[entry.event] ?? entry.event}</TableCell>
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
