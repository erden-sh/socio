import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

// One copy each of react, react-native, @tanstack/db and @react-navigation/*
// in the bundle. metro.config.js resolves
// a bare import of one of them from a fixed place, whoever imports it. This
// checks that the packages that bring their own dependency on them find the
// app's copies on disk, so the lockfile gives each one snapshot, and that
// Metro's rule sends their imports to those same copies, the packages the app
// doesn't declare (@react-navigation/core, routers, elements) included. It also
// checks that the app's metro pins are the Metro Expo CLI runs, which uniwind
// patches.

const app = join(import.meta.dirname, '..');

/**
 * The packages that depend on single-copy packages themselves. @legendapp/list (the chat's list) peers on
 * react and react-native, and its `react-native` entry imports both. The page editor's tentap and
 * react-native-webview peer on both too.
 */
const IMPORTERS = [
    '@tanstack/react-db',
    '@react-navigation/bottom-tabs',
    '@react-navigation/native-stack',
    '@legendapp/list',
    '@10play/tentap-editor',
    'react-native-webview',
];

const isSingleCopy = (name: string) =>
    name === 'react' || name === 'react-native' || name === '@tanstack/db' || name.startsWith('@react-navigation/');

/** The real directory of `name` as Node and Metro find it from `dir`: the nearest node_modules holding it. */
function lookup(dir: string, name: string): string | undefined {
    for (let at = dir; ; at = dirname(at)) {
        const candidate = join(at, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) {
            return realpathSync(candidate);
        }
        if (dirname(at) === at) {
            return undefined;
        }
    }
}

interface Manifest {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
}

const manifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

const required = (dir: string | undefined, name: string) => {
    const found = dir === undefined ? undefined : lookup(dir, name);
    if (found === undefined) {
        throw new Error(`${name} isn't installed where ${dir ?? 'its importer'} can find it`);
    }
    return found;
};

const appDeclares = Object.keys(manifest(app).dependencies ?? {}).filter(isSingleCopy);
const importerDirs = new Map(IMPORTERS.map((name) => [name, required(app, name)]));

/** Every [single-copy package, importer] pair, from the importers' own dependencies and peers. */
const pairs = IMPORTERS.flatMap((importer) => {
    const { dependencies = {}, peerDependencies = {} } = manifest(importerDirs.get(importer) ?? '');
    return Object.keys({ ...dependencies, ...peerDependencies })
        .filter(isSingleCopy)
        .sort()
        .map((name) => [name, importer] as const);
});

/** The copy everyone must get: the app's when it declares the package, else the first importer's. */
const canonical = (name: string) => {
    if (appDeclares.includes(name)) {
        return required(app, name);
    }
    const first = pairs.find(([dependency]) => dependency === name);
    return required(importerDirs.get(first?.[1] ?? ''), name);
};

describe('single copies on disk', () => {
    it('the app declares react, react-native, @tanstack/db and its React Navigation packages', () => {
        expect(appDeclares).toEqual(
            expect.arrayContaining([
                'react',
                'react-native',
                '@tanstack/db',
                '@react-navigation/native',
                '@react-navigation/native-stack',
                '@react-navigation/bottom-tabs',
            ]),
        );
    });

    it('covers each single-copy package an importer brings', () => {
        expect(new Set(pairs.map(([name]) => name))).toEqual(
            new Set([
                'react',
                'react-native',
                '@tanstack/db',
                '@react-navigation/native',
                '@react-navigation/elements',
            ]),
        );
    });

    it.each(pairs)('%s from %s is the copy the app gets', (name, importer) => {
        expect(required(importerDirs.get(importer), name)).toBe(canonical(name));
    });
});

interface ResolutionContext {
    originModulePath: string;
    resolveRequest: (context: ResolutionContext, moduleName: string, platform: string) => unknown;
}

interface MetroConfig {
    resolver: { resolveRequest: (context: ResolutionContext, moduleName: string, platform: string) => unknown };
}

describe("Metro's single-copy rule", () => {
    const config: MetroConfig = createRequire(import.meta.url)('../metro.config.js');

    /** The file Metro is asked to resolve `moduleName` from, when `from` imports it. */
    const originFor = (from: string, moduleName: string) => {
        let origin: string | undefined;
        const context: ResolutionContext = {
            originModulePath: join(from, 'index.js'),
            resolveRequest: (inner) => {
                origin = inner.originModulePath;
                return { type: 'empty' };
            },
        };
        config.resolver.resolveRequest(context, moduleName, 'android');
        return origin ?? '';
    };

    it.each(pairs)('resolves %s, imported by %s, to the copy the app gets', (name, importer) => {
        const origin = originFor(importerDirs.get(importer) ?? '', name);
        expect(lookup(dirname(origin), name)).toBe(canonical(name));
    });

    // The rule's own job: from the app's folder these aren't installed at all,
    // so only the rule can send them to the right copy, and an importer that
    // finds one on disk still gets this one. Core moves with native, or every
    // native stack crashes at launch.
    it.each([
        ['@react-navigation/core', ['@react-navigation/native']],
        ['@react-navigation/routers', ['@react-navigation/native', '@react-navigation/core']],
        ['@react-navigation/elements', ['@react-navigation/bottom-tabs']],
    ])('resolves %s from the copy of %j the app gets, deep imports too', (name, chain) => {
        const dependent = chain.reduce((dir, dependency) => required(dir, dependency), app);
        const origin = join(dependent, 'package.json');
        for (const from of [app, ...importerDirs.values()]) {
            expect(originFor(from, name), from).toBe(origin);
            expect(originFor(from, `${name}/package.json`), from).toBe(origin);
        }
        expect(lookup(dependent, name)).toBeDefined();
    });

    it.each(appDeclares)('resolves %s from the app, deep imports too', (name) => {
        const from = importerDirs.get('@react-navigation/native-stack') ?? '';
        expect(originFor(from, name)).toBe(join(app, 'package.json'));
        expect(originFor(from, `${name}/package.json`)).toBe(join(app, 'package.json'));
    });

    it('leaves other packages and relative imports to their importer', () => {
        const from = importerDirs.get('@react-navigation/native-stack') ?? '';
        for (const moduleName of ['react-native-svg', 'react-dom', 'react-refresh', '@tanstack/react-db', './x.js']) {
            expect(originFor(from, moduleName), moduleName).toBe(join(from, 'index.js'));
        }
    });
});

// The metro, metro-cache and metro-transform-worker pins (devDependencies) are
// uniwind's peers: its Metro plugin patches metro/private/DeltaBundler/Graph and
// extends metro-cache's FileStore, so they must be the copies Expo CLI runs
// through @expo/metro. Metro isn't in Expo's bundledNativeModules.json, so
// `expo install --check` never flags them; this fails when an Expo update moves
// its metro and the pins have to follow.
describe('one Metro for Expo CLI, the app and uniwind', () => {
    const expo = required(app, 'expo');
    const expoMetro = required(required(expo, '@expo/cli'), '@expo/metro');
    const uniwind = required(app, 'uniwind');

    /** The real file `id` resolves to, required from `file`. */
    const resolveFrom = (file: string, id: string) => realpathSync(createRequire(file).resolve(id));

    it('expo/metro-config runs the @expo/metro Expo CLI runs, and uniwind uses that @expo/metro-config', () => {
        const metroConfig = required(expo, '@expo/metro-config');
        expect(required(metroConfig, '@expo/metro')).toBe(expoMetro);
        expect(required(uniwind, '@expo/metro-config')).toBe(metroConfig);
    });

    it.each([
        ['metro', 'metro/private/DeltaBundler/Graph'],
        ['metro-cache', 'metro-cache/private/stores/FileStore'],
        ['metro-transform-worker', 'metro-transform-worker'],
    ])('the app pins the %s Expo CLI runs, and uniwind loads that copy (%s)', (name, id) => {
        const expected = resolveFrom(join(expoMetro, 'package.json'), id);
        expect(required(app, name)).toBe(required(expoMetro, name));
        expect(resolveFrom(join(app, 'package.json'), id)).toBe(expected);
        expect(resolveFrom(join(uniwind, 'dist/metro/index.cjs'), id)).toBe(expected);
    });
});
