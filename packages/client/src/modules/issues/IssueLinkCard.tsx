import { Children, createContext, isValidElement, use, type ReactNode } from 'react';
import type { ExtraProps } from 'react-markdown';

import { useTranslation } from '@socio/i18n/react';
import { issuePath } from '@socio/shared/issues/issue-board';
import { issueKey } from '@socio/shared/issues/issue-types';

import { useInlinedOrOnDemand } from '../../i18n/on-demand';
import { AppLink } from '../../shell/AppLink';

import { issueLinkNumber, useIssueCard } from './issue-cards';
import { OPENED_FROM_CHAT } from './issue-meta';
import { useIssueTerms } from './issue-words';
import { IssueKey, PriorityBadge, StatusBadge, Tag } from './IssueBadges';

type MarkdownNode = NonNullable<ExtraProps['node']>;

// Whether an issue link stands alone (its paragraph or list item holds
// issue links only): a card there, an inline chip in running text (CB-104).
const StandsAlone = createContext(false);

/**
 * A link to one of this app's issues in a Dot's reply (CB-87), as a
 * compact card: key, title, status, priority, kind and area, read with the
 * viewer's own session. It opens the issue as the link did. Until the card
 * arrives, and when the viewer can't have the issue, it is the plain link.
 * Only a link that stands alone is a card; in running text it is the link
 * with the issue's status beside it (CB-104). Closing the issue it opens
 * comes back to the chat (CB-119).
 */
export function IssueLinkCard({ number, children }: { number: number; children?: ReactNode }) {
    const card = useIssueCard(number);
    const alone = use(StandsAlone);
    // The card's words (issues.terms) load on demand: the plain link until they're in.
    const worded = useInlinedOrOnDemand(['issues.terms']);
    const { t } = useTranslation(['issues.terms']);
    const terms = useIssueTerms();
    const path = issuePath(number);
    if (!card || !worded) {
        return (
            <AppLink href={path} state={OPENED_FROM_CHAT}>
                {children}
            </AppLink>
        );
    }
    // In a sentence the link keeps its words and flows with the text, its
    // status beside them; the card would break the line (CB-104).
    if (!alone) {
        return (
            <AppLink
                href={path}
                state={OPENED_FROM_CHAT}
                slot="issue-chip"
                title={t('issues.terms:ref', { key: issueKey(card.number), title: card.title })}
            >
                {children}
                <StatusBadge status={card.status} className="ml-1 h-auto align-[1px] leading-4 no-underline" />
            </AppLink>
        );
    }
    return (
        <AppLink
            href={path}
            state={OPENED_FROM_CHAT}
            slot="issue-card"
            className="my-1 flex min-w-0 w-full max-w-md flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 leading-5 text-card-foreground no-underline shadow-xs transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
            <span className="flex min-w-0 items-start gap-2">
                <IssueKey number={card.number} />
                <span className="min-w-0 text-[13px] font-medium [overflow-wrap:anywhere]">{card.title}</span>
            </span>
            {card.excerpt && (
                <span data-slot="issue-card-summary" className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {card.excerpt}
                </span>
            )}
            <span className="flex flex-wrap items-center gap-1">
                <StatusBadge status={card.status} />
                <PriorityBadge priority={card.priority} />
                <Tag title={t('issues.terms:tag.kind')}>{terms.kind(card.kind)}</Tag>
                {card.area && <Tag title={t('issues.terms:tag.area')}>{terms.area(card.area)}</Tag>}
            </span>
        </AppLink>
    );
}

/** A Markdown link: an issue card for this app's issue links, else as is. */
export function ReplyLink({ href, children }: { href?: string; children?: ReactNode }) {
    const number = issueLinkNumber(href);
    if (number === undefined) {
        return <AppLink href={href}>{children}</AppLink>;
    }
    return <IssueLinkCard number={number}>{children}</IssueLinkCard>;
}

// What may sit between and after the links of a run of them: "CB-1, CB-2
// and CB-3.", and marks with no words, such as the "↗" some models put
// after a link (CB-118). A letter or digit makes it running text.
const SEPARATORS = /^(?:[^\p{L}\p{N}]|\band\b|\bor\b)*$/iu;

/**
 * Whether a paragraph or list holds issue links only (with separators, or
 * a list item's paragraph): those show as a stack of cards.
 */
export function issueLinksOnly(node: MarkdownNode | undefined): boolean {
    let links = 0;
    const only = (element: MarkdownNode): boolean =>
        element.children.every((child) => {
            if (child.type === 'text') {
                return SEPARATORS.test(child.value);
            }
            if (child.type !== 'element') {
                return true;
            }
            if (child.tagName === 'a') {
                const href = child.properties.href;
                if (typeof href !== 'string' || issueLinkNumber(href) === undefined) {
                    return false;
                }
                links++;
                return true;
            }
            return ['li', 'p'].includes(child.tagName) && only(child);
        });
    return !!node && only(node) && links > 0;
}

/**
 * The links of a paragraph or list item that holds issue links only, as
 * cards, their separators and trailing punctuation dropped.
 */
export function IssueCards({ children }: { children?: ReactNode }) {
    return <StandsAlone value>{Children.toArray(children).filter(isValidElement)}</StandsAlone>;
}

/** A paragraph of issue links only: a stack of cards. */
export function IssueCardStack({ children }: { children?: ReactNode }) {
    return (
        <div data-slot="issue-cards" className="my-2 flex flex-col first:mt-0">
            <IssueCards>{children}</IssueCards>
        </div>
    );
}
