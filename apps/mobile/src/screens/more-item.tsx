import type { StaticScreenProps } from '@react-navigation/native';
import { View } from 'react-native';

import { useNativeBar } from '../navigation/native-bar';
import { isMoreItem, type MoreItem } from '../navigation/tabs';
import { moduleEntry } from '../shell/modules';
import { Screen, Text, ToneTile } from '../ui';

import { MODULE_ICONS } from './module-icons';

// A More row's module, pushed over the tabs: a placeholder showing
// where it lives until its screens come. Its title is its module's label, from
// its params, so it draws the app's header itself (header-bar.tsx). Every More
// row has its own screen now (Memories, Scheduled & activity, Learning and
// Runs), so only a row a later build
// adds before its screen lands comes here.

export function MoreItemScreen({ route }: StaticScreenProps<{ id: MoreItem; label: string }>) {
    const { id, label } = route.params;
    const entry = isMoreItem(id) ? moduleEntry(id) : null;
    useNativeBar({ title: label });
    return (
        <View testID="more-item-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen centered edges={['right', 'bottom', 'left']}>
                {entry === null ? null : <ToneTile tone={entry.tone} icon={MODULE_ICONS[entry.icon]} />}
                <Text accessibilityRole="header" variant="heading" className="text-center">
                    {label}
                </Text>
                <Text variant="subheadline" tone="muted" className="text-center">
                    This lives here, in More. It comes in a later release.
                </Text>
            </Screen>
        </View>
    );
}
