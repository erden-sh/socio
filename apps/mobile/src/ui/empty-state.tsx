import { StackActions, useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { type LayoutChangeEvent, Platform, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { characterFor, type LocalId } from '@socio/shared/mascot';

import { useBarInset } from '../navigation/bar-inset';
import { useRootGate } from '../navigation/root-gate';
import { wayOut } from '../navigation/routes';
import { type ToneName } from '../theme/theme';

import { AppSymbol } from './app-symbol';
import { Button } from './button';
import { LOCAL_ART_MAX } from './local-art';
import { LocalAvatar } from './local-avatar';
import { emptyFill, fillCovers } from './screen-insets';
import { CLEAR_FILTERS, CLEAR_SEARCH, SEARCH_EMPTY_SYMBOL, type SearchEmptyView } from './search-empty';
import type { SymbolName } from './symbols';
import { Text } from './text';
import { ToneTile } from './tone-tile';
import { useAnnouncement } from './use-announcement';

// A screen with nothing to show (the web's EmptyPage and LibraryEmpty):
// a Local, or a module's tile where the web draws an icon ("No pages yet"), a
// bold headline, a line or two, and a way on: back where the person came from,
// or a primary action such as New page. One look for a page, an issue or a Space
// that's missing or empty. The Local is the web's default mascot
// (`characterFor()`, the flamingo) at the largest size its art is drawn, so it
// stays sharp (local-art.ts). The block is a status: a screen reader reads it as one.

/** The web's NotFound line, for a page or Space that's gone or not shared. */
export const NOT_SHARED_LINE = 'It may have been removed, or it isn’t shared with you.';

/** The web's way back from a not-found page: to Home, which lists the socios. */
export const BACK_TO_SOCIOS = 'Back to your socios';

export interface EmptyStateAction {
    readonly label: string;
    readonly onPress: () => void;
    /** `primary` for something to make (New page); the quiet `ghost` for a way back. */
    readonly variant?: 'primary' | 'ghost';
    readonly testID?: string;
}

export interface EmptyStateProps {
    readonly headline: string;
    readonly line?: string | null;
    /** A module's tile in place of the Local, as the web's empty lists draw an icon. */
    readonly tile?: { readonly tone: ToneName; readonly icon: SymbolName };
    /** Which Local stands over it; the web's default mascot unless given. */
    readonly local?: LocalId;
    readonly action?: EmptyStateAction | null;
    readonly testID?: string;
}

export function EmptyState({ headline, line = null, tile, local, action = null, testID }: EmptyStateProps) {
    return (
        <View className="items-center gap-3 px-4 py-10" testID={testID}>
            {tile === undefined ? (
                <LocalAvatar character={local ?? characterFor()} size={LOCAL_ART_MAX} testID="empty-state-local" />
            ) : (
                <ToneTile tone={tile.tone} icon={tile.icon} testID="empty-state-tile" />
            )}
            <View accessible accessibilityRole="summary" className="items-center gap-1">
                <Text accessibilityRole="header" variant="title2" weight="bold" className="text-center">
                    {headline}
                </Text>
                {line === null ? null : (
                    <Text variant="subheadline" tone="muted" className="text-center">
                        {line}
                    </Text>
                )}
            </View>
            {action === null ? null : (
                <Button
                    label={action.label}
                    variant={action.variant ?? 'ghost'}
                    onPress={action.onPress}
                    testID={action.testID ?? 'empty-state-action'}
                />
            )}
        </View>
    );
}

/**
 * The way back from a screen with nothing on it: Back where the stack has a
 * screen under it, else the web's "Back to your socios" to the gate's root
 * (Home), as the error screen leaves (routes.ts's wayOut). Null where the
 * screen is the root itself.
 */
export function useWayBack(route: string): EmptyStateAction | null {
    const navigation = useNavigation();
    const exit = wayOut(route, navigation.canGoBack(), useRootGate());
    if (exit === null) {
        return null;
    }
    return exit === 'back'
        ? { label: 'Go back', onPress: () => navigation.goBack(), testID: 'empty-state-back' }
        : {
              label: BACK_TO_SOCIOS,
              onPress: () => navigation.dispatch(StackActions.replace(exit)),
              testID: 'empty-state-back',
          };
}

export interface SearchEmptyStateProps {
    /** `searchEmpty()`'s title, line and actions. */
    readonly view: SearchEmptyView;
    /** Empties the field and keeps the focus in it; offered while something is typed. */
    readonly onClearSearch: () => void;
    /** Turns the filters off; offered while some are on. */
    readonly onClearFilters?: () => void;
    /** `useEmptyFill`'s, to center it in what shows of the screen; none: its own height. */
    readonly fill?: EmptyFill;
    readonly testID: string;
}

/**
 * A search or filter that matched nothing (CB-552; search-empty.ts): a magnifying glass, the title
 * and a muted line, read by a screen reader as one element and announced once as it appears, then
 * Clear search and Clear filters as real buttons. iOS's ContentUnavailableView.search in the app's
 * type, Material's empty state on Android.
 */
export function SearchEmptyState({ view, onClearSearch, onClearFilters, fill, testID }: SearchEmptyStateProps) {
    // Said once as it shows: the announcement stays the same while more is typed (search-empty.ts).
    useAnnouncement(view.announcement, { onAppear: true, shown: false });
    return (
        <View
            className="items-center justify-center gap-4 px-4 py-8"
            style={fill?.minHeight == null ? undefined : { minHeight: fill.minHeight }}
            onLayout={
                fill === undefined ? undefined : (event: LayoutChangeEvent) => fill.onPlace(event.nativeEvent.layout.y)
            }
            testID={testID}
        >
            <View
                accessible
                accessibilityRole="summary"
                accessibilityLabel={view.accessibilityLabel}
                className="items-center gap-2"
                testID={`${testID}-text`}
            >
                <AppSymbol name={SEARCH_EMPTY_SYMBOL} size={44} color="muted-foreground" />
                <Text variant="title2" weight="bold" className="text-center">
                    {view.title}
                </Text>
                <Text variant="subheadline" tone="muted" className="text-center">
                    {view.line}
                </Text>
            </View>
            {view.clearSearch || (view.clearFilters && onClearFilters !== undefined) ? (
                <View className="flex-row flex-wrap justify-center gap-2">
                    {view.clearSearch ? (
                        <Button
                            label={CLEAR_SEARCH}
                            variant="tinted"
                            onPress={onClearSearch}
                            testID={`${testID}-clear`}
                        />
                    ) : null}
                    {view.clearFilters && onClearFilters !== undefined ? (
                        <Button
                            label={CLEAR_FILTERS}
                            variant="tinted"
                            onPress={onClearFilters}
                            testID={`${testID}-clear-filters`}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

/** What `useEmptyFill` hands the screen and its empty state. */
export interface EmptyFill {
    /** The keyboard's height while it is up, else 0: the Screen's `keyboardInset` on iOS. */
    readonly keyboard: number;
    /** The empty state's height, to center it in what shows; null until the screen has laid out. */
    readonly minHeight: number | null;
    /** The Screen's `onFrameHeight`. */
    readonly onFrameHeight: (height: number) => void;
    /** Where the empty state starts in the content. */
    readonly onPlace: (y: number) => void;
}

/**
 * Centers a screen's empty state in what shows of it (CB-552): below iOS's bar (`useBarInset`), above
 * the home indicator, the Search tab's bottom bar (`searchTab`) or the keyboard.
 */
export function useEmptyFill(searchTab: boolean): EmptyFill {
    const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
    const top = useBarInset();
    const insets = useSafeAreaInsets();
    const [frame, setFrame] = useState(0);
    const [above, setAbove] = useState<number | null>(null);
    const covers = fillCovers(Platform.OS, { safeBottom: insets.bottom, keyboard, searchTab });
    return {
        keyboard,
        minHeight: frame === 0 || above === null ? null : emptyFill({ frame, top, covers, above }),
        onFrameHeight: setFrame,
        onPlace: setAbove,
    };
}
