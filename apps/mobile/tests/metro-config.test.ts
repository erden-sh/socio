import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileUniwind, declaredThemes } from './helpers/uniwind';

// metro.config.js composes three things: Expo's defaults, our resolver (the
// @socio/shared source mapping and the single-copy rule, which
// tests/single-copy.test.ts covers on its own) and uniwind's wrapper around
// both. This checks the composition: uniwind's transformer compiles global.css
// with the generated theme, every import still goes through our resolver
// first, uniwind's swap of react-native for its components lands on top of it,
// and the declaration file uniwind writes stays out of the tree, with its theme
// names copied into uniwind-themes.d.ts for the typecheck.

const app = join(import.meta.dirname, '..');
const requireFromApp = createRequire(join(app, 'package.json'));

interface Resolution {
    type: string;
    filePath?: string;
}

interface ResolutionContext {
    originModulePath: string;
    resolveRequest: (context: ResolutionContext, moduleName: string, platform: string) => Resolution;
}

interface MetroConfig {
    projectRoot: string;
    transformerPath: string;
    transformer: {
        uniwind: { cssEntryFile: string; dtsFile: string; isExpoProject: boolean; extraThemes?: string[] };
    };
    resolver: {
        sourceExts: string[];
        assetExts: string[];
        resolveRequest: (context: ResolutionContext, moduleName: string, platform: string) => Resolution;
    };
}

const config: MetroConfig = requireFromApp('./metro.config.js');
const uniwind = realpathSync(dirname(requireFromApp.resolve('uniwind/package.json')));
const reactNative = realpathSync(dirname(requireFromApp.resolve('react-native/package.json')));

/**
 * Resolves as Metro would, with Node's resolution standing in for Metro's own:
 * every request our resolver passes on is recorded with the file it was made from.
 */
function resolveFrom(origin: string, moduleName: string) {
    const calls: { origin: string; moduleName: string }[] = [];
    const context: ResolutionContext = {
        originModulePath: origin,
        resolveRequest: (inner, name) => {
            calls.push({ origin: inner.originModulePath, moduleName: name });
            if (isAbsolute(name)) {
                return { type: 'sourceFile', filePath: name };
            }
            const file = createRequire(inner.originModulePath).resolve(name);
            return { type: 'sourceFile', filePath: realpathSync(file) };
        },
    };
    const resolution = config.resolver.resolveRequest(context, moduleName, 'android');
    return { resolution, calls };
}

const inside = (dir: string, file: string | undefined) => file !== undefined && file.startsWith(dir + sep);

describe('uniwind’s wrapper', () => {
    it('compiles the app’s global.css with its transformer, which hands every other file to Expo’s', () => {
        expect(config.transformerPath).toBe(join(uniwind, 'dist/metro/transformer.cjs'));
        expect(config.transformer.uniwind.isExpoProject).toBe(true);
        // uniwind reads the entry against the working directory, wherever Metro starts.
        expect(join(process.cwd(), config.transformer.uniwind.cssEntryFile)).toBe(join(app, 'global.css'));
        expect(config.resolver.sourceExts).toContain('css');
        expect(config.resolver.assetExts).not.toContain('css');
    });

    it('finds global.css from any working directory', { timeout: 30_000 }, () => {
        const root = join(app, '../..');
        const entry = execFileSync(
            process.execPath,
            ['-e', "process.stdout.write(require('./apps/mobile/metro.config.js').transformer.uniwind.cssEntryFile)"],
            { cwd: root, encoding: 'utf8' },
        );
        expect(entry).toBe(join('apps', 'mobile', 'global.css'));
    });

    it('takes global.css with Tailwind, uniwind and the generated theme, in that order', () => {
        const css = readFileSync(join(app, 'global.css'), 'utf8');
        const imports = [...css.matchAll(/^@import '([^']+)';$/gm)].map((match) => match[1]);
        expect(imports).toEqual(['tailwindcss', 'uniwind', './src/theme/generated/theme.css']);
        expect(existsSync(join(app, 'src/theme/generated/theme.css'))).toBe(true);
        expect(css).not.toMatch(/@variant|--color-/);
    });

    it('sends the app’s react-native imports to its components, through our single-copy rule', () => {
        const { resolution, calls } = resolveFrom(join(app, 'src/app.tsx'), 'react-native');
        // Our rule resolves react-native from the app, then uniwind asks again for its components.
        expect(calls[0]).toEqual({ origin: join(app, 'package.json'), moduleName: 'react-native' });
        expect(calls.at(-1)).toEqual({ origin: join(app, 'package.json'), moduleName: 'uniwind/components' });
        expect(inside(uniwind, resolution.filePath)).toBe(true);
    });

    it('gives uniwind’s components and React Native itself the one react-native', () => {
        for (const origin of [join(uniwind, 'src/components/native/Text.tsx'), join(reactNative, 'index.js')]) {
            const { resolution, calls } = resolveFrom(origin, 'react-native');
            expect(calls).toEqual([{ origin: join(app, 'package.json'), moduleName: 'react-native' }]);
            expect(inside(reactNative, resolution.filePath)).toBe(true);
        }
    });

    it('keeps the @socio/shared source mapping and its .js to .ts rewrite', () => {
        const shared = join(app, '../../packages/shared/src');
        expect(resolveFrom(join(app, 'src/screens/placeholder.tsx'), '@socio/shared/token-count').calls).toEqual([
            { origin: join(app, 'src/screens/placeholder.tsx'), moduleName: join(shared, 'token-count') },
        ]);
        expect(resolveFrom(join(shared, 'token-count.ts'), './locale.js').calls).toEqual([
            { origin: join(shared, 'token-count.ts'), moduleName: './locale.ts' },
        ]);
    });

    it('leaves other packages to their importer', () => {
        const origin = join(app, 'src/ui/icon.tsx');
        const { resolution, calls } = resolveFrom(origin, 'lucide-react-native/icons/house');
        expect(calls).toEqual([{ origin, moduleName: 'lucide-react-native/icons/house' }]);
        expect(resolution.filePath).toMatch(/lucide-react-native/);
    });
});

describe('uniwind’s declaration file', () => {
    const dts = config.transformer.uniwind.dtsFile;

    it('is written under .expo/types, not into the tree', () => {
        expect(dts).toBe(join(app, '.expo/types/uniwind.d.ts'));
        // Its folder exists before Metro's first transform: uniwind writes beside the file.
        expect(existsSync(dirname(dts))).toBe(true);
        // Read the app's .gitignore rather than asking git: CI runs the tests in a container
        // whose copy of the repository has no .git.
        const rules = readFileSync(join(app, '.gitignore'), 'utf8')
            .split('\n')
            .map((line) => line.trim());
        expect(rules).toContain('.expo/');
    });

    it('is left out of the typecheck, the format check and the build’s inputs', () => {
        // TypeScript's include globs skip folders whose names start with a dot.
        const { include } = JSON.parse(
            readFileSync(join(app, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
        ) as { include: string[] };
        expect(include.every((glob) => !glob.includes('.expo'))).toBe(true);
        const formatter = JSON.parse(readFileSync(join(app, '../../.oxfmtrc.json'), 'utf8')) as {
            ignorePatterns: string[];
        };
        expect(formatter.ignorePatterns).toContain('apps/mobile/.expo');
        const turbo = JSON.parse(readFileSync(join(app, 'turbo.json'), 'utf8')) as {
            tasks: Record<string, { inputs: string[] }>;
        };
        for (const task of ['typecheck', 'lint', 'test', 'build']) {
            expect(turbo.tasks[task]?.inputs, task).toContain('!.expo/**');
        }
    });

    it('isn’t needed by the typecheck: uniwind-env.d.ts takes the className props from uniwind/types', () => {
        const env = readFileSync(join(app, 'uniwind-env.d.ts'), 'utf8');
        expect(env).toContain('/// <reference types="uniwind/types" />');
        expect(existsSync(join(app, 'uniwind-types.d.ts'))).toBe(false);
    });

    it('names the themes uniwind-themes.d.ts gives the typecheck', { timeout: 30_000 }, async () => {
        // Without them, uniwind types a theme as any string: setTheme('drak') would pass tsc.
        const { declaration, themes } = await compileUniwind('android');
        const ours = declaredThemes(readFileSync(join(app, 'uniwind-themes.d.ts'), 'utf8'));
        expect(ours).toEqual(declaredThemes(declaration));
        expect(ours).toEqual(themes);
        expect(ours).toEqual(['light', 'dark', ...(config.transformer.uniwind.extraThemes ?? [])]);
    });
});
