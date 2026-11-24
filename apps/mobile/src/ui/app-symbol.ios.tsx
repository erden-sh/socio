import { SymbolView } from 'expo-symbols';

import { type AppSymbolProps, LucideSymbol, symbolAccessibility, useSymbolColor } from './symbol-parts';
import { sfSymbolOf } from './symbols';

export type { AppSymbolProps } from './symbol-parts';

// iOS's AppSymbol: the name's SF Symbol through expo-symbols, a
// monochrome UIImage(systemName:) at the weight of the text beside it, in the
// box lucide's icon had (scaled to fit, so a row keeps its layout). A name SF
// Symbols 5 lacks (symbols.ts's `sf: null`) draws lucide's, as Android does.

export function AppSymbol(props: AppSymbolProps) {
    const { name, size = 16, color, weight = 'regular', filled = false, label, testID } = props;
    const tint = useSymbolColor(color);
    const sf = sfSymbolOf(name, filled);
    if (sf === null) {
        return <LucideSymbol {...props} />;
    }
    return (
        <SymbolView
            testID={testID}
            name={sf}
            size={size}
            tintColor={tint}
            weight={weight}
            type="monochrome"
            resizeMode="scaleAspectFit"
            fallback={<LucideSymbol {...props} />}
            {...symbolAccessibility(label)}
        />
    );
}
