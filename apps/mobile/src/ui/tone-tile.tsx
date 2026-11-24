import { useToneColor } from '../theme/native-colors';
import { useScheme } from '../theme/scheme';
import { type TileSurface, theme, type ToneName } from '../theme/theme';

import { AppSymbol } from './app-symbol';
import { Squircle } from './squircle';
import type { SymbolName } from './symbols';

// A module's identity tile (the web's shell/tones.ts): the tone's tint behind
// its icon in the tone's color, which keeps modules findable on Home, in lists
// and on page headers. 44 pt, the size of a tap target, with the
// shape of a squircle (the owner's choice, 2026-11-08) and an icon at half its size, as the web's page headings
// draw theirs: its SF Symbol on iOS at the medium weight (beside a row's
// semibold title), lucide's on Android, and under Increase Contrast on
// iOS the tone's stronger variant. The tint is composited over the
// surface it sits on (theme.json's tiles), the pairs tests/theme/contrast.test.ts checks. Hidden
// from screen readers, as on the web: the row or heading beside it names it.

export interface ToneTileProps {
    readonly tone: ToneName;
    readonly icon: SymbolName;
    /** What it sits on; the screen by default. */
    readonly surface?: TileSurface;
    /** Its side in points: 44 by default; a page's first line takes a smaller one (CB-420). */
    readonly size?: number;
    readonly testID?: string;
}

export function ToneTile({ tone, icon, surface = 'screen', size = 44, testID }: ToneTileProps) {
    const { tiles } = theme[useScheme()].tones[tone];
    const foreground = useToneColor(tone);
    return (
        <Squircle size={size} color={tiles[surface]} testID={testID}>
            <AppSymbol name={icon} size={size / 2} weight="medium" color={{ value: foreground }} />
        </Squircle>
    );
}
