import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { ApprovalView } from '@socio/shared/approvals';
import { approvalAsk, decidedOnCard, mustOpenFirst } from '@socio/shared/approvals-view';

import { onDemand } from '../../i18n/on-demand';
import { useAllowLabel } from '../settings/SocioAccessCard';

import { Button } from '@/components/ui/button';

type Decision = 'approve' | 'deny';

/** A request as its card in the transcript knows it, with the card's decide. */
export interface ReportedApproval {
    view: ApprovalView;
    busy: boolean;
    decide(decision: Decision): Promise<void>;
}

const NONE: ReportedApproval[] = [];

/**
 * The chat's approval requests, as their cards report them: the composer's
 * bar reads the pending ones from here. The cards keep polling their own
 * request (a decision elsewhere shows within seconds) and deciding through
 * the bar is the card's own decide, so the card, the bar and the Dot
 * carrying on (CB-58) stay one flow.
 */
export class ApprovalRegistry {
    private entries = new Map<string, ReportedApproval>();
    private listeners = new Set<() => void>();
    private waiting: ReportedApproval[] = NONE;
    set(id: string, entry: ReportedApproval) {
        this.entries.set(id, entry);
        this.changed();
    }
    remove(id: string) {
        if (this.entries.delete(id)) {
            this.changed();
        }
    }
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    };
    /** The pending requests, oldest first (the same array until one changes). */
    pending = () => this.waiting;
    private changed() {
        const next = [...this.entries.values()]
            .filter((entry) => entry.view.status === 'pending')
            .sort((a, b) => a.view.createdAt - b.view.createdAt);
        this.waiting = next.length ? next : NONE;
        for (const listener of this.listeners) {
            listener();
        }
    }
}

/** An approval card tells the chat's registry, if any, what it knows. */
export function useReportApproval(
    registry: ApprovalRegistry | undefined,
    id: string,
    view: ApprovalView | undefined,
    busy: boolean,
    decide: (decision: Decision) => Promise<void>,
) {
    const latest = useRef(decide);
    useEffect(() => {
        latest.current = decide;
    });
    useEffect(() => {
        if (registry && view) {
            registry.set(id, {
                view,
                busy,
                decide: (decision) => latest.current(decision),
            });
        }
    }, [registry, id, view, busy]);
    useEffect(() => () => registry?.remove(id), [registry, id]);
}

export function usePendingApprovals(registry: ApprovalRegistry) {
    return useSyncExternalStore(registry.subscribe, registry.pending, () => NONE);
}

/** "Ada asks to create datasets", from the capability's label. */
export function useAsksTo() {
    const { t } = useTranslation(['approvals.card']);
    return (view: Pick<ApprovalView, 'dotName' | 'capabilityLabel'>) => {
        const { socio, capability } = approvalAsk(view);
        return t('approvals.card:bar.asks', { socio, capability });
    };
}

/**
 * The composer's bar while a request in this chat is pending (T3 Code's
 * pending-approval panel, adapted): what is asked, Deny and Approve for
 * the oldest request, "1 of 2" when more wait, and Show request, which
 * scrolls to its card. A request decided on its card only has no
 * Approve here. The text box below stays usable throughout.
 */
export const ApprovalBar = onDemand(['approvals.card'], WordedApprovalBar);

function WordedApprovalBar({
    pending,
    onShow,
}: {
    pending: readonly ReportedApproval[];
    onShow: (id: string) => void;
}) {
    const { t } = useTranslation(['approvals.card']);
    const asksTo = useAsksTo();
    const allowLabel = useAllowLabel();
    const first = pending[0];
    if (!first) {
        return null;
    }
    const { view, busy, decide } = first;
    // Actions and access beyond read are allowed on their card only: the
    // bar shows none of what the person decides on.
    const onCard = decidedOnCard(view.card);
    return (
        <div
            className="mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b pt-1.5 pr-0.5 pb-2 pl-1 text-[13px]/[1.4] text-foreground"
            role="region"
            aria-label={t('approvals.card:bar.label')}
            data-slot="approval-bar"
            data-approval={view.id}
        >
            <ShieldCheck
                className="mt-0.5 size-4 shrink-0 self-start text-amber-600 dark:text-amber-400"
                aria-hidden="true"
            />
            <div className="min-w-0 flex-[1_1_14rem]">
                <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 leading-[1.7]">
                    <strong className="font-semibold">{asksTo(view)}</strong>
                    {pending.length > 1 && (
                        <span
                            className="rounded-full bg-muted px-[7px] text-[12px] text-muted-foreground tabular-nums"
                            data-slot="approval-count"
                        >
                            {t('approvals.card:bar.position', { total: pending.length })}
                        </span>
                    )}
                </p>
                <p className="m-0 truncate text-[12px]/[1.7] text-muted-foreground" title={view.summary}>
                    {view.summary}
                </p>
                {onCard ? (
                    <p
                        className="m-0 text-[12px]/[1.7] text-amber-700 dark:text-amber-400"
                        data-slot="approval-on-card"
                    >
                        {t('approvals.card:bar.on-card')}
                    </p>
                ) : (
                    mustOpenFirst(view) && (
                        <p
                            className="m-0 text-[12px]/[1.7] text-amber-700 dark:text-amber-400"
                            data-slot="approval-open-first"
                        >
                            {t('approvals.card:bar.open-first')}
                        </p>
                    )
                )}
            </div>
            <div className="ml-auto flex items-center gap-1.5">
                <Button type="button" variant="link" size="sm" className="px-1" onClick={() => onShow(view.id)}>
                    {t('approvals.card:bar.show')}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void decide('deny')}>
                    {t('approvals.card:card.deny')}
                </Button>
                {!onCard && (
                    <Button
                        type="button"
                        size="sm"
                        // Long parameters are opened on the card first (CB-232).
                        disabled={busy || mustOpenFirst(view)}
                        onClick={() => void decide('approve')}
                    >
                        {allowLabel(view.card) ?? t('approvals.card:card.approve')}
                    </Button>
                )}
            </div>
        </div>
    );
}

/** How long a card stays highlighted after Show request. */
export const HIGHLIGHT_MS = 1_600;

/**
 * Show request: scrolls the request's card into view, focuses it (keyboard
 * and screen-reader users land there too) and highlights it for a moment.
 */
export function showApprovalCard(id: string) {
    const card = document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(id)}"]`);
    if (!card) {
        return;
    }
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
    card.focus({ preventScroll: true });
    card.dataset.highlight = 'true';
    window.setTimeout(() => delete card.dataset.highlight, HIGHLIGHT_MS);
}
