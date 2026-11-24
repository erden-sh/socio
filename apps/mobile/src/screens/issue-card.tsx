import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import type { IssueSummary } from '@socio/shared/issues/issue-types';

import { type IssueCardLink, type IssueCardPill, issueCardView } from '../chat/markdown-links';
import { useCollections, useLiveQuery, useSyncOnFocus } from '../live';
import { issuesQuery } from '../shell/queries';
import { ISSUES } from '../sync/issues';
import { useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { Text } from '../ui';
import { cx } from '../ui/cx';

import { useOpenLink } from './open-link';

// Issue cards in a socio's reply ("lines of issue links as issue cards
// from the store"): the web's IssueLinkCard, natively.
// A paragraph or list item of issue links only (markdown-links.ts's
// `issueCardParts`) is a stack of cards, one per link: the key, the title, the
// description's first words, then the status, priority, kind and area as the
// web's badges. Each is drawn from the phone's issues kind (`sync/issues.ts`),
// which the stack asks for while the chat shows (`useSyncOnFocus`, so a poll
// only while it is in view), and opens the issue's screen as the link did. An
// issue the phone doesn't hold (not pulled yet, or no access) stays the link,
// a chip, as the web's card stays the link until it arrives.

const SYNCED = [ISSUES];
/** The web's `rounded-md px-1.5 text-[11px] leading-5` badge, at the app's 12 pt floor. */
const PILL = 'rounded-md border px-1.5';

export function IssueCardStack({
    links,
    chip,
    testID,
}: {
    links: readonly IssueCardLink[];
    /** The link as Markdown (chat-markdown.tsx's chip), for an issue the phone doesn't hold. */
    chip: (source: string) => ReactNode;
    testID?: string;
}) {
    const collections = useCollections();
    useSyncOnFocus(SYNCED);
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
    return (
        <View testID={testID} className="gap-2">
            {links.map((link, index) => {
                const issue = byNumber.get(link.number);
                return (
                    <View key={`${index}:${link.key}`}>
                        {issue === undefined ? chip(link.source) : <IssueCard issue={issue} />}
                    </View>
                );
            })}
        </View>
    );
}

function IssueCard({ issue }: { issue: IssueSummary }) {
    const openLink = useOpenLink();
    const card = issueCardView(issue);
    return (
        <Pressable
            testID={`issue-card-${card.key}`}
            accessibilityRole="button"
            accessibilityLabel={card.accessibilityLabel}
            accessibilityHint="Opens the issue"
            onPress={() => openLink(`/issues/${card.key}`)}
            className="min-h-11 gap-1 rounded-lg border border-border bg-card px-3 py-2 active:bg-muted"
        >
            <View className="flex-row items-start gap-2">
                <Text variant="meta">{card.key}</Text>
                <Text variant="row-title" className="min-w-0 flex-1">
                    {card.title}
                </Text>
            </View>
            {card.excerpt === null ? null : (
                <Text variant="row-subtitle" numberOfLines={2}>
                    {card.excerpt}
                </Text>
            )}
            <View className="flex-row flex-wrap items-center gap-1 pt-0.5">
                {card.pills.map((pill) => (
                    <Pill key={pill.label} pill={pill} />
                ))}
            </View>
        </Pressable>
    );
}

/** A badge: its tone's words, border and tint (the web's `border-<hue>/30 bg-<hue>/10`), or the neutral tag. */
function Pill({ pill }: { pill: IssueCardPill }) {
    const tones = theme[useScheme()].tones;
    if (pill.tone === null) {
        return (
            <View className={cx(PILL, 'border-border bg-muted/40')}>
                <Text variant="footnote" tone="muted">
                    {pill.label}
                </Text>
            </View>
        );
    }
    const { foreground, tint } = tones[pill.tone];
    return (
        <View className={PILL} style={{ borderColor: `${foreground}4d`, backgroundColor: tint }}>
            <Text variant="footnote" weight="medium" style={{ color: foreground }}>
                {pill.label}
            </Text>
        </View>
    );
}
