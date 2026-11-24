import { type AppSymbolProps, LucideSymbol } from './symbol-parts';

export type { AppSymbolProps } from './symbol-parts';

// An icon by the app's name for it (symbols.ts): this file draws lucide's,
// as Android's Material components and its tab bar do; app-symbol.ios.tsx
// draws the SF Symbol, which Metro picks on iOS (T3 Code's AppSymbol.tsx and
// .ios.tsx). Both take the same props, so a screen names an icon once.
// Decorative unless it has a label, as the web's aria-hidden icons are. An icon
// that is a tap target goes in a Button (iconOnly), which makes it 44 pt.

export function AppSymbol(props: AppSymbolProps) {
    return <LucideSymbol {...props} />;
}
