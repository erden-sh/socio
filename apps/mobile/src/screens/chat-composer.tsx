import * as Haptics from 'expo-haptics';
import { TextInputWrapper } from 'expo-paste-input';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Platform, Pressable, TextInput, type TextInputInstance, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    type BubbleAction,
    COMPOSER_PLACEHOLDER,
    composerInputHeight,
    type ComposerView,
    JUMP_TO_LATEST,
    type PendingBubble,
    type StatusPill,
} from '../chat/composer';
import {
    type Quote,
    QUOTED_COMMAND_NOTE,
    quotedCommand,
    REMOVE_QUOTE,
    replyingTo,
    splitQuote,
    withQuote,
} from '../chat/quote-reply';
import { useWorkspaceScope } from '../live';
import { useHaptics } from '../platform/device-settings';
import { DraftError, type DraftRecord } from '../sync/chat-drafts';
import { useColors, useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { GlassSurface, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';
import { hasLiquidGlass } from '../ui/glass';
import type { SymbolName } from '../ui/symbols';
import { useAnnouncement } from '../ui/use-announcement';

import { AttachButton, AttachMenu, AttachmentTray, MessageAttachments, type Tray } from './attachments';
import { MessageText } from './message-text';

// The chat's composer and its parts (src/chat/composer.ts has the rules):
// - `Composer`: T3 Code's composer on a phone, a box that grows to a few lines
//   with one round button at its end, Send in the chat module's mint tone,
//   Stop while a turn runs and the box is empty. It floats over the
//   transcript in Liquid Glass on iOS 26 (GlassSurface), on the card surface
//   elsewhere, with the same padding on every side. Under it, the held or
//   update line. An image pasted into its box goes to the tray.
//   A chat's and a room's are `stacked`, the web's box (owner, 2026-11-18):
//   "Message <socio>…" on top at full width, then Attach (the paperclip, the
//   same three choices) and the round send in the web's foreground tone. The
//   web's link (a source page) and mic (dictation) aren't in the app yet.
// - `StatusPillView`: the running turn's phase, shimmering unless Reduce
//   Motion is on, and "Jump to latest" while the list doesn't follow.
// - `PendingBubbleView`: a message of the person's that isn't in the
//   transcript yet, dashed while it waits, with its caption and buttons.
// - `useDraft`: the box's text from the scope's drafts, memory first.
// - `useQuotedDraft`: a chat's or room's draft split into its quote (CB-571,
//   the chip over the box) and the words the box shows.

/** A draft scope's text, and a setter that writes it (a locked draft refuses). */
export function useDraft(scope: string | null): { text: string; locked: boolean; setText: (text: string) => void } {
    const { drafts } = useWorkspaceScope();
    const subscribe = useCallback(
        (listener: () => void) => drafts.subscribe((changed) => changed === scope && listener()),
        [drafts, scope],
    );
    const record: DraftRecord = useSyncExternalStore(subscribe, () =>
        scope === null ? EMPTY_DRAFT : drafts.read(scope),
    );
    const setText = (text: string) => {
        if (scope === null) {
            return;
        }
        try {
            drafts.write(scope, text);
        } catch (error) {
            // A newer build's draft, or the scope closing: the box shows what is kept.
            if (!(error instanceof DraftError)) {
                throw error;
            }
        }
    };
    return { text: record.text, locked: record.locked === true, setText };
}

const EMPTY_DRAFT: DraftRecord = { text: '', at: 0 };

/**
 * A draft whose text may start with a quote (CB-571, quote-reply.ts): the quote for the chip, the
 * words after it for the box, a setter for those words that keeps the quote, and the chip's x.
 */
export function useQuotedDraft(draft: ReturnType<typeof useDraft>): {
    quote: Quote | null;
    text: string;
    setText: (text: string) => void;
    removeQuote: () => void;
} {
    const { quote, rest } = splitQuote(draft.text);
    return {
        quote,
        text: rest,
        setText: (text) => draft.setText(withQuote(quote, text)),
        removeQuote: () => draft.setText(rest),
    };
}

/** A light selection tick, when the Haptics setting is on. */
export function useTapHaptic(): () => void {
    const on = useHaptics();
    return () => {
        if (on) {
            Haptics.selectionAsync().catch(() => {});
        }
    };
}

/** The composer's corner radius: a pill while it holds one line. */
const COMPOSER_RADIUS = 24;
/** The stacked box's, the web's `rounded-2xl`. */
const STACKED_RADIUS = 16;
/** The web's label on its paperclip. */
export const ATTACH_FILES = 'Attach files';

/** A stacked box's toolbar button (the web's ChatIconButton): 18 pt, muted, a 44 pt target. */
function ToolButton(props: {
    icon: SymbolName;
    label: string;
    open: boolean;
    disabled: boolean;
    onPress: () => void;
    testID: string;
}) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            accessibilityState={{ expanded: props.open, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            className={cx(
                'size-11 items-center justify-center rounded-lg active:bg-accent',
                props.open && 'bg-accent',
                props.disabled && 'opacity-50',
            )}
        >
            <AppSymbol name={props.icon} size={18} color="muted-foreground" />
        </Pressable>
    );
}

export function Composer(props: {
    text: string;
    onChangeText: (text: string) => void;
    view: ComposerView;
    onSend: () => void;
    onStop: () => void;
    /** A line of its own over the box (a stop that failed), or null. */
    notice?: string | null;
    /** Its height changes: the transcript's bottom inset. */
    onHeight?: (height: number) => void;
    /** Pads the bottom safe area itself (not in a tab, keyboard closed). */
    bottomInset?: boolean;
    /** The draft's tray: the "+" with its menu, and the files over the box. */
    tray?: Tray;
    /** The box's placeholder and label: a room's say whom it talks to. */
    placeholder?: string;
    inputLabel?: string;
    /** Where the caret goes after the screen changed the text (a mention picked), then null. */
    selection?: { start: number; end: number } | null;
    /** The caret as the person moves it (the room's `@` picker reads it). */
    onCaret?: (caret: number) => void;
    /** Over the box, inside the composer: a room's `@` picker. */
    above?: ReactNode;
    /** The message being replied to (CB-571): a chip over the box with its x. A new one focuses the box. */
    quote?: { readonly quote: Quote; readonly onRemove: () => void } | null;
    /**
     * Send's look: the chat module's mint by default; `primary` is the web's
     * teal primary button (an issue's Comment), with its pressed state and words' color.
     */
    send?: 'mint' | 'primary';
    /**
     * The web's chat composer (owner, 2026-11-18): the box on top, full width,
     * then a toolbar with Attach on the left and the round send on the right.
     */
    stacked?: boolean;
    testID?: string;
}) {
    const { view, tray } = props;
    const [menu, setMenu] = useState(false);
    const notice = props.notice ?? tray?.notice ?? null;
    const insets = useSafeAreaInsets();
    const colors = useColors();
    const mint = theme[useScheme()].tones.mint.foreground;
    const tap = useTapHaptic();
    const stop = view.action === 'stop';
    const primary = props.send === 'primary';
    const stacked = props.stacked === true;
    const press = () => {
        tap();
        if (stop) {
            props.onStop();
        } else {
            props.onSend();
        }
    };
    const id = props.testID ?? 'composer';
    // Reply focuses the box, so the keyboard comes up under the new quote; a quote kept in the draft doesn't.
    const inputRef = useRef<TextInputInstance>(null);
    const quotePrefix = props.quote?.quote.prefix ?? null;
    // A `/command` typed after a quote goes as words (the server reads commands only at the start).
    const commandNote = quotedCommand(props.quote?.quote ?? null, props.text) ? QUOTED_COMMAND_NOTE : undefined;
    useAnnouncement(commandNote, { onAppear: true });
    const shownQuote = useRef(quotePrefix);
    useEffect(() => {
        if (quotePrefix !== null && quotePrefix !== shownQuote.current && view.editable) {
            inputRef.current?.focus();
        }
        shownQuote.current = quotePrefix;
    }, [quotePrefix, view.editable]);
    const input = (
        <TextInput
            ref={inputRef}
            testID={`${id}-input`}
            accessibilityLabel={props.inputLabel ?? props.placeholder ?? COMPOSER_PLACEHOLDER}
            value={props.text}
            onChangeText={props.onChangeText}
            selection={props.selection ?? undefined}
            onSelectionChange={
                props.onCaret === undefined ? undefined : (event) => props.onCaret?.(event.nativeEvent.selection.end)
            }
            editable={view.editable}
            multiline
            placeholder={props.placeholder ?? COMPOSER_PLACEHOLDER}
            placeholderTextColor={colors['muted-foreground']}
            // Beside the buttons it takes the row's width (flex-1), unless the paste wrapper
            // around it does: there flex-1 is the wrapper's height, and a box laid out with a
            // height to share (New chat's pinned composer, CB-466) stayed one line tall.
            className={
                stacked
                    ? 'max-h-48 min-h-11 px-1 py-2.5 text-base text-foreground'
                    : cx('max-h-36 min-h-10 px-2 py-2 text-base text-foreground', tray === undefined && 'flex-1')
            }
            style={{
                textAlignVertical: stacked ? 'top' : 'center',
                height: composerInputHeight(Platform.OS, props.text),
            }}
        />
    );
    const toggleMenu = () => {
        tap();
        setMenu(!menu);
    };
    const box = tray ? (
        // Images pasted into the box go to the tray like picked photos (CB-358,
        // expo-paste-input); text pastes as usual. Android takes a keyboard's
        // image (Gboard's clipboard) only on API 31 and later; the edit menu's
        // Paste works on every version.
        <TextInputWrapper
            style={stacked ? undefined : { flex: 1 }}
            onPaste={(payload) => {
                if (payload.type === 'images') {
                    tray.paste(payload.uris);
                }
            }}
        >
            {input}
        </TextInputWrapper>
    ) : (
        input
    );
    const arrow = primary ? 'primary-foreground' : 'white';
    // The stacked box's send is the web's SendButton: 44 pt, the foreground's fill with the
    // background's arrow, primary-disabled at 90% while there is nothing to send.
    const sendButton = (
        <Pressable
            testID={stop ? `${id}-stop` : `${id}-send`}
            accessibilityRole="button"
            accessibilityLabel={stop ? 'Stop' : 'Send'}
            accessibilityState={{ disabled: !view.enabled }}
            disabled={!view.enabled}
            onPress={press}
            hitSlop={2}
            className={cx(
                'items-center justify-center rounded-full',
                stacked ? 'size-11' : 'size-10',
                stop
                    ? 'bg-foreground'
                    : stacked
                      ? view.enabled
                          ? 'bg-foreground active:opacity-90'
                          : 'bg-primary-disabled opacity-90'
                      : !view.enabled
                        ? 'bg-muted'
                        : primary
                          ? 'bg-primary active:bg-primary-hover'
                          : '',
            )}
            style={!stop && view.enabled && !primary && !stacked ? { backgroundColor: mint } : undefined}
        >
            {stop ? (
                <AppSymbol name="square" size={stacked ? 16 : 14} color="background" />
            ) : (
                <AppSymbol
                    name="arrow-up"
                    size={stacked ? 19 : 20}
                    color={stacked ? 'background' : !view.enabled ? 'muted-foreground' : arrow}
                />
            )}
        </Pressable>
    );
    return (
        <View
            className="gap-2 px-3 pt-2"
            style={{ paddingBottom: 8 + (props.bottomInset === false ? 0 : insets.bottom) }}
            onLayout={(event) => props.onHeight?.(event.nativeEvent.layout.height)}
        >
            {notice ? (
                <Text variant="footnote" tone="destructive" className="px-3" testID={`${id}-notice`}>
                    {notice}
                </Text>
            ) : null}
            <GlassSurface
                testID={id}
                radius={stacked ? STACKED_RADIUS : COMPOSER_RADIUS}
                fallbackClassName={stacked ? 'border border-input bg-card' : 'border border-border bg-card'}
                className={stacked ? 'gap-1 px-2 py-1.5' : 'gap-2 p-2'}
            >
                {props.above}
                {tray && menu ? (
                    <AttachMenu
                        onPick={(source) => {
                            setMenu(false);
                            tray.add(source);
                        }}
                    />
                ) : null}
                {tray ? <AttachmentTray tray={tray} /> : null}
                {props.quote ? (
                    <QuoteChip quote={props.quote.quote} onRemove={props.quote.onRemove} testID={`${id}-quote`} />
                ) : null}
                {commandNote === undefined ? null : (
                    <Text
                        variant="footnote"
                        tone="muted"
                        className="px-2"
                        accessibilityLiveRegion="polite"
                        testID={`${id}-quote-command`}
                    >
                        {commandNote}
                    </Text>
                )}
                {stacked ? (
                    <>
                        {box}
                        <View className="flex-row items-center">
                            {tray ? (
                                <ToolButton
                                    icon="paperclip"
                                    label={ATTACH_FILES}
                                    open={menu}
                                    disabled={!view.editable || tray.busy}
                                    onPress={toggleMenu}
                                    testID="composer-attach"
                                />
                            ) : null}
                            <View className="flex-1" />
                            {sendButton}
                        </View>
                    </>
                ) : (
                    <View className="flex-row items-end gap-2">
                        {tray ? (
                            <AttachButton open={menu} disabled={!view.editable || tray.busy} onPress={toggleMenu} />
                        ) : null}
                        {box}
                        {sendButton}
                    </View>
                )}
            </GlassSurface>
            {view.line === null ? null : (
                <Text variant="footnote" tone="muted" className="px-3 text-center" testID={`${id}-line`}>
                    {view.line}
                </Text>
            )}
        </View>
    );
}

/**
 * The quote over the box (CB-571), as Messages' and Slack's: the reply arrow, "Replying to <author>"
 * and a line of the message, and an x that takes it out of the draft. One element for screen readers,
 * then the x ("Remove quote").
 */
function QuoteChip({ quote, onRemove, testID }: { quote: Quote; onRemove: () => void; testID: string }) {
    return (
        <View testID={testID} className="flex-row items-center gap-2 rounded-xl bg-muted pl-3">
            <View
                accessible
                accessibilityLabel={`${replyingTo(quote.author)}: ${quote.excerpt}`}
                className="flex-1 flex-row items-center gap-2 py-2"
            >
                <AppSymbol name="reply" size={16} color="muted-foreground" />
                {/* The author may take two lines (at the largest text sizes); the excerpt one. */}
                <View className="flex-1">
                    <Text variant="footnote" weight="semibold" numberOfLines={2} testID={`${testID}-author`}>
                        {replyingTo(quote.author)}
                    </Text>
                    <Text variant="footnote" tone="muted" numberOfLines={1} testID={`${testID}-excerpt`}>
                        {quote.excerpt}
                    </Text>
                </View>
            </View>
            <Pressable
                testID={`${testID}-remove`}
                accessibilityRole="button"
                accessibilityLabel={REMOVE_QUOTE}
                onPress={onRemove}
                hitSlop={2}
                className="size-11 items-center justify-center rounded-full active:bg-accent"
            >
                <AppSymbol name="x" size={16} color="muted-foreground" />
            </Pressable>
        </View>
    );
}

/** In place of the composer, for a chat the app can't send to. */
export function ReadOnlyLine({ line, bottomInset = true }: { line: string; bottomInset?: boolean }) {
    const insets = useSafeAreaInsets();
    return (
        <View className="p-4" style={{ paddingBottom: 16 + (bottomInset ? insets.bottom : 0) }}>
            <Text variant="subheadline" tone="muted" className="text-center" testID="composer-read-only">
                {line}
            </Text>
        </View>
    );
}

/**
 * The pills' material (CB-457): Liquid Glass on iOS 26, the composer's, so "Jump to latest" and the
 * running turn's phase float over the transcript alike; below iOS 26 and on Android, their token
 * surfaces (Material's tonal one for the button, secondary, with no outline).
 */
export const PILL_RADIUS = 18;
export const JUMP_FALLBACK = 'bg-secondary';
const PHASE_FALLBACK = 'bg-muted';

/**
 * Whether the pills float over the transcript (CB-460): with "Jump to latest" on iOS 26 and later. The
 * footer lies under the list, not over it, so a pill in its flow has only the screen's opaque
 * background behind it, and the glass reads as a solid dark capsule. Floated, the transcript
 * runs behind it and shows through, blurred, as under the bar's buttons. While the list follows, the
 * phase alone stays in the flow, so it never covers the newest row; Android's tonal pills stay there.
 * The phase shows only while the transcript's own running-turn line doesn't (`shownPill`, CB-493).
 */
export const pillsFloat = (pill: StatusPill, glass: boolean) => pill.jump && glass;

export function StatusPillView({ pill, onJump }: { pill: StatusPill; onJump: () => void }) {
    const row = <StatusPillRow pill={pill} onJump={onJump} />;
    if (!pillsFloat(pill, hasLiquidGlass())) {
        return row;
    }
    // No height of its own: the row stands on the composer's top edge, over the transcript's end.
    return (
        <View pointerEvents="box-none" testID="chat-pills-floating">
            <View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0">
                {row}
            </View>
        </View>
    );
}

function StatusPillRow({ pill, onJump }: { pill: StatusPill; onJump: () => void }) {
    return (
        <View className="flex-row items-center justify-center gap-2 px-4 pb-1" pointerEvents="box-none">
            {pill.status === null ? null : <PhaseLabel status={pill.status} shimmer={pill.shimmer} />}
            {pill.jump ? (
                <GlassSurface radius={PILL_RADIUS} fallbackClassName={JUMP_FALLBACK} interactive>
                    <Pressable
                        testID="chat-jump-to-latest"
                        accessibilityRole="button"
                        accessibilityLabel={JUMP_TO_LATEST}
                        onPress={onJump}
                        className="min-h-9 flex-row items-center gap-1.5 px-3 py-2 active:opacity-70"
                    >
                        <AppSymbol
                            name="arrow-down"
                            size={14}
                            color={hasLiquidGlass() ? 'foreground' : 'secondary-foreground'}
                        />
                        <Text variant="footnote" weight="medium" tone={hasLiquidGlass() ? 'default' : 'on-secondary'}>
                            {JUMP_TO_LATEST}
                        </Text>
                    </Pressable>
                </GlassSurface>
            ) : null}
        </View>
    );
}

/** The running turn's phase, a slow shimmer of its words unless Reduce Motion is on. */
function PhaseLabel({ status, shimmer }: { status: string; shimmer: boolean }) {
    const [opacity] = useState(() => new Animated.Value(1));
    useEffect(() => {
        if (!shimmer) {
            opacity.setValue(1);
            return undefined;
        }
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [opacity, shimmer]);
    // The words shimmer, not the glass: a fading glass view draws wrong.
    return (
        <GlassSurface radius={PILL_RADIUS} fallbackClassName={PHASE_FALLBACK}>
            <Animated.View
                testID="chat-phase"
                accessibilityRole="text"
                accessibilityLiveRegion="polite"
                style={{ opacity }}
                className="min-h-9 justify-center px-3 py-2"
            >
                <Text variant="footnote" tone="muted" weight="medium">
                    {status}
                </Text>
            </Animated.View>
        </GlassSurface>
    );
}

const ACTION_LABELS: Record<BubbleAction, string> = {
    retry: 'Retry',
    edit: 'Edit',
    view: 'View',
    'send-now': 'Send now',
    delete: 'Delete',
};

export function PendingBubbleView({
    bubble,
    onAction,
    marked = false,
}: {
    bubble: PendingBubble;
    onAction: (bubble: PendingBubble, action: BubbleAction) => void;
    /** View on an unconfirmed message scrolled here (one still queued on the server): ringed. */
    marked?: boolean;
}) {
    const send = bubble.problem && bubble.actions.includes('send-now') ? 'Send again' : null;
    return (
        <View
            className={cx('max-w-[80%] gap-1 self-end', marked && 'rounded-3xl border-2 border-primary p-1')}
            accessibilityState={marked ? { selected: true } : undefined}
            testID={`chat-${bubble.id.replace(':', '-')}`}
        >
            <MessageAttachments files={bubble.files} testID={`chat-${bubble.id.replace(':', '-')}-files`} />
            {bubble.text.trim() === '' ? null : (
                <View
                    className={cx(
                        'rounded-2xl rounded-br-sm p-3',
                        bubble.problem
                            ? 'border border-destructive bg-user-bubble-pending'
                            : bubble.waiting
                              ? 'border border-dashed border-user-bubble-pending-border bg-user-bubble-pending'
                              : 'bg-user-bubble',
                    )}
                >
                    <MessageText
                        text={bubble.text}
                        surface={bubble.waiting || bubble.problem ? 'pending' : 'own'}
                        selectable
                    />
                </View>
            )}
            {bubble.caption === null && bubble.actions.length === 0 ? null : (
                <View className="flex-row flex-wrap items-center justify-end gap-x-3 gap-y-1">
                    {bubble.caption === null ? null : (
                        <Text
                            variant="footnote"
                            tone={bubble.problem ? 'destructive' : 'muted'}
                            testID={`chat-${bubble.id.replace(':', '-')}-caption`}
                        >
                            {bubble.caption}
                        </Text>
                    )}
                    {bubble.actions.map((action) => (
                        <Pressable
                            key={action}
                            testID={`chat-${bubble.id.replace(':', '-')}-${action}`}
                            accessibilityRole="button"
                            onPress={() => onAction(bubble, action)}
                            className="min-h-9 justify-center rounded-md px-2 active:bg-muted"
                        >
                            <Text variant="footnote" weight="medium" tone="primary">
                                {action === 'send-now' && send !== null ? send : ACTION_LABELS[action]}
                            </Text>
                        </Pressable>
                    ))}
                </View>
            )}
        </View>
    );
}
