import type { ApprovalView } from './approvals.js';
import { lowerText } from './locale.js';
import type { SocioAccessCard } from './socio-access.js';

/**
 * The rules of an approval request's card and bar, shared by the web and
 * the app. Rules only: each client keeps its own words for them.
 */

/**
 * Whether Approve must wait: the details are too long
 * to show inline and the person hasn't opened them all yet. The server
 * refuses it too; this keeps the button honest.
 */
export const mustOpenFirst = (view: Pick<ApprovalView, 'review'>) => !!view.review?.mustOpen && !view.review.opened;

/**
 * Whether only the card itself can allow it: an action, access beyond
 * read, or a coding session (CB-239: repository, model, budget and push
 * are on its card only). A bar that shows a line of
 * summary, not the parameters, origin, owner, task or room, offers Deny
 * and Show request there, never Allow.
 */
export const decidedOnCard = (card: SocioAccessCard | null | undefined) =>
    !!card && (card.kind !== 'app_access' || card.access !== 'read');

/** Whether the socio is still to carry on after this decision (CB-58). */
export const carryingOn = (view?: Pick<ApprovalView, 'continuation'>) =>
    view?.continuation?.status === 'waiting' || view?.continuation?.status === 'running';

/** What a request asks, as data: the socio, and the capability's label lowered at its start. */
export interface ApprovalAsk {
    socio: string;
    capability: string;
}

/** Who asks and for what ("Ada", "create datasets"), from the capability's label. */
export function approvalAsk(view: Pick<ApprovalView, 'dotName' | 'capabilityLabel'>): ApprovalAsk {
    const label = view.capabilityLabel;
    return { socio: view.dotName, capability: `${lowerText(label.slice(0, 1))}${label.slice(1)}` };
}
