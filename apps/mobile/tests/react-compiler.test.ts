import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigContext } from 'expo/config';
import { afterAll, describe, expect, it } from 'vitest';

import appConfig from '../app.config.ts';
import {
    babelConfigFileIn,
    bailoutsIn,
    compilerBailouts,
    compilerCachedCalls,
    metroPresetPath,
    mobileRoot,
    requireFromMobile,
    sourceFiles,
    transformWithMetro,
} from '../vendor/t3code/react-compiler-coverage';

// The React Compiler runs on every file Metro bundles from src/ (app.config.ts),
// and a release build compiles with panicThreshold 'NONE': a component the
// compiler gives up on ships unmemoized, silently. So every source file must
// compile, except those listed here with the reason. The list may only shrink:
// a listed file that compiles fails until its entry goes. T3 Code's coverage
// test (vendor/t3code/react-compiler-coverage.ts).
const KNOWN_BAILOUTS: Record<string, string> = {};

const scratch = mkdtempSync(join(tmpdir(), 'socio-compiler-'));
afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
});

/** A component file outside src/, for the checks that must see the compiler fail or cache. */
const fixture = (name: string, source: string) => {
    const file = join(scratch, name);
    writeFileSync(file, source);
    return file;
};

describe('React Compiler coverage', () => {
    it('is on in the Expo config, which is what makes Expo CLI ask Metro for it', () => {
        const config = appConfig({ config: {} } as ConfigContext);
        expect(config.experiments?.reactCompiler).toBe(true);
    });

    it('runs in the preset Metro uses, the app’s own babel-preset-expo, since the app has no Babel config', () => {
        // A babel.config.js would replace Expo's default preset in Metro, and these
        // checks would compile with something else than the bundle does.
        expect(babelConfigFileIn(mobileRoot)).toBeUndefined();
        expect(requireFromMobile(metroPresetPath)).toBe(requireFromMobile('babel-preset-expo'));
    });

    it("Metro's transformer applies the compiler", () => {
        expect(transformWithMetro('src/screens/home.tsx', 'true')).toContain('react/compiler-runtime');
        expect(transformWithMetro('src/screens/home.tsx', 'false')).not.toContain('react/compiler-runtime');
    });

    it.each(sourceFiles)('compiles %s', (file) => {
        const bailouts = compilerBailouts(file);
        if (file in KNOWN_BAILOUTS) {
            expect(bailouts, `${file} compiles now; remove it from KNOWN_BAILOUTS`).not.toEqual([]);
        } else {
            expect(bailouts).toEqual([]);
        }
    });

    it('lists only files that exist', () => {
        expect(Object.keys(KNOWN_BAILOUTS).filter((file) => !sourceFiles.includes(file))).toEqual([]);
    });

    it('reports a component it gives up on', () => {
        const file = fixture(
            'mutates-ref.tsx',
            [
                "import { useRef } from 'react';",
                '',
                'export function Counter() {',
                '    const renders = useRef(0);',
                '    renders.current += 1;',
                '    return <>{renders.current}</>;',
                '}',
                '',
            ].join('\n'),
        );
        expect(compilerBailouts(file)).not.toEqual([]);
    });

    it('counts a crash inside the compiler as a bailout', () => {
        // babel-plugin-react-compiler logs any exception that isn't a CompilerError
        // as a PipelineError, and a release build ships that function uncompiled.
        const crash = {
            kind: 'PipelineError',
            fnLoc: { start: { line: 3 } },
            data: 'TypeError: Cannot read properties of undefined\n    at lower (index.js:1:1)',
        };
        expect(bailoutsIn([{ kind: 'CompileSuccess' }, crash])).toEqual([
            'line 3: PipelineError TypeError: Cannot read properties of undefined',
        ]);
    });

    it('caches a derivation behind its inputs', () => {
        const file = fixture(
            'derives.tsx',
            [
                'declare function deriveRows(items: readonly string[]): string[];',
                '',
                'export function Rows({ items }: { items: readonly string[] }) {',
                '    const rows = deriveRows(items);',
                '    return <>{rows.join()}</>;',
                '}',
                '',
            ].join('\n'),
        );
        expect(compilerBailouts(file)).toEqual([]);
        expect(compilerCachedCalls(file, 'deriveRows')).toEqual([true]);
    });
});
