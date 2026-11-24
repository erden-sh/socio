import { StackActions, useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import { characterFor, type LocalId } from '@socio/shared/mascot';

import { useRootGate } from '../navigation/root-gate';
import { wayOut } from '../navigation/routes';
import { type ToneName } from '../theme/theme';

import { Button } from './button';
import { LOCAL_ART_MAX } from './local-art';
import { LocalAvatar } from './local-avatar';
import type { SymbolName } from './symbols';
import { Text } from './text';
import { ToneTile } from './tone-tile';

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
