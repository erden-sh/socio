import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';

import type { LocalId } from '@socio/shared/mascot';

import {
    useClientCompat,
    useSessionState,
    useSyncStatus,
    useVersionGate,
    useViewState,
    useWorkspaceScope,
} from '../live';
import { introTile, MODULE_TONE_PLACE } from '../navigation/bar-items';
import { chatAction } from '../navigation/tabs';
import { signInAgain } from '../platform/session';
import { UPDATE_DISMISS_LABEL, updateBannerCopy } from '../shell/client-update';
import type { SocioState } from '../shell/home';
import {
    type issueScreen,
    LAST_SCREEN_KEY,
    type ShellScreen,
    type pageScreen,
    type spaceScreen,
} from '../shell/last-screen';
import { EXPIRED_BANNER, SIGN_IN_AGAIN, UPDATE_BANNER } from '../shell/session';
import type { ToneName } from '../theme/theme';
import {
    Banner,
    GroupedCard,
    LocalAvatar,
    RowSeparator,
    rowMinHeight,
    separatorInset,
    stacksAccessory,
    Text,
    type TextVariant,
    ToneTile,
} from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

// The parts the shell's screens share: the status banners, list
// rows and sections, a socio's avatar and state, and the last screen.

/**
 * The workspace's state over a tab's content: Expired, with Sign in;
 * the update banner while the minimum-version gate is closed (the server is too old); the
 * newer-app banner while this app is below the version the server recommends, until dismissed for
 * that version (CB-553; below the minimum, Update Socio shows instead of the tabs); "Reconnecting…"
 * while the server is away (the scheduler's status), unless Expired says more.
 */
export function StatusBanners() {
    const scope = useWorkspaceScope();
    const status = useSyncStatus();
    const expired = useSessionState() === 'expired';
    const outdated = useVersionGate() === 'closed';
    const { recommended } = useClientCompat();
    return (
        <>
            {expired ? (
                <Banner
                    tone="warning"
                    testID="session-expired"
                    action={{ label: SIGN_IN_AGAIN, onPress: () => signInAgain(scope.workspace) }}
                >
                    {EXPIRED_BANNER}
                </Banner>
            ) : null}
            {outdated ? (
                <Banner tone="info" testID="update-needed">
                    {UPDATE_BANNER}
                </Banner>
            ) : null}
            {recommended === null ? null : (
                <Banner
                    tone="info"
                    testID="update-recommended"
                    action={{ label: UPDATE_DISMISS_LABEL, onPress: () => scope.compat.dismiss() }}
                >
                    {updateBannerCopy(recommended)}
                </Banner>
            )}
            {status.reconnecting && !expired ? (
                <Banner tone="warning" testID="reconnecting">
                    Reconnecting…
                </Banner>
            ) : null}
        </>
    );
}

/**
 * Search's big title (the web's PageHeader, `views/WorkspacePage.tsx`; the one page with no bar of
 * its own until its tab gets a stack): the module's tone tile when
 * it has one ("module tones stay on page headers"), the title in the `title` role, the line
 * under it, and an action beside it. The tile sits at the top when the line wraps, as the web's does
 * on a phone, and is hidden from screen readers (ToneTile): the title names the page.
 */
export function PageHeader(props: {
    title: string;
    subtitle: string | null;
    /** Lines of the subtitle at most; 1 by default, 0 for all of it (a description). */
    subtitleLines?: number;
    tile?: { readonly tone: ToneName; readonly icon: SymbolName };
    action?: ReactNode;
    testID?: string;
}) {
    const lines = props.subtitleLines ?? 1;
    return (
        <View className="flex-row items-center gap-3" testID={props.testID}>
            {props.tile === undefined ? null : (
                <View className={lines === 1 ? undefined : 'self-start'}>
                    <ToneTile tone={props.tile.tone} icon={props.tile.icon} />
                </View>
            )}
            <View className="min-w-0 flex-1 gap-0.5">
                <Text accessibilityRole="header" variant="title" testID={props.testID && `${props.testID}-title`}>
                    {props.title}
                </Text>
                {props.subtitle === null ? null : (
                    <Text
                        variant="subheadline"
                        tone="muted"
                        numberOfLines={lines === 0 ? undefined : lines}
                        testID={props.testID && `${props.testID}-subtitle`}
                    >
                        {props.subtitle}
                    </Text>
                )}
            </View>
            {props.action}
        </View>
    );
}

/**
 * A module page's first line, under its large title (CB-420): the line the web's PageHeader has
 * under its title (the counts, the page's intro), muted. The title is the bar's now, and the
 * module's tone goes where MODULE_TONE_PLACE says: with `intro`, a small tone tile leads this
 * line. Nothing when there is neither.
 */
export function PageIntro(props: {
    subtitle: string | null;
    /** Lines of the subtitle at most; 1 by default, 0 for all of it (a description). */
    subtitleLines?: number;
    tile?: { readonly tone: ToneName; readonly icon: SymbolName };
    testID?: string;
}) {
    const lines = props.subtitleLines ?? 1;
    const tile = props.tile !== undefined && introTile(MODULE_TONE_PLACE) ? props.tile : undefined;
    if (props.subtitle === null && tile === undefined) {
        return null;
    }
    return (
        <View className="flex-row items-center gap-2.5" testID={props.testID}>
            {tile === undefined ? null : (
                <View
                    className={lines === 1 ? undefined : 'self-start'}
                    testID={props.testID && `${props.testID}-tile`}
                >
                    <ToneTile tone={tile.tone} icon={tile.icon} size={INTRO_TILE} />
                </View>
            )}
            {props.subtitle === null ? null : (
                <Text
                    variant="subheadline"
                    tone="muted"
                    className="min-w-0 flex-1"
                    numberOfLines={lines === 0 ? undefined : lines}
                    testID={props.testID && `${props.testID}-subtitle`}
                >
                    {props.subtitle}
                </Text>
            )}
        </View>
    );
}

/** The tone tile that leads a page's first line (`intro`), in points. */
const INTRO_TILE = 28;

/** Keeps `screen` as the workspace's last screen each time it comes into view. */
export function useRememberScreen(
    screen:
        | ShellScreen
        | ReturnType<typeof spaceScreen>
        | ReturnType<typeof pageScreen>
        | ReturnType<typeof issueScreen>,
): void {
    const viewState = useViewState();
    useFocusEffect(
        useCallback(() => {
            viewState.set(LAST_SCREEN_KEY, screen);
        }, [viewState, screen]),
    );
}

/**
 * Opens a chat or a room from a row: its history starts
 * loading from disk at once (`preload`), then the Chat route
 * pushes over the tabs.
 */
export function useOpenChat(): (chat: { readonly id: string; readonly room: boolean }) => void {
    const { histories } = useWorkspaceScope();
    const navigation = useNavigation();
    return (chat) => {
        histories.preload(chat.id).catch((error: unknown) => console.warn('[chat] not read from disk', error));
        navigation.dispatch(chatAction(chat.id));
    };
}

/**
 * A section of an inset grouped list: its heading over the rows, as iOS's Settings and
 * Material's lists draw one. The rows sit in a rounded group on the system's grouped colors, with no
 * border (`GroupedCard`); a `footer` (what the section's switches mean, a note) under them, muted, as
 * iOS's section footers.
 */
export function Section(props: { title: string; testID?: string; footer?: string | null; children: ReactNode }) {
    return (
        <View className="gap-2" testID={props.testID}>
            <Text accessibilityRole="header" variant="section" className="px-3">
                {props.title}
            </Text>
            <GroupedCard>{props.children}</GroupedCard>
            {props.footer === undefined || props.footer === null ? null : (
                <Text
                    variant="footnote"
                    tone="muted"
                    className="px-3"
                    testID={props.testID && `${props.testID}-footer`}
                >
                    {props.footer}
                </Text>
            )}
        </View>
    );
}

/** A row of a list: what leads it, its title and line under it, and what ends it. One element for screen readers. */
export function ListRow(props: {
    title: string;
    /** The title's role: a Headline for a socio, module, page or issue row by default; a chat's is the Body. */
    titleVariant?: Extract<TextVariant, 'row-title' | 'chat-title'>;
    subtitle?: string | null;
    /** Lines of the subtitle at most; 1 by default. */
    subtitleLines?: number;
    /** A last line under the subtitle: meta, such as a page's "Edited Nov 10" (`variant="meta"`). */
    meta?: ReactNode;
    leading?: ReactNode;
    /** The leading item's height in points (a SocioAvatar's 40 by default; a ToneTile is 44, an Icon 20). */
    leadingSize?: number;
    trailing?: ReactNode;
    /** Beside the title, at the end of its line (a chat's time). */
    titleTrailing?: ReactNode;
    /** Beside the subtitle, at the end of its line (a chat's marks). */
    subtitleTrailing?: ReactNode;
    accessibilityLabel: string;
    accessibilityHint?: string;
    onPress?: () => void;
    /** A long-press menu, whose items are also the row's accessibility actions. */
    onLongPress?: () => void;
    accessibilityActions?: readonly { readonly name: string; readonly label: string }[];
    onAccessibilityAction?: (name: string) => void;
    first?: boolean;
    testID?: string;
}) {
    // At the accessibility sizes the trailing accessory goes under the text, so the title keeps the width.
    const stacked = stacksAccessory(useWindowDimensions().fontScale) && props.trailing !== undefined;
    const body = (
        <>
            {props.leading}
            <View className="min-w-0 flex-1 gap-0.5">
                <View className="flex-row items-center gap-2">
                    <Text variant={props.titleVariant ?? 'row-title'} numberOfLines={1} className="min-w-0 shrink grow">
                        {props.title}
                    </Text>
                    {props.titleTrailing}
                </View>
                {(props.subtitle === undefined || props.subtitle === null) &&
                props.subtitleTrailing === undefined ? null : (
                    <View className="flex-row items-center gap-2">
                        <Text
                            variant="row-subtitle"
                            numberOfLines={props.subtitleLines ?? 1}
                            className="min-w-0 shrink grow"
                        >
                            {props.subtitle ?? ''}
                        </Text>
                        {props.subtitleTrailing}
                    </View>
                )}
                {props.meta}
                {stacked ? <View className="flex-row">{props.trailing}</View> : null}
            </View>
            {stacked ? null : props.trailing}
        </>
    );
    const row = 'flex-row items-center gap-3 p-3';
    // The hairline between rows starts at the text, past the leading item (Messages', Settings').
    const separator =
        props.first === true ? null : (
            <RowSeparator inset={separatorInset(props.leading === undefined ? null : (props.leadingSize ?? 40))} />
        );
    // 12 pt above and below the leading item, the same as at the sides, so the
    // padding is even (owner, 2026-11-08); never under a 44 pt target. Only a
    // minimum: a title, a two-line excerpt and a meta line need more than the
    // leading item's height, and the row grows to hold them (CB-373).
    const height = rowMinHeight(Math.max(44, (props.leadingSize ?? 40) + 24));
    return props.onPress === undefined ? (
        <View
            testID={props.testID}
            accessible
            accessibilityLabel={props.accessibilityLabel}
            className={row}
            style={height}
        >
            {separator}
            {body}
        </View>
    ) : (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            accessibilityHint={props.accessibilityHint}
            onPress={props.onPress}
            onLongPress={props.onLongPress}
            accessibilityActions={
                props.accessibilityActions === undefined ? undefined : [...props.accessibilityActions]
            }
            onAccessibilityAction={(event) => props.onAccessibilityAction?.(event.nativeEvent.actionName)}
            className={cx(row, 'active:bg-accent')}
            style={height}
        >
            {separator}
            {body}
        </Pressable>
    );
}

/** A socio's avatar: its Local, the web's mascot (40 pt in a row; Home's socio rows 56, the web's). Hidden from screen readers. */
export function SocioAvatar({ character, size = 40 }: { character: LocalId; size?: number }) {
    return <LocalAvatar character={character} size={size} />;
}

const STATE_DOT = {
    idle: 'bg-muted-foreground/70',
    working: 'bg-primary',
    paused: 'bg-amber-500 dark:bg-amber-400',
} as const satisfies Record<SocioState, string>;

/**
 * A socio's state as a word with its dot (the web's DotStateLabel): the word always stays beside the
 * color. In the system font, not the web's mono (CB-431: status text is the platform's text style).
 */
export function SocioStateLabel({ state, label }: { state: SocioState; label: string }) {
    return (
        <View className="min-w-0 flex-row items-center gap-1.5">
            <View className={cx('size-1.5 rounded-full', STATE_DOT[state])} />
            <Text variant="footnote" tone="muted" numberOfLines={1} className="min-w-0 shrink">
                {label}
            </Text>
        </View>
    );
}

/** A count at the end of a row: a room's unread. */
export function CountBadge({ label }: { label: string }) {
    return (
        <View className="min-w-5 items-center rounded-full bg-primary px-1.5">
            <Text variant="caption1" weight="medium" tone="on-primary">
                {label}
            </Text>
        </View>
    );
}
