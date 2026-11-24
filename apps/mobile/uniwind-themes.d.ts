// uniwind's theme names, for the typecheck: without them uniwind types a theme
// as any string, so `Uniwind.setTheme('drak')` would pass tsc and throw at run
// time ("not registered"), and `useUniwind().theme` would be a string. uniwind
// writes the same declaration whenever Metro compiles global.css, but outside
// the tree (metro.config.js), so this copy is written by hand, and
// tests/metro-config.test.ts holds its list to the one uniwind writes. It is a
// module, unlike uniwind-env.d.ts: an augmentation must be one, and a script's
// `declare module 'uniwind'` would hide the package's own types.
export {};

declare module 'uniwind' {
    export interface UniwindConfig {
        themes: readonly ['light', 'dark'];
    }
}
