import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TABS } from '../../src/navigation/tabs';
import { MENU_SYMBOLS } from '../../src/shell/native-menu';
import { sfSymbolOf, type SymbolName, SYMBOLS } from '../../src/ui/symbols';

// AppSymbol's table (src/ui/symbols.ts): every SF Symbol it, the menus,
// the bars and the tab bar name exists in SF Symbols 5 (iOS 17.4, the
// deployment target: a newer name draws nothing there), every name has its
// lucide icon, and nothing in src/ imports lucide outside the glyph table.

const app = join(import.meta.dirname, '../..');
const src = join(app, 'src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file));

/** Each SF Symbol's first version, from sf-symbols-typescript (expo-symbols' own list). */
function sfVersions(): Map<string, number> {
    // expo-symbols' own dependency, found from it as Metro would.
    const expoSymbols = createRequire(join(app, 'package.json')).resolve('expo-symbols/package.json');
    const types = join(
        dirname(createRequire(expoSymbols).resolve('sf-symbols-typescript/package.json')),
        'dist/index.d.ts',
    );
    const versions = new Map<string, number>();
    let current: number | null = null;
    for (const line of readFileSync(types, 'utf8').split('\n')) {
        const block = /^export type SFSymbols(\d+)_(\d+) =/.exec(line);
        if (block) {
            current = Number(`${block[1]}.${block[2]}`);
            continue;
        }
        const name = /^\s*\| '([^']+)'/.exec(line);
        if (name && current !== null && !versions.has(name[1]!)) {
            versions.set(name[1]!, current);
        }
    }
    return versions;
}

/** SF Symbols 5.x came with iOS 17. */
const DEPLOYMENT_SF = 5.9;

describe('the app’s symbols', () => {
    const versions = sfVersions();
    const valid = (name: string) => (versions.get(name) ?? Infinity) <= DEPLOYMENT_SF;

    it('reads SF Symbols’ list', () => {
        expect(versions.get('house')).toBe(1);
        expect(versions.get('flask')).toBe(5);
    });

    it('names SF Symbols that iOS 17.4 has, for AppSymbol, the menus, the bars and the tabs', () => {
        for (const [name, spec] of Object.entries(SYMBOLS)) {
            if (spec.sf !== null) {
                expect(valid(spec.sf), `${name}: ${spec.sf}`).toBe(true);
            }
            if ('fill' in spec) {
                expect(valid(spec.fill), `${name}: ${spec.fill}`).toBe(true);
            }
        }
        for (const [action, symbol] of Object.entries(MENU_SYMBOLS)) {
            expect(valid(symbol), `${action}: ${symbol}`).toBe(true);
        }
        for (const tab of Object.values(TABS)) {
            for (const symbol of tab.sfSymbol === null ? [] : [tab.sfSymbol.normal, tab.sfSymbol.selected]) {
                expect(valid(symbol), symbol).toBe(true);
            }
        }
        const barSymbols = sources.flatMap((file) =>
            [...read(file).matchAll(/\bsymbol: '([a-z0-9.]+)'/g)].map((m) => m[1]!),
        );
        expect(barSymbols.length).toBeGreaterThan(5);
        for (const symbol of barSymbols) {
            expect(valid(symbol), symbol).toBe(true);
        }
    });

    it('draws a bar button’s Android icon as the same thing as its iOS symbol', () => {
        for (const file of sources) {
            for (const m of read(file).matchAll(/\bsymbol: '([a-z0-9.]+)',\s+icon: '([a-z0-9-]+)'/g)) {
                expect(sfSymbolOf(m[2] as SymbolName), `${file}: ${m[2]}`).toBe(m[1]);
            }
        }
    });

    it('keeps lucide for what SF Symbols lacks, and fills a chosen vote', () => {
        expect(sfSymbolOf('bot')).toBeNull();
        expect(sfSymbolOf('heading-1')).toBeNull();
        expect(sfSymbolOf('thumbs-up', true)).toBe('hand.thumbsup.fill');
        expect(sfSymbolOf('thumbs-up')).toBe('hand.thumbsup');
        // The menus' symbol for the same thing is AppSymbol's.
        expect(sfSymbolOf('copy')).toBe(MENU_SYMBOLS.copy);
        expect(sfSymbolOf('archive')).toBe(MENU_SYMBOLS.archive);
        expect(sfSymbolOf('pencil')).toBe(MENU_SYMBOLS.rename);
        expect(sfSymbolOf('trash-2')).toBe(MENU_SYMBOLS.delete);
        expect(sfSymbolOf('wrench')).toBe(MENU_SYMBOLS['react:needs-work']);
    });

    it('has lucide’s icon for every name, imported one module each in the glyph table', () => {
        const glyphs = read('ui/symbol-glyphs.ts');
        const lucide = join(app, 'node_modules/lucide-react-native/dist/esm/icons');
        for (const name of Object.keys(SYMBOLS)) {
            expect(existsSync(join(lucide, `${name}.mjs`)), name).toBe(true);
            expect(glyphs).toMatch(new RegExp(`import (\\w+) from 'lucide-react-native/icons/${name}';`));
        }
    });

    it('imports lucide only in the glyph table: every other icon goes through AppSymbol', () => {
        const importers = sources.filter((file) => /from 'lucide-react-native\/icons\//.test(read(file)));
        expect(importers).toEqual(['ui/symbol-glyphs.ts']);
        expect(sources.filter((file) => /\bIcon\b.*from '\.\/icon'|ui\/icon'/.test(read(file)))).toEqual([]);
    });

    it('draws SF Symbols through expo-symbols on iOS only, so Android’s bundle never takes its font', () => {
        expect(read('ui/app-symbol.ios.tsx')).toContain("import { SymbolView } from 'expo-symbols';");
        const others = sources.filter(
            (file) => file !== 'ui/app-symbol.ios.tsx' && /from 'expo-symbols'/.test(read(file)),
        );
        // symbols.ts takes only the SFSymbol type.
        expect(others).toEqual(['ui/symbols.ts']);
        expect(read('ui/symbols.ts')).toContain("import type { SFSymbol } from 'expo-symbols';");
        expect(read('ui/app-symbol.tsx')).not.toContain('expo-symbols');
        // A name with no SF Symbol, or no native view, draws lucide's on iOS too.
        expect(read('ui/app-symbol.ios.tsx')).toMatch(
            /if \(sf === null\) \{\s+return <LucideSymbol \{\.\.\.props\} \/>;/,
        );
        expect(read('ui/app-symbol.ios.tsx')).toContain('fallback={<LucideSymbol {...props} />}');
    });
});
