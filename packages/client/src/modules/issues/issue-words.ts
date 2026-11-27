import { useTranslation } from '@socio/i18n/react';
import {
    ISSUE_AREAS,
    ISSUE_LABELS,
    type IssueArea,
    type IssueKind,
    type IssueLabel,
    type IssuePriority,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';

/**
 * A label's key in `issues.terms` (a label may hold a `:`, the namespace
 * separator).
 */
const LABEL_KEYS = {
    'owner:lead': 'owner-lead',
    'owner:user': 'owner-user',
    'needs-decision': 'needs-decision',
    regression: 'regression',
    security: 'security',
    ux: 'ux',
    performance: 'performance',
    'good-first-issue': 'good-first-issue',
    'dot-request': 'dot-request',
} as const satisfies Record<IssueLabel, string>;

const isArea = (value: string): value is IssueArea => (ISSUE_AREAS as readonly string[]).includes(value);
const isLabel = (value: string): value is IssueLabel => (ISSUE_LABELS as readonly string[]).includes(value);

/**
 * The board's words for its stored values (`issues.terms`): a status,
 * priority, kind, area or label as the reader's language says it. Only
 * what is shown: filters, changes and requests keep the values.
 */
export function useIssueTerms() {
    const { t } = useTranslation(['issues.terms']);
    return {
        status: (status: IssueStatus) => t(`issues.terms:status.${status}`),
        priority: (priority: IssuePriority) => t(`issues.terms:priority.${priority}`),
        kind: (kind: IssueKind) => t(`issues.terms:kind.${kind}`),
        /** An area this client doesn't know reads as stored. */
        area: (area: IssueArea) => (isArea(area) ? t(`issues.terms:area.${area}`) : area),
        /** A label this client doesn't know reads as stored. */
        label: (label: string) => (isLabel(label) ? t(`issues.terms:label.${LABEL_KEYS[label]}`) : label),
    };
}
export type IssueTerms = ReturnType<typeof useIssueTerms>;
