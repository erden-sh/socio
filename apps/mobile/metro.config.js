// Metro's config: Expo's defaults, which find the pnpm workspace by
// themselves, plus a source mapping for @socio/shared, all wrapped in
// uniwind's, which turns className into styles. Its order is fixed: our resolver first,
// uniwind's around it.
//
// The app depends on @socio/shared (workspace:*), whose exports give built
// JavaScript in dist/, which exists only after `pnpm run build:packages`. So
// Metro reads its TypeScript source instead, as the app's tsconfig paths do:
// `@socio/shared/<path>` resolves to packages/shared/src/<path> through Metro's
// own resolver (so `.ts`, platform extensions, and a plain "Unable to resolve"
// for a typo), and a relative `.js` import inside that source (NodeNext style)
// to its `.ts` file.
// A `source` export condition in shared's package.json would do the same, but
// breaks tests/integration/shared-package.test.ts. Shared's bare imports (zod)
// resolve through pnpm's links from packages/shared, to the one copy the
// lockfile gives everyone. Keep hierarchical lookup on: pnpm's isolated
// layout needs it for transitive dependencies.
//
// One copy each of react, react-native, @tanstack/db and @react-navigation/*
// goes in the bundle: a second copy
// breaks hooks, contexts and native stacks at launch. So a bare import of one
// of them, from anywhere, resolves from a fixed place: the app for what it
// declares, otherwise the app's copy of the first of them that depends on it
// (@react-navigation/core from native, routers from core, elements from
// bottom-tabs). tests/single-copy.test.ts checks those fixed places, and that
// the packages bringing their own (react-db, bottom-tabs, native-stack) find
// the same copies on disk.
// oxlint-disable-next-line typescript/no-require-imports -- Metro loads this file with require()
const fs = require('node:fs');
// oxlint-disable-next-line typescript/no-require-imports -- Metro loads this file with require()
const path = require('node:path');
// oxlint-disable-next-line typescript/no-require-imports -- Metro loads this file with require()
const { getDefaultConfig } = require('expo/metro-config');
// oxlint-disable-next-line typescript/no-require-imports -- Metro loads this file with require()
const { withUniwindConfig } = require('uniwind/metro');

const sharedSrc = path.resolve(__dirname, '../../packages/shared/src');
const SHARED = '@socio/shared/';

/** The package a bare import names (`@scope/name/sub` gives `@scope/name`), or undefined for a path. */
const packageOf = (moduleName) => {
    if (moduleName.startsWith('.') || path.isAbsolute(moduleName)) {
        return undefined;
    }
    return moduleName
        .split('/')
        .slice(0, moduleName.startsWith('@') ? 2 : 1)
        .join('/');
};

const isSingleCopy = (name) =>
    name === 'react' || name === 'react-native' || name === '@tanstack/db' || name.startsWith('@react-navigation/');

/** The real directory of `name` as Node and Metro find it from `dir`: the nearest node_modules holding it. */
const lookup = (dir, name) => {
    for (let at = dir; ; at = path.dirname(at)) {
        const candidate = path.join(at, 'node_modules', name);
        if (fs.existsSync(path.join(candidate, 'package.json'))) {
            return fs.realpathSync(candidate);
        }
        if (path.dirname(at) === at) {
            return undefined;
        }
    }
};

/** Each single-copy package, mapped to the file its imports resolve from. */
const singleCopyOrigins = new Map();
const queue = [__dirname];
while (queue.length > 0) {
    const dir = queue.shift();
    const { dependencies = {} } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(dependencies).filter(isSingleCopy).sort()) {
        const found = singleCopyOrigins.has(name) ? undefined : lookup(dir, name);
        if (found) {
            singleCopyOrigins.set(name, path.join(dir, 'package.json'));
            queue.push(found);
        }
    }
}

const config = getDefaultConfig(__dirname);

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolve = upstream ?? context.resolveRequest;
    if (moduleName.startsWith(SHARED)) {
        return resolve(context, path.join(sharedSrc, moduleName.slice(SHARED.length)), platform);
    }
    const origin = singleCopyOrigins.get(packageOf(moduleName));
    if (origin) {
        return resolve({ ...context, originModulePath: origin }, moduleName, platform);
    }
    if (
        context.originModulePath.startsWith(sharedSrc + path.sep) &&
        moduleName.startsWith('.') &&
        moduleName.endsWith('.js')
    ) {
        return resolve(context, `${moduleName.slice(0, -'.js'.length)}.ts`, platform);
    }
    return resolve(context, moduleName, platform);
};

// uniwind, around everything above:
// - Its transformer compiles global.css (Tailwind, uniwind's utilities and the
//   generated theme) into styles, and hands every other file to Expo's.
// - Its resolver calls ours for every import, then sends a `react-native`
//   import from outside React Native and uniwind to uniwind's components,
//   which take className; theirs import the one react-native ours resolves.
// - It reads cssEntryFile against the working directory, so the entry is
//   given relative to wherever Metro starts.
// - When it compiles the entry, it writes a declaration file of its themes
//   (dtsFile, by default uniwind-types.d.ts in the working directory). It goes
//   to .expo/types instead, beside Expo's own generated types: ignored by git,
//   oxfmt and turbo, and outside the typecheck. The typecheck takes the
//   className props from uniwind/types (uniwind-env.d.ts) and the theme names
//   from a copy written by hand (uniwind-themes.d.ts), which
//   tests/metro-config.test.ts holds to the one uniwind writes. So no build
//   dirties the tree.
const UNIWIND_TYPES = path.join(__dirname, '.expo/types/uniwind.d.ts');
fs.mkdirSync(path.dirname(UNIWIND_TYPES), { recursive: true });

module.exports = withUniwindConfig(config, {
    cssEntryFile: path.relative(process.cwd(), path.join(__dirname, 'global.css')),
    dtsFile: UNIWIND_TYPES,
});
