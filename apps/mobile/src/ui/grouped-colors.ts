import type { ColorToken } from '../theme/theme';

// The colors of a grouped list, under Node. iOS draws its inset
// grouped lists on the system's grouped colors, which follow Light, Dark and
// Increase Contrast by themselves: the page on systemGroupedBackground, the
// rows on secondarySystemGroupedBackground, and no border, only the system's
// separator between rows, inset to the text. A list on a plain page (one not
// made grouped yet) fills its rows with secondarySystemBackground instead, so
// they still read as a group without a border. Android takes Material 3's
// surfaces from the web's tokens: rows on the card over a muted page in Light,
// the secondary over the screen in Dark.

export type GroupedRole = 'page' | 'cell' | 'plainCell' | 'separator';

/** iOS's semantic color for each role (UIColor's names, for PlatformColor). */
export const IOS_GROUPED: Readonly<Record<GroupedRole, string>> = {
    page: 'systemGroupedBackground',
    cell: 'secondarySystemGroupedBackground',
    plainCell: 'secondarySystemBackground',
    separator: 'separator',
};

/** Android's token for each role, per scheme. */
export const ANDROID_GROUPED: Readonly<Record<'light' | 'dark', Readonly<Record<GroupedRole, ColorToken>>>> = {
    light: { page: 'muted', cell: 'card', plainCell: 'muted', separator: 'border' },
    dark: { page: 'screen', cell: 'secondary', plainCell: 'secondary', separator: 'border' },
};

/** A grouped list's corner radius: near iOS 26's inset grouped cells (26) for our 12 pt padding, Material 3's large shape. */
export function groupedRadius(os: string): number {
    return os === 'ios' ? 24 : 16;
}

/** The space at a row's start (12 pt, even on every side: the owner, 2026-11-08), and so where a separator starts. */
export const ROW_INSET = 12;
export const ROW_GAP = 12;

/** Where a row's separator starts: at the text, past the leading item when the row has one (Messages, Settings). */
export function separatorInset(leading: number | null): number {
    return leading === null ? ROW_INSET : ROW_INSET + leading + ROW_GAP;
}
