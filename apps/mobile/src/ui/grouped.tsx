import { createContext, type ReactNode, use } from 'react';
import { type ColorValue, Platform, PlatformColor, StyleSheet, View } from 'react-native';

import { useColors, useScheme } from '../theme/scheme';

import { ANDROID_GROUPED, type GroupedRole, groupedRadius, IOS_GROUPED } from './grouped-colors';

// Inset grouped lists: the system's grouped colors on iOS,
// Material's surfaces on Android (grouped-colors.ts). A page that is a grouped
// list (Settings, the socio page, an issue) wraps its content in
// `GroupedPage`, which paints the page and tells its sections; a section on
// any other page fills its rows so it still reads as a group, never a border.

const GroupedContext = createContext(false);

/** Whether this content sits on a grouped page. */
export function useOnGroupedPage(): boolean {
    return use(GroupedContext);
}

/** A grouped role's color on this platform and scheme. */
export function useGroupedColor(role: GroupedRole): ColorValue {
    const scheme = useScheme();
    const colors = useColors();
    return Platform.OS === 'ios' ? PlatformColor(IOS_GROUPED[role]) : colors[ANDROID_GROUPED[scheme][role]];
}

/** Marks its content as on a grouped page (its sections' rows take the grouped cell color). */
export function GroupedPage({ children }: { children: ReactNode }) {
    return <GroupedContext value>{children}</GroupedContext>;
}

/** A grouped list's rows: rounded, filled, no border, clipped so a row's pressed state keeps the corners. */
export function GroupedCard({ children, testID }: { children: ReactNode; testID?: string }) {
    const grouped = useOnGroupedPage();
    const background = useGroupedColor(grouped ? 'cell' : 'plainCell');
    return (
        <View
            testID={testID}
            style={{
                backgroundColor: background,
                borderRadius: groupedRadius(Platform.OS),
                borderCurve: 'continuous',
                overflow: 'hidden',
            }}
        >
            {children}
        </View>
    );
}

/** The hairline between two rows, from `inset` points in to the row's end (the system's separator). */
export function RowSeparator({ inset }: { inset: number }) {
    const color = useGroupedColor('separator');
    return (
        <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={{
                position: 'absolute',
                top: 0,
                right: 0,
                left: inset,
                height: StyleSheet.hairlineWidth,
                backgroundColor: color,
            }}
        />
    );
}

/**
 * A page's root view on the grouped background, for a page that lays out its own scroll view (an
 * issue's, under its comment box): `collapsable={false}` as every page root (CB-420), its content
 * marked as on a grouped page.
 */
export function GroupedRoot({ testID, children }: { testID?: string; children: ReactNode }) {
    const background = useGroupedColor('page');
    return (
        <GroupedPage>
            <View testID={testID} className="flex-1" collapsable={false} style={{ backgroundColor: background }}>
                {children}
            </View>
        </GroupedPage>
    );
}
