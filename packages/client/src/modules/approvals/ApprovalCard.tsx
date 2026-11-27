import { Bot, Check, ShieldCheck, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import { autoReasonLine, type ApprovalView } from '@socio/shared/approvals';
import { carryingOn, mustOpenFirst } from '@socio/shared/approvals-view';
import { dateTimeFormat } from '@socio/shared/locale';

import { onDemand } from '../../i18n/on-demand';
import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { openAppPath } from '../pages/page-navigation';
import { SocioAccessCardBody, useAllowLabel } from '../settings/SocioAccessCard';

import { useReportApproval, type ApprovalRegistry } from './ApprovalBar';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const date = (value: number) => dateTimeFormat().format(value);

/** An approval request's state, with approve and deny. */
export function useApproval(id: string, initial?: ApprovalView) {
    const { t } = useTranslation(['approvals.card']);
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
                .catch((e) => setError(e instanceof Error ? e.message : t('approvals.card:card.load-failed'))),
        [id, t],
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
            setError(e instanceof Error ? e.message : t('approvals.card:card.save-failed'));
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
export function useDecidedLine() {
    const { t } = useTranslation(['approvals.card']);
    return (view: ApprovalView) => {
        if (view.decidedVia === 'auto') {
            return t('approvals.card:decided.auto');
        }
        if (view.status === 'expired') {
            return t('approvals.card:decided.expired');
        }
        const context = view.status === 'denied' ? 'denied' : undefined;
        const continuation = view.continuation;
        if (!continuation) {
            return t('approvals.card:decided.plain', { context });
        }
        const others = continuation.waitingFor;
        switch (continuation.status) {
            case 'waiting':
                return others
                    ? t('approvals.card:decided.waiting', { context, count: others })
                    : t('approvals.card:decided.running', { context });
            case 'running':
                return t('approvals.card:decided.running', { context });
            case 'done':
                return t('approvals.card:decided.done', { context });
            case 'failed':
                return t('approvals.card:decided.failed', {
                    context,
                    detail: continuation.detail ?? t('approvals.card:decided.turn-failed'),
                });
            case 'skipped':
                return t('approvals.card:decided.skipped', {
                    context,
                    detail: continuation.detail ?? t('approvals.card:decided.not-carried-on'),
                });
        }
    };
}

/** The status badge's text: decided by bypass or auto review shows how. */
export function useStatusLabel() {
    const { t } = useTranslation(['approvals.card']);
    return (view: ApprovalView) => {
        if (view.auto?.undoneAt) {
            return t('approvals.card:status.undone');
        }
        if (view.decidedVia === 'bypass' && view.status === 'approved') {
            return t('approvals.card:status.bypass');
        }
        if (view.decidedVia === 'auto') {
            return t('approvals.card:status.auto', { status: t(`approvals.card:status.${view.status}`) });
        }
        return t(`approvals.card:status.${view.status}`);
    };
}

/**
 * What the auto review said: its decision and reason, or why it passed
 * the request to the user, with the model it ran on.
 */
export function AutoReview({ view }: { view: ApprovalView }) {
    const { t } = useTranslation(['approvals.card']);
    const auto = view.auto;
    if (!auto) {
        return null;
    }
    const lead =
        auto.verdict === 'escalated'
            ? t('approvals.card:auto.escalated')
            : auto.verdict === 'approved'
              ? t('approvals.card:auto.approved')
              : t('approvals.card:auto.denied');
    const backend = auto.backend === 'shared' ? 'shared' : auto.backend ? 'own' : undefined;
    const model = auto.model
        ? auto.latencyMs != null
            ? t('approvals.card:auto.model-time', {
                  model: auto.model,
                  seconds: auto.latencyMs / 1000,
                  context: backend,
              })
            : t('approvals.card:auto.model', { model: auto.model, context: backend })
        : '';
    const undo = auto.undoOutcome
        ? auto.undoneAt
            ? t('approvals.card:auto.undone', { outcome: auto.undoOutcome })
            : t('approvals.card:auto.undo-failed', { outcome: auto.undoOutcome })
        : '';
    return (
        <div
            className="grid gap-0.5 rounded-md border border-dashed px-2 py-1.5 text-xs"
            data-slot="auto-review"
            data-verdict={auto.verdict}
        >
            <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="gap-1">
                    <Bot className="size-3" /> {t('approvals.card:auto.badge')}
                </Badge>
                <span className="font-medium">{lead}</span>
                <span>{autoReasonLine(auto)}</span>
            </span>
            {(auto.model || auto.undoOutcome) && (
                <span className="text-muted-foreground">
                    {model}
                    {model && undo ? ' ' : ''}
                    {undo}
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
export const ApprovalCard = onDemand(['approvals.card'], WordedApprovalCard);

function WordedApprovalCard({
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
    const { t } = useTranslation(['approvals.card']);
    const allowLabel = useAllowLabel();
    const decidedLine = useDecidedLine();
    const statusLabel = useStatusLabel();
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
            aria-label={t('approvals.card:card.label')}
            data-slot="approval-card"
            data-status={view?.status ?? 'loading'}
        >
            <header className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="size-4 text-amber-600 dark:text-amber-400" />
                <strong className="text-sm">
                    {view
                        ? t('approvals.card:card.asks', { socio: view.dotName, capability: view.capabilityLabel })
                        : t('approvals.card:card.label')}
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
                            <Check /> {allowLabel(view.card) ?? t('approvals.card:card.approve')}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void decide('deny').then(onDecided)}
                        >
                            <X /> {t('approvals.card:card.deny')}
                        </Button>
                    </>
                )}
                {view?.auto?.undoable && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void undo().then(onDecided)}>
                        <Undo2 /> {t('approvals.card:card.undo')}
                    </Button>
                )}
                <small className="min-w-0 text-xs text-muted-foreground">
                    {open && mustOpenFirst(view) && <span id={waitHint}>{t('approvals.card:card.open-first')} </span>}
                    {open ? (
                        <Trans
                            t={t}
                            i18nKey="approvals.card:card.until"
                            components={{ expires: <LocalTime value={view.expiresAt} format={date} /> }}
                        />
                    ) : view ? (
                        decidedLine(view)
                    ) : (
                        t('approvals.card:card.loading')
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
                        {t('approvals.card:card.open')}
                    </a>
                )}
            </footer>
        </section>
    );
}
