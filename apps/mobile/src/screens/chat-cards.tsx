import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { ReactionKind } from '@socio/shared/chat/reactions';

import type { Card } from '../chat/cards';
import { OPEN_IN_APPROVALS, OPEN_IN_BROWSER } from '../chat/chat-view';
import { accessibilityActionsOf, COPIED, COPIED_MS, COPY, type MenuAction } from '../chat/long-press';
import { ACCEPT, CUSTOMIZE, NOT_NOW, SUGGESTED_NAME } from '../chat/name-suggestion';
import type { ReviewCardView } from '../chat/page-review';
import type { ReactionButton } from '../chat/reactions';
import { approvalAction } from '../navigation/tabs';
import { Button, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { CardPicture } from './attachments';

// The transcript's cards (src/chat/cards.ts decides what each says):
// read-only, each a bordered card at the transcript's width with even
// padding, its web page behind "Open in your browser" (useOpenLink, with
// its sign-in line the first time); a voice receipt is a small line on the
// right, as on the web. Also the action row under every message and the
// name-suggestion card above the composer.

const CARD_ICONS: Record<Exclude<Card['kind'], 'receipt' | 'page-review'>, SymbolName> = {
    approval: 'shield-alert',
    coding: 'code-xml',
    screenshot: 'monitor',
};

export function CardView({
    card,
    testID,
    webUrl,
    openLink,
}: {
    card: Card;
    testID: string;
    /** The chat's page on the web, for the cards whose detail shows there. */
    webUrl: string;
    openLink: (href: string) => void;
}) {
    const navigation = useNavigation();
    if (card.kind === 'receipt') {
        return (
            <View
                testID={testID}
                accessible
                accessibilityLabel={card.error === null ? card.label : `${card.label}. ${card.error}`}
                className="max-w-[85%] gap-1 self-end rounded-2xl rounded-br-sm bg-muted p-3"
            >
                <View className="flex-row items-center gap-2">
                    <AppSymbol name="phone-off" size={14} color="muted-foreground" />
                    <Text variant="footnote" tone="muted">
                        {card.label}
                    </Text>
                </View>
                {card.error === null ? null : (
                    <Text variant="footnote" tone="destructive">
                        {card.error}
                    </Text>
                )}
            </View>
        );
    }
    if (card.kind === 'page-review') {
        // Drawn by ReviewCard, with its decision (chat.tsx).
        return null;
    }
    const icon = card.kind === 'approval' && card.state === 'approved' ? 'shield-check' : CARD_ICONS[card.kind];
    // An approval opens its request's page in the app (the full card's Open in Approvals), never the browser.
    const href = card.kind === 'approval' || (card.kind === 'coding' && !card.web) ? null : webUrl;
    return (
        <View testID={testID} className="gap-3 self-stretch rounded-xl border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
                <AppSymbol
                    name={icon}
                    size={16}
                    color={card.kind === 'approval' && card.state === 'pending' ? 'primary' : 'muted-foreground'}
                />
                <Text weight="medium" accessibilityRole="header" className="flex-1">
                    {card.title}
                </Text>
            </View>
            {card.kind === 'approval' ? (
                <>
                    {card.summary === '' ? null : <Text>{card.summary}</Text>}
                    {card.note === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {card.note}
                        </Text>
                    )}
                </>
            ) : card.kind === 'coding' ? (
                <>
                    {card.repository === null ? null : (
                        <Text variant="footnote" tone="muted" numberOfLines={2}>
                            {card.repository}
                        </Text>
                    )}
                    <Text>{card.status}</Text>
                    {card.pullRequest === null ? null : (
                        <Button
                            label={card.pullRequest.label}
                            variant="secondary"
                            icon="git-pull-request"
                            onPress={() => openLink(card.pullRequest!.url)}
                            testID={`${testID}-pull-request`}
                        />
                    )}
                </>
            ) : (
                <>
                    {card.page === null ? null : (
                        <Text variant="footnote" tone="muted" numberOfLines={2} selectable>
                            {card.page}
                        </Text>
                    )}
                    {card.image === null ? null : <CardPicture image={card.image} testID={`${testID}-picture`} />}
                    {card.note === '' ? null : (
                        <Text variant="footnote" tone="muted">
                            {card.note}
                        </Text>
                    )}
                </>
            )}
            {card.kind === 'approval' ? (
                <Button
                    label={OPEN_IN_APPROVALS}
                    variant="ghost"
                    onPress={() => navigation.dispatch(approvalAction(card.id))}
                    testID={`${testID}-open`}
                />
            ) : href === null ? null : (
                <Button
                    label={OPEN_IN_BROWSER}
                    variant="secondary"
                    icon="external-link"
                    onPress={() => openLink(href)}
                    testID={`${testID}-open`}
                />
            )}
        </View>
    );
}

const REACTION_ICONS: Record<ReactionKind, SymbolName> = {
    up: 'thumbs-up',
    down: 'thumbs-down',
    retry: 'refresh-cw',
    'needs-work': 'wrench',
};

/**
 * The action row under a message (the web's MessageActions; owner, 2026-11-18:
 * under every message): Copy (a check and "Copied" for 2 s), a stored reply's
 * four reaction toggles, the reader's own highlighted, then the time. 44 pt
 * targets each. Copy carries the message's whole menu (Share too) as its
 * accessibility actions, since a reply is never one accessible element.
 */
export function MessageActionRow({
    buttons,
    onToggle,
    onCopy,
    actions,
    onAction,
    time,
    align = 'start',
    testID,
}: {
    /** A stored reply's reactions, or null (the person's message: Copy and the time). */
    buttons: readonly ReactionButton[] | null;
    onToggle: (button: ReactionButton) => void;
    onCopy: () => void;
    /** The message's long-press menu, as Copy's accessibility actions. */
    actions: readonly MenuAction[];
    onAction: (name: string) => void;
    /** When the message was written, last in the row as on the web ("10:01 AM"), or null. */
    time?: string | null;
    /** The person's own messages: under the bubble, on the right. */
    align?: 'start' | 'end';
    testID: string;
}) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) {
            return undefined;
        }
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    return (
        <View testID={testID} className={cx('flex-row items-center', align === 'end' && 'self-end')}>
            <Pressable
                testID={`${testID}-copy`}
                accessibilityRole="button"
                accessibilityLabel={copied ? COPIED : COPY.label}
                accessibilityActions={accessibilityActionsOf(actions)}
                onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
                onPress={() => {
                    onCopy();
                    setCopied(true);
                }}
                className="min-h-11 min-w-11 items-center justify-center rounded-md p-3 active:bg-muted"
            >
                <AppSymbol name={copied ? 'check' : 'copy'} size={16} color="muted-foreground" />
            </Pressable>
            {(buttons ?? []).map((button) => (
                <Pressable
                    key={button.kind}
                    testID={`${testID}-${button.kind}`}
                    accessibilityRole="button"
                    accessibilityLabel={button.accessibilityLabel}
                    accessibilityState={{ selected: button.on }}
                    onPress={() => onToggle(button)}
                    className={
                        button.on
                            ? 'min-h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-md bg-accent p-3'
                            : 'min-h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-md p-3 active:bg-muted'
                    }
                >
                    <AppSymbol
                        name={REACTION_ICONS[button.kind]}
                        size={16}
                        color={button.on ? 'foreground' : 'muted-foreground'}
                    />
                    {button.count === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {button.count}
                        </Text>
                    )}
                </Pressable>
            ))}
            {time === undefined || time === null ? null : (
                <Text
                    variant="footnote"
                    tone="muted"
                    className="px-2"
                    style={{ fontVariant: ['tabular-nums'] }}
                    testID={`${testID}-time`}
                >
                    {time}
                </Text>
            )}
        </View>
    );
}

/** The server's suggested name for the chat, with Accept, Not now and Customize (CB-292). */
export function NameSuggestionCard(props: {
    name: string;
    busy: boolean;
    notice: string | null;
    onAccept: () => void;
    onReject: () => void;
    onCustomize: () => void;
}) {
    return (
        <View testID="chat-name-suggestion" className="gap-3 rounded-xl border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
                <AppSymbol name="sparkles" size={16} color="muted-foreground" />
                <Text variant="footnote" tone="muted" className="flex-1">
                    {SUGGESTED_NAME}
                </Text>
            </View>
            <Text weight="medium">{props.name}</Text>
            {props.notice === null ? null : (
                <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
                    {props.notice}
                </Text>
            )}
            <View className="flex-row flex-wrap gap-2">
                <Button
                    label={ACCEPT}
                    onPress={props.onAccept}
                    busy={props.busy}
                    testID="chat-name-suggestion-accept"
                />
                <Button label={NOT_NOW} variant="ghost" onPress={props.onReject} disabled={props.busy} />
                <Button label={CUSTOMIZE} variant="ghost" onPress={props.onCustomize} disabled={props.busy} />
            </View>
        </View>
    );
}

/** "Review", on a page review's card: opens its sheet. */
export const REVIEW_BUTTON = 'Review';
export const OPEN_PAGE = 'Open page';

/**
 * A page review's card (src/chat/page-review.ts says what): the draft's
 * title, where the review stands, and Review (the sheet with Save and Skip)
 * or Open page once saved.
 */
export function ReviewCard({
    title,
    view,
    testID,
    onReview,
    openLink,
}: {
    title: string;
    view: ReviewCardView;
    testID: string;
    onReview: () => void;
    openLink: (href: string) => void;
}) {
    const { action } = view;
    return (
        <View testID={testID} className="gap-3 self-stretch rounded-xl border border-border bg-card p-3">
            <View className="flex-row items-center gap-2">
                <AppSymbol name="file-text" size={16} color={view.waiting ? 'primary' : 'muted-foreground'} />
                <Text weight="medium" accessibilityRole="header" className="flex-1">
                    {view.heading}
                </Text>
            </View>
            <Text numberOfLines={2}>{title}</Text>
            {view.note === null ? null : (
                <Text variant="footnote" tone={view.problem ? 'destructive' : 'muted'}>
                    {view.note}
                </Text>
            )}
            {action === null ? null : action.kind === 'review' ? (
                <Button
                    label={REVIEW_BUTTON}
                    variant={view.waiting ? 'primary' : 'secondary'}
                    onPress={onReview}
                    testID={`${testID}-review`}
                />
            ) : (
                <Button
                    label={OPEN_PAGE}
                    variant="secondary"
                    icon="external-link"
                    onPress={() => openLink(action.href)}
                    testID={`${testID}-open`}
                />
            )}
        </View>
    );
}
