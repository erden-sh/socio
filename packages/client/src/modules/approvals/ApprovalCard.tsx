import { Bot, Check, ShieldCheck, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { autoReasonLine, type ApprovalStatus, type ApprovalView } from '@socio/shared/approvals';
import { carryingOn, mustOpenFirst } from '@socio/shared/approvals-view';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { openAppPath } from '../pages/page-navigation';
import { SocioAccessCardBody, useAllowLabel } from '../settings/SocioAccessCard';

import { useReportApproval, type ApprovalRegistry } from './ApprovalBar';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const date = (value: number) => new Date(value).toLocaleDateString();
const STATUS: Record<ApprovalStatus, string> = {
    pending: 'Waiting for you',
    approved: 'Approved',
    denied: 'Denied',
    expired: 'Expired',
    failed: 'Failed',
};

/** An approval request's state, with approve and deny. */
export function useApproval(id: string, initial?: ApprovalView) {
    const [view, setView] = useState<ApprovalView | undefined>(initial);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const load = useCallback(
        () =>
            api<ApprovalView>(`/approvals/${encodeURIComponent(id)}`)
                .then((next) => {
                    setView(next);
                    setError('');
                })
                .catch((e) => setError(e instanceof Error ? e.message : 'Could not load this request.')),
        [id],
    );
    useEffect(() => {
        if (!initial) {
            void load();
        }
    }, [load, initial]);
    // The request's page: a revalidated loader (a sign-in, the same link
    // again) brings a newer copy. Notes and returns reach `load` below.
    useLoaderSeed(initial, setView);
    // Decided in another tab (the Approvals page, another chat).
    useLiveTopic(`approval:${id}`, load);
    // A request can be decided elsewhere (the Approvals page, another tab),
    // and the Dot carries on after a decision (CB-58): followed more closely.
    const carrying = carryingOn(view);
    useEffect(() => {
        if (view?.status !== 'pending' && !carrying) {
            return;
        }
        const soon = carrying && !view?.continuation?.waitingFor;
        const timer = setInterval(() => void load(), soon ? 2000 : 5000);
        return () => clearInterval(timer);
    }, [view?.status, carrying, view?.continuation?.waitingFor, load]);
    const send = async (path: string, body?: unknown) => {
        if (pending.current) {
            return;
        }
        pending.current = true;
        setBusy(true);
        setError('');
        try {
            setView(await api<ApprovalView>(`/approvals/${encodeURIComponent(id)}/${path}`, 'POST', body));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save the decision.');
            void load();
        } finally {
            pending.current = false;
            setBusy(false);
        }
    };
    const decide = (decision: 'approve' | 'deny') => send('decision', { decision });
    /** Reverses an automatic approval, where its capability can. */
    const undo = () => send('undo');
    return { view, error, busy, decide, undo, reload: load };
}

/**
 * The card's line once decided: how the Dot carries on after the user's
 * decision (CB-58), or how it was decided otherwise.
 */
export function decidedLine(view: ApprovalView) {
    if (view.decidedVia === 'auto') {
        return 'Decided by auto review in your place.';
    }
    if (view.status === 'expired') {
        return 'Expired without a decision.';
    }
    const verb = view.status === 'denied' ? 'Denied' : 'Approved';
    const continuation = view.continuation;
    if (!continuation) {
        return `${verb}.`;
    }
    const others = continuation.waitingFor;
    switch (continuation.status) {
        case 'waiting':
            return others
                ? `${verb}. The socio carries on once you decide ${others === 1 ? 'the other request' : `the other ${others} requests`} from this turn.`
                : `${verb}. The socio is carrying on…`;
        case 'running':
            return `${verb}. The socio is carrying on…`;
        case 'done':
            return `${verb}. The socio carried on in the conversation.`;
        case 'failed':
            return `${verb}. The socio could not carry on: ${continuation.detail ?? 'the turn failed.'}`;
        case 'skipped':
            return `${verb}. ${continuation.detail ?? 'The socio did not carry on.'}`;
    }
}

/** The status badge's text: decided by bypass or auto review shows how. */
export function statusLabel(view: ApprovalView) {
    if (view.auto?.undoneAt) {
        return 'Undone';
    }
    if (view.decidedVia === 'bypass' && view.status === 'approved') {
        return 'Approved (bypass)';
    }
    if (view.decidedVia === 'auto') {
        return `${STATUS[view.status]} (auto)`;
    }
    return STATUS[view.status];
}

/**
 * What the auto review said: its decision and reason, or why it passed
 * the request to the user, with the model it ran on.
 */
export function AutoReview({ view }: { view: ApprovalView }) {
    const auto = view.auto;
    if (!auto) {
        return null;
    }
    const lead =
        auto.verdict === 'escalated'
            ? 'Auto review passed this to you'
            : auto.verdict === 'approved'
              ? 'Approved by auto review'
              : 'Denied by auto review';
    return (
        <div
            className="grid gap-0.5 rounded-md border border-dashed px-2 py-1.5 text-xs"
            data-slot="auto-review"
            data-verdict={auto.verdict}
        >
            <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="gap-1">
                    <Bot className="size-3" /> Auto
                </Badge>
                <span className="font-medium">{lead}:</span>
                <span>{autoReasonLine(auto)}</span>
            </span>
            {(auto.model || auto.undoOutcome) && (
                <span className="text-muted-foreground">
                    {auto.model
                        ? `Model ${auto.model}${auto.backend === 'shared' ? ' (default backend)' : auto.backend ? ' (your connection)' : ''}${auto.latencyMs != null ? `, ${(auto.latencyMs / 1000).toFixed(1)} s` : ''}.`
                        : ''}
                    {auto.undoOutcome ? ` ${auto.undoneAt ? 'Undone' : 'Undo failed'}: ${auto.undoOutcome}` : ''}
                </span>
            )}
        </div>
    );
}

/**
 * An approval request a Dot made: in the chat (the tool result that waits
 * for approval), on the Approvals page and on `/approvals/<id>`. Approving
 * runs the stored action; either decision lets the Dot carry on by itself
 * (CB-58), and a chat follows that turn through `onContinuation`, called
 * once the turn runs (or ran) after a decision this card saw being made.
 */
export function ApprovalCard({
    id,
    initial,
    linkToPage = false,
    onDecided,
    onContinuation,
    registry,
}: {
    id: string;
    initial?: ApprovalView;
    linkToPage?: boolean;
    onDecided?: () => void;
    onContinuation?: (continuationId: string) => void;
    /** The chat's requests, for the composer's approval bar (CB-66). */
    registry?: ApprovalRegistry;
}) {
    const allowLabel = useAllowLabel();
    const { view, error, busy, decide, undo, reload } = useApproval(id, initial);
    const waitHint = useId();
    // In a chat, the composer's approval bar decides through this card (CB-66).
    useReportApproval(registry, id, view, busy, decide);
    const open = view?.status === 'pending';
    // Only a decision seen in progress here is followed: one carried on
    // before the chat opened is in its history already.
    const awaited = useRef(false);
    if (open || carryingOn(view)) {
        awaited.current = true;
    }
    const continuation = view?.continuation;
    const followable =
        continuation?.id &&
        (continuation.status === 'running' ||
            ((continuation.status === 'done' || continuation.status === 'failed') && awaited.current))
            ? continuation.id
            : undefined;
    useEffect(() => {
        if (followable) {
            onContinuation?.(followable);
        }
    }, [followable, onContinuation]);
    // One column that never grows past the card's width, and text that
    // breaks anywhere: a long URL or line of code in the details wraps
    // instead of widening the chat (CB-107).
    return (
        <section
            className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs [overflow-wrap:anywhere]"
            aria-label="Approval request"
            data-slot="approval-card"
            data-status={view?.status ?? 'loading'}
        >
            <header className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
                <strong className="text-sm">
                    {view ? `${view.dotName} asks: ${view.capabilityLabel}` : 'Approval request'}
                </strong>
                {view && (
                    <Badge
                        variant={
                            view.status === 'pending' ? 'default' : view.status === 'approved' ? 'secondary' : 'outline'
                        }
                    >
                        {statusLabel(view)}
                    </Badge>
                )}
            </header>
            {view?.card && (
                // A structured card (CB-232): facts first, their words last.
                <SocioAccessCardBody id={id} view={view} onOpened={reload} />
            )}
            {view && view.card && view.outcome && (
                <p className={view.status === 'failed' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                    {view.outcome}
                </p>
            )}
            {view && !view.card && (
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                    <p>{view.summary}.</p>
                    {view.details.map((line, index) => (
                        <p key={index} className="whitespace-pre-wrap text-muted-foreground">
                            {line}
                        </p>
                    ))}
                    {view.outcome && (
                        <p className={view.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                            {view.outcome}
                        </p>
                    )}
                    <AutoReview view={view} />
                </div>
            )}
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <footer className="flex min-w-0 flex-wrap items-center gap-2">
                {open && (
                    <>
                        <Button
                            size="sm"
                            disabled={busy || mustOpenFirst(view)}
                            aria-describedby={mustOpenFirst(view) ? waitHint : undefined}
                            onClick={() => void decide('approve').then(onDecided)}
                        >
                            <Check /> {allowLabel(view.card) ?? 'Approve'}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void decide('deny').then(onDecided)}
                        >
                            <X /> Deny
                        </Button>
                    </>
                )}
                {view?.auto?.undoable && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void undo().then(onDecided)}>
                        <Undo2 /> Undo
                    </Button>
                )}
                <small className="min-w-0 text-xs text-muted-foreground">
                    {open && mustOpenFirst(view) && <span id={waitHint}>Show all parameters to allow this. </span>}
                    {open ? (
                        <>
                            Nothing happens until you decide. Expires <LocalTime value={view.expiresAt} format={date} />
                            .
                        </>
                    ) : view ? (
                        decidedLine(view)
                    ) : (
                        'Loading…'
                    )}
                </small>
                {linkToPage && (
                    // App chrome, not chat Markdown: AppLink only takes the paths a
                    // model may link (pages, issues, chats), so this links directly.
                    <a
                        className="ml-auto text-xs underline"
                        href={`/approvals/${encodeURIComponent(id)}`}
                        onClick={(event) => {
                            if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                            ) {
                                return;
                            }
                            event.preventDefault();
                            openAppPath(`/approvals/${encodeURIComponent(id)}`);
                        }}
                    >
                        Open in Approvals
                    </a>
                )}
            </footer>
        </section>
    );
}
