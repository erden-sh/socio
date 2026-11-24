import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createMemoryRootState, NO_WORKSPACE, type RootState } from '../src/navigation/root-gate';
import { ROUTE_NAMES, ROUTES, routeInVariant, staticScreens } from '../src/navigation/routes';
import { VARIANTS, type VariantName } from '../variant';
import { parseImports, PLATFORM_EXTENSION_ORDER, resolveRelative } from '../vendor/t3code/dependency-graph';

// The store's Diagnostics screen is for development and preview
// builds: a production build never mounts it. Its route isn't in production's
// root stack (so no screen, no link path, nothing to navigate to), the only
// way to its component is that route, and the placeholders offer it only where
// the route is.

vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const src = join(import.meta.dirname, '../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const NAMES = Object.keys(VARIANTS) as VariantName[];
const stand = Object.fromEntries(ROUTE_NAMES.map((name) => [name, () => null])) as never;

/** The screens a build of `variant` mounts, while the gate is in `state`. */
function mounted(variant: VariantName, state: RootState): string[] {
    const source = createMemoryRootState(state);
    return Object.entries(staticScreens(stand, variant, source))
        .filter(([, screen]) => screen.if())
        .map(([name]) => name);
}

/** The files under src/ that load `target` (a path under src/), by a relative import. */
// Every source file's resolved imports, parsed once: walking and parsing src for each
// importersOf call ran this test past its timeout on a loaded machine.
let importsByFile: Map<string, (string | null)[]> | undefined;

function importersOf(target: string): string[] {
    const imports = (importsByFile ??= new Map(
        readdirSync(src, { recursive: true, encoding: 'utf8' })
            .filter((file) => /\.tsx?$/.test(file))
            .map((file) => [
                file.split(sep).join('/'),
                parseImports(read(file), join(src, file)).map(({ specifier }) =>
                    resolveRelative(src, join(src, file), specifier, PLATFORM_EXTENSION_ORDER.android),
                ),
            ]),
    ));
    return [...imports]
        .filter(([, resolved]) => resolved.includes(join(src, target)))
        .map(([file]) => file)
        .sort();
}

describe('Diagnostics', () => {
    it('is a route of development and preview builds only', () => {
        expect(ROUTES.Diagnostics.variants).toEqual(['development', 'preview']);
        expect(NAMES.filter((name) => routeInVariant('Diagnostics', name))).toEqual(['development', 'preview']);
        // So is the editor's round trip; every other route is in every build.
        expect(ROUTES.EditorCorpus.variants).toEqual(['development', 'preview']);
        // And the dataset views' fixtures (CB-469).
        expect(ROUTES.DatasetPreview.variants).toEqual(['development', 'preview']);
        const testOnly: readonly string[] = ['Diagnostics', 'EditorCorpus', 'DatasetPreview'];
        for (const name of ROUTE_NAMES.filter((route) => !testOnly.includes(route))) {
            expect(
                NAMES.every((variant) => routeInVariant(name, variant)),
                name,
            ).toBe(true);
        }
    });

    it('is never in a production build’s root stack, whatever the gate shows', () => {
        expect(Object.keys(staticScreens(stand, 'production'))).not.toContain('Diagnostics');
        expect(Object.keys(staticScreens(stand, 'production'))).not.toContain('EditorCorpus');
        for (const state of [
            NO_WORKSPACE,
            { active: { id: 'a', locked: false } },
            { active: { id: 'a', locked: true } },
        ]) {
            expect(mounted('production', state)).not.toContain('Diagnostics');
            expect(mounted('production', state)).not.toContain('EditorCorpus');
        }
    });

    it('opens in development and preview builds from Add workspace and the shell, never past the lock screen', () => {
        for (const variant of ['development', 'preview'] as const) {
            expect(mounted(variant, NO_WORKSPACE), variant).toContain('Diagnostics');
            expect(mounted(variant, { active: { id: 'a', locked: false } }), variant).toContain('Diagnostics');
            expect(mounted(variant, { active: { id: 'a', locked: true } }), variant).toEqual(['Lock']);
        }
    });

    it('is reached only through its route: the root stack alone loads the screen, and only the screen its checks', () => {
        expect(importersOf('screens/diagnostics.tsx')).toEqual(['navigation/root-stack.tsx']);
        expect(importersOf('platform/diagnostics.ts')).toEqual(['screens/diagnostics.tsx']);
        expect(importersOf('screens/editor-corpus.tsx')).toEqual(['navigation/root-stack.tsx']);
        expect(importersOf('platform/editor-corpus.ts')).toEqual(['screens/editor-corpus-run.tsx']);
        expect(importersOf('editor/generated/editor-corpus.ts')).toEqual(['screens/editor-corpus-run.tsx']);
        // The root stack builds its screens for this build's variant.
        expect(read('navigation/root-stack.tsx')).toMatch(
            /staticScreens\(\s*\{[^}]*Diagnostics: DiagnosticsScreen,[^}]*\},\s*BUILD_VARIANT,[^)]*\)/s,
        );
        expect(read('platform/variant.ts')).toContain('variantFromConfig(Constants.expoConfig)');
    });

    it('is offered by the placeholders only in a build that has the route, and never by the lock screen', () => {
        const placeholder = read('screens/placeholder.tsx');
        expect(placeholder).toContain("const HAS_DIAGNOSTICS = routeInVariant('Diagnostics', BUILD_VARIANT);");
        expect(placeholder).toMatch(/\{props\.diagnostics === true && HAS_DIAGNOSTICS \? \(/);
        expect(read('screens/add-workspace.tsx')).toMatch(/\bdiagnostics\b/);
        expect(read('screens/home.tsx')).toMatch(/\bdiagnostics\b/);
        expect(read('screens/lock.tsx')).not.toMatch(/diagnostics/i);
    });
});
