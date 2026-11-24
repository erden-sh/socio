import { approvalButtons } from '@socio/foundation/telegram/buttons';
import { autoReasonLine, type ApprovalView } from '@socio/shared/approvals';

import type { ApprovalNoticeSources, NoticeConversationKind } from './sources.js';

/** The most of a request's details a notice shows; the app has them all. */
const DETAILS_MAX = 1500;

/**
 * The direct message a Telegram user gets for an approval their Dot asked
 * for, decided with its Approve and Deny buttons (CB-145) or in the app;
 * its details (a goal's instructions, CB-131) as the card shows them, and
 * an auto review that passed it to them adds its reason, which never
 * holds email addresses or secrets.
 */
export function approvalNotice(
    view: Pick<ApprovalView, 'dotName' | 'summary' | 'id' | 'auto'> & Partial<Pick<ApprovalView, 'details' | 'card'>>,
    origin?: string,
    kind: NoticeConversationKind = 'dm',
) {
    const where = origin ? `${origin.replace(/\/$/, '')}/approvals/${view.id}` : 'Approvals in Socio';
    // A request with a card (CB-232) is decided on that card only:
    // its facts, its quoted words and its parameters don't fit a message.
    if (view.card) {
        return `Approval needed: ${view.summary}.\nDecide on its card in Socio: ${where}`;
    }
    const details = (view.details ?? []).join('\n');
    const shown = details
        ? `\n${details.length > DETAILS_MAX ? `${details.slice(0, DETAILS_MAX)}… (the rest is in the app)` : details}`
        : '';
    const review = view.auto ? `\nAuto review passed it to you: ${autoReasonLine(view.auto).slice(0, 240)}` : '';
    // The Dot replies by itself once the user decides (CB-58), in the
    // conversation that asked; the notice is always a direct message.
    const carriesOn = kind === 'dm' ? 'here' : kind === 'topic' ? 'in the topic' : 'in the group';
    return `Approval needed: ${view.summary}.${shown}${review}\nApprove or deny it below, or in Socio: ${where}\nThe socio carries on ${carriesOn} once you decide.`;
}

/**
 * Requests from a Telegram conversation can't show a card there, so the
 * linked user gets a short direct message with Approve and Deny buttons
 * and a link to the request.
 * Nothing in it identifies anyone; it never blocks the request.
 */
export function approvalNotices(sources: ApprovalNoticeSources) {
    sources.approvals.onPending((view, { userId, threadId }) => {
        const telegram = sources.telegram();
        if (!threadId || !telegram || telegram.status !== 'online') {
            return;
        }
        void (async () => {
            const conversation = await sources.links.threadInfo(threadId);
            if (!conversation) {
                return;
            }
            const link = await sources.links.linkFor(userId);
            if (!link) {
                return;
            }
            await telegram.sendDirect(
                link.telegramUserId,
                approvalNotice(view, sources.config.appOrigin, conversation.kind),
                undefined,
                // No Approve button for a carded request: decided on its card.
                view.card ? {} : { buttons: approvalButtons(view.id) },
            );
        })().catch(() => console.log('Approvals: the Telegram notice could not be sent.'));
    });
}
