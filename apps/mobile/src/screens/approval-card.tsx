import { useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { type ReactNode, useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ApprovalView } from '@socio/shared/approvals';

import {
    type ApprovalBarView,
    type ApprovalBody,
    type ApprovalButton,
    type ApprovalButtonKey,
    type ApprovalCardView,
    type ApprovalContext,
    approvalBarView,
    approvalCardView,
    asksTo,
    blockWords,
    inert,
    outcomeNotice,
    readableParams,
    waitingInChat,
} from '../chat/approval-card';
import type { Card } from '../chat/cards';
import { OPEN_IN_APPROVALS } from '../chat/chat-view';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSyncStatus,
    useWorkspaceScope,
    useWriteHold,
} from '../live';
import { approvalAction } from '../navigation/tabs';
import type { ApprovalActions } from '../sync/approval-actions';
import { Button, GlassSurface, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

// The approval card and bar in a chat (src/chat/approval-card.ts says what
// each shows), drawn natively from the approvals data and decisions:
// - `useChatApprovals`: the chat's requests, each watched while the chat
//   shows (the approvals `watch`: read once, then every 5 s while it waits, 2 s while
//   its socio carries on), what the device knows of each, and the taps.
// - `ApprovalCardView`: the card in the transcript, at its width with even
//   padding; a request not read yet keeps the plain "Approval requested" card.
// - `ApprovalBar`: above the composer, in Liquid Glass on iOS 26 like the
//   composer (GlassSurface), the card surface elsewhere.
// - `ApprovalDetailsScreen`: the `ApprovalDetails` sheet, which opens the
//   long details (`POST …/open`, online only) and shows them whole, so
//   Approve unlocks.

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** What a chat knows of its approval requests, and what a tap does. */
export interface ChatApprovals {
    /** The request this device has read, by id. */
    readonly views: ReadonlyMap<string, ApprovalView>;
    /** The requests the server answered as not there (the approvals list's page says so). */
    readonly gone: ReadonlySet<string>;
    context(id: string): ApprovalContext;
    /** What the last tap on this request came to, if anything. */
    notice(id: string): string | null;
    act(id: string, key: ApprovalButtonKey): void;
    /** The bar for the oldest request waiting, or null. */
    readonly bar: ApprovalBarView | null;
    /** Changes whenever a card would draw differently (the list's `extraData`). */
    readonly version: string;
}

/** The approvals read again: `version` changes whenever anything they depend on may have. */
function readApprovals(approvals: ApprovalActions, ids: readonly string[], _version: string) {
    const views = new Map<string, ApprovalView>();
    const gone = new Set<string>();
    for (const id of ids) {
        const view = approvals.view(id);
        if (view !== undefined) {
            views.set(id, view);
        } else if (approvals.gone(id)) {
            gone.add(id);
        }
    }
    return { views, gone, blocked: approvals.blocked() };
}

/**
 * The chat's approval requests (`ids`, its cards' in order), watched while
 * the chat shows. `onShow` scrolls to a request's card (the bar's Show
 * request); `onDetails` opens its details sheet.
 */
export function useChatApprovals(
    ids: readonly string[],
    onShow: (id: string) => void,
    onDetails: (id: string) => void,
): ChatApprovals {
    const { approvals } = useWorkspaceScope();
    const collections = useCollections();
    // Each change of a row, of the connection, the server's or the session's state redraws.
    const { data: rows } = useLiveQuery({ query: (q) => q.from({ approval: collections.approvals }) });
    const status = useSyncStatus();
    const hold = useWriteHold();
    const [tick, setTick] = useState(0);
    useEffect(() => approvals.subscribe(() => setTick((value) => value + 1)), [approvals]);
    const key = ids.join(' ');
    useEffect(() => {
        const leaves = key === '' ? [] : key.split(' ').map((id) => approvals.watch(id));
        return () => {
            for (const leave of leaves) {
                leave();
            }
        };
    }, [approvals, key]);
    const [notices, setNotices] = useState<ReadonlyMap<string, string>>(() => new Map());
    const { views, gone, blocked } = readApprovals(
        approvals,
        ids,
        `${tick} ${rows.length} ${rows.map((row) => `${row.id}:${row.status}`).join(',')} ${String(status.reconnecting)} ${String(hold)}`,
    );
    const setNotice = (id: string, text: string | null) =>
        setNotices((current) => {
            const next = new Map(current);
            if (text === null) {
                next.delete(id);
            } else {
                next.set(id, text);
            }
            return next;
        });
    const context = (id: string): ApprovalContext => ({ state: approvals.state(id), blocked });
    const act = (id: string, action: ApprovalButtonKey) => {
        if (action === 'show') {
            onShow(id);
            return;
        }
        if (action === 'open') {
            onDetails(id);
            return;
        }
        setNotice(id, null);
        const run =
            action === 'undo' ? approvals.undo(id) : approvals.decide(id, action === 'approve' ? 'approve' : 'deny');
        run.then(
            (outcome) => {
                const text = outcomeNotice(outcome);
                setNotice(id, text);
                if (text !== null) {
                    AccessibilityInfo.announceForAccessibility(text);
                }
            },
            () => setNotice(id, outcomeNotice({ kind: 'failed', status: null })),
        );
    };
    const waiting = waitingInChat(ids, (id) => views.get(id));
    const first = waiting[0];
    const version = [
        String(blocked),
        ...ids.map((id) => {
            const view = views.get(id);
            const state = approvals.state(id);
            return view === undefined
                ? `${id}:${String(gone.has(id))}`
                : `${id}:${view.status}:${String(view.review?.opened)}:${String(view.continuation?.status)}:${String(view.auto?.undoneAt)}:${String(state.busy)}:${String(state.unconfirmed)}:${notices.get(id) ?? ''}`;
        }),
    ].join(' ');
    return {
        version,
        views,
        gone,
        context,
        notice: (id) => notices.get(id) ?? null,
        act,
        bar: first === undefined ? null : approvalBarView(waiting, context(first.id)),
    };
}

/** A request's buttons in a row that wraps: the card's, the bar's and the Inbox row's. */
export function ActionRow({
    actions,
    onAction,
    testID,
    children,
}: {
    actions: readonly ApprovalButton[];
    onAction: (key: ApprovalButtonKey) => void;
    testID: string;
    /** A last button of the row's (a chat card's "Open in Approvals"). */
    children?: ReactNode;
}) {
    return (
        <View className="flex-row flex-wrap gap-2">
            {actions.map((action) => (
                <Button
                    key={action.key}
                    label={action.label}
                    variant={action.variant}
                    disabled={action.disabled}
                    busy={action.busy}
                    accessibilityHint={action.hint ?? undefined}
                    onPress={() => onAction(action.key)}
                    testID={`${testID}-${action.key}`}
                />
            ))}
            {children}
        </View>
    );
}

/** A fact's label and value, inline so it wraps at any text size (no fixed widths). */
function Fact({ label, value, mono }: { label: string; value: string; mono: boolean }) {
    return (
        <Text variant="footnote">
            <Text variant="footnote" tone="muted">
                {`${label}  `}
            </Text>
            <Text variant="footnote" style={mono ? { fontFamily: MONO } : undefined}>
                {value}
            </Text>
        </Text>
    );
}

function Body({ body, testID }: { body: ApprovalBody; testID: string }) {
    return (
        <View className="gap-2">
            {body.lead === '' ? null : (
                <Text>
                    {body.lead}
                    {body.tag === null ? '' : ` · ${body.tag}`}
                </Text>
            )}
            {body.facts.length === 0 ? null : (
                <View className="gap-1">
                    {body.facts.map((fact) => (
                        <Fact key={fact.label} {...fact} />
                    ))}
                </View>
            )}
            {body.list === null ? null : (
                <View className="gap-1">
                    <Text variant="footnote" weight="medium">
                        {body.list.title}
                    </Text>
                    {body.list.items.map((item) => (
                        <Text key={item} variant="footnote">{`•  ${item}`}</Text>
                    ))}
                </View>
            )}
            {body.lines.map((line, index) => (
                <Text
                    key={index}
                    variant="footnote"
                    tone={line.tone === 'muted' ? 'muted' : 'default'}
                    weight={line.tone === 'warning' ? 'medium' : 'normal'}
                >
                    {line.text}
                </Text>
            ))}
            {body.params === null ? null : (
                <View className="gap-1" testID={`${testID}-params`}>
                    <Text variant="footnote" weight="medium" accessibilityRole="header">
                        {body.params.title}
                    </Text>
                    {body.params.counts.map((count) => (
                        <Text key={count} variant="footnote">
                            {count}
                        </Text>
                    ))}
                    <View className="rounded-md border border-border bg-muted p-2">
                        <Text variant="footnote" selectable style={{ fontFamily: MONO }}>
                            {body.params.text}
                        </Text>
                    </View>
                    {body.params.note === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {body.params.note}
                        </Text>
                    )}
                </View>
            )}
            {body.code === null ? null : (
                <View className="rounded-md border border-border bg-muted p-2">
                    <Text variant="footnote" selectable style={{ fontFamily: MONO }}>
                        {body.code}
                    </Text>
                </View>
            )}
            {body.display.length === 0 ? null : (
                <View className="gap-1">
                    <Text variant="footnote" tone="muted">
                        As described by the app (its own words):
                    </Text>
                    {body.display.map((line, index) => (
                        <Fact key={index} label={line.label} value={line.value} mono={false} />
                    ))}
                </View>
            )}
            {body.quote === null ? null : (
                <View className="gap-1">
                    <Text variant="footnote" tone="muted">{`${body.quote.who} says:`}</Text>
                    <View className="border-l-2 border-border pl-2">
                        <Text>{body.quote.text}</Text>
                    </View>
                </View>
            )}
        </View>
    );
}

const BADGE_LOOKS = {
    waiting: { box: 'bg-primary', tone: 'on-primary' },
    approved: { box: 'bg-secondary', tone: 'on-secondary' },
    other: { box: 'border border-border', tone: 'muted' },
} as const;

/** The card of a request this device has read. */
function ActionableCard({
    card,
    onAction,
    onOpen,
    testID,
}: {
    card: ApprovalCardView;
    onAction: (key: ApprovalButtonKey) => void;
    /** Opens the request's page in the app; null on that page and the list, which show none, as the web's. */
    onOpen: (() => void) | null;
    testID: string;
}) {
    const look = BADGE_LOOKS[card.badge.tone];
    return (
        <View testID={testID} className="gap-3 self-stretch rounded-xl border border-border bg-card p-3">
            <View accessible accessibilityRole="header" accessibilityLabel={card.accessibilityLabel} className="gap-2">
                <View className="flex-row items-start gap-2">
                    <AppSymbol
                        name={card.badge.tone === 'approved' ? 'shield-check' : 'shield-alert'}
                        size={16}
                        color={card.badge.tone === 'waiting' ? 'primary' : 'muted-foreground'}
                    />
                    <Text weight="medium" className="flex-1">
                        {card.title}
                    </Text>
                </View>
                <View className={cx('self-start rounded-full px-2 py-0.5', look.box)}>
                    <Text variant="footnote" tone={look.tone} testID={`${testID}-status`}>
                        {card.badge.text}
                    </Text>
                </View>
            </View>
            <Body body={card.body} testID={testID} />
            {card.outcome === null ? null : (
                <Text variant="footnote" tone={card.outcome.failed ? 'destructive' : 'muted'}>
                    {card.outcome.text}
                </Text>
            )}
            {card.auto === null ? null : (
                <View className="gap-0.5 rounded-md border border-dashed border-border p-2">
                    <Text variant="footnote" weight="medium">{`${card.auto.lead}:`}</Text>
                    <Text variant="footnote">{card.auto.reason}</Text>
                </View>
            )}
            <Text variant="footnote" tone="muted">
                {card.line}
            </Text>
            {card.notice === null ? null : (
                <Text variant="footnote" weight="medium" accessibilityLiveRegion="polite" testID={`${testID}-notice`}>
                    {card.notice}
                </Text>
            )}
            <ActionRow actions={card.actions} onAction={onAction} testID={testID}>
                {onOpen === null ? null : (
                    <Button label={OPEN_IN_APPROVALS} variant="ghost" onPress={onOpen} testID={`${testID}-open`} />
                )}
            </ActionRow>
        </View>
    );
}

/**
 * An approval card in the transcript: the actionable card once the request
 * is read, else the plain card from the tool result (`fallback`, drawn by `plain`).
 */
export function ApprovalCardItem({
    fallback,
    approvals,
    plain,
    testID,
}: {
    fallback: Extract<Card, { kind: 'approval' }>;
    approvals: ChatApprovals;
    plain: ReactNode;
    testID: string;
}) {
    const navigation = useNavigation();
    const view = approvals.views.get(fallback.id);
    if (view === undefined) {
        return plain;
    }
    return (
        <ActionableCard
            card={approvalCardView(view, approvals.context(fallback.id), approvals.notice(fallback.id))}
            onAction={(key) => approvals.act(fallback.id, key)}
            onOpen={() => navigation.dispatch(approvalAction(fallback.id))}
            testID={testID}
        />
    );
}

/**
 * A request's card by id, on the approvals list and the request's own page
 * the chat's card once the request is read, else nothing.
 */
export function ApprovalCardById({ id, approvals, testID }: { id: string; approvals: ChatApprovals; testID: string }) {
    const view = approvals.views.get(id);
    if (view === undefined) {
        return null;
    }
    return (
        <ActionableCard
            card={approvalCardView(view, approvals.context(id), approvals.notice(id))}
            onAction={(key) => approvals.act(id, key)}
            onOpen={null}
            testID={testID}
        />
    );
}

/** The bar above the composer: the oldest request waiting in the chat. */
export function ApprovalBar({ bar, onAction }: { bar: ApprovalBarView; onAction: (key: ApprovalButtonKey) => void }) {
    return (
        <View className="px-4 pb-3">
            <GlassSurface
                testID="chat-approval-bar"
                radius={16}
                fallbackClassName="border border-border bg-card"
                className="gap-3 p-3"
            >
                <View accessible accessibilityLabel={`${bar.accessibilityLabel}. ${bar.summary}`} className="gap-1">
                    <View className="flex-row flex-wrap items-center gap-2">
                        <AppSymbol name="shield-alert" size={16} color="primary" />
                        <Text weight="medium" className="shrink">
                            {bar.title}
                        </Text>
                        {bar.count === null ? null : (
                            <View className="rounded-full bg-muted px-2 py-0.5">
                                <Text variant="footnote" tone="muted" testID="chat-approval-bar-count">
                                    {bar.count}
                                </Text>
                            </View>
                        )}
                    </View>
                    {bar.summary === '' ? null : (
                        <Text variant="footnote" tone="muted" numberOfLines={2}>
                            {bar.summary}
                        </Text>
                    )}
                </View>
                {bar.note === null ? null : (
                    <Text variant="footnote" weight="medium" testID="chat-approval-bar-note">
                        {bar.note}
                    </Text>
                )}
                <ActionRow actions={bar.actions} onAction={onAction} testID="chat-approval-bar" />
            </GlassSurface>
        </View>
    );
}

// ----- The details sheet -----

type DetailsState =
    | { readonly kind: 'opening' }
    | { readonly kind: 'opened'; readonly text: string }
    | { readonly kind: 'problem'; readonly text: string };

export const OPENING_DETAILS = 'Opening the details…';
export const DETAILS_NOT_OPENED = 'Couldn’t open the details. Try again.';

export function ApprovalDetailsScreen({ route }: StaticScreenProps<{ id: string }>) {
    return useHasWorkspaceScope() ? <ApprovalDetails id={route.params.id} /> : null;
}

function ApprovalDetails({ id }: { id: string }) {
    const { approvals } = useWorkspaceScope();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const [state, setState] = useState<DetailsState>({ kind: 'opening' });
    useEffect(() => {
        let live = true;
        approvals
            .openDetails(id)
            .then((outcome) => {
                if (!live) {
                    return;
                }
                if (outcome.kind === 'opened') {
                    setState({ kind: 'opened', text: readableParams(inert(outcome.full)) });
                } else {
                    setState({
                        kind: 'problem',
                        text:
                            outcome.kind === 'blocked'
                                ? blockWords(outcome.reason)
                                : (outcomeNotice(outcome) ?? DETAILS_NOT_OPENED),
                    });
                }
            })
            .catch(() => live && setState({ kind: 'problem', text: DETAILS_NOT_OPENED }));
        return () => {
            live = false;
        };
    }, [approvals, id]);
    const view = approvals.view(id);
    return (
        <ScrollView
            testID="approval-details"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 12 }}
        >
            <Text weight="medium" accessibilityRole="header">
                {view === undefined ? 'Details' : asksTo(view)}
            </Text>
            {state.kind === 'opened' ? (
                <View className="rounded-md border border-border bg-muted p-2">
                    <Text variant="footnote" selectable style={{ fontFamily: MONO }} testID="approval-details-text">
                        {state.text}
                    </Text>
                </View>
            ) : (
                <Text variant="subheadline" tone="muted" accessibilityLiveRegion="polite">
                    {state.kind === 'opening' ? OPENING_DETAILS : state.text}
                </Text>
            )}
            <Button
                label="Done"
                variant="secondary"
                onPress={() => navigation.goBack()}
                testID="approval-details-done"
            />
        </ScrollView>
    );
}
