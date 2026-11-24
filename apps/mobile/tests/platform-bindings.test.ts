import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { moduleNames } from '../vendor/t3code/dependency-graph';
import { metroCaller, metroPresetPath, requireFromMobile, sourceFiles } from '../vendor/t3code/react-compiler-coverage';

// The app's state and the network reach sync through src/platform alone:
// src/platform/app-state.ts binds React
// Native's AppState and src/platform/network.ts binds NetInfo, and src/sync
// takes both as parameters (src/sync/triggers.ts), so its tests run under Node
// with fakes. Any other file of src/ that imports NetInfo, or uses AppState,
// fails here: it would be a second source of triggers the scheduler never hears.

/** The few AST fields the check reads (no Babel types in the app: the vendored helpers type theirs by hand too). */
interface Node {
    readonly type: string;
    readonly name?: string;
    readonly value?: unknown;
    readonly source?: Node;
    readonly specifiers?: readonly (Node & { readonly imported?: Node; readonly local: Node })[];
    readonly object?: Node;
    readonly property?: Node;
    readonly callee?: Node;
    readonly arguments?: readonly Node[];
}

const babel: {
    parseSync: (source: string, options: Record<string, unknown>) => unknown;
    traverse: (ast: unknown, visitors: { readonly enter: (path: { readonly node: Node }) => void }) => void;
} = requireFromMobile('@babel/core');
const mobile = join(import.meta.dirname, '..');
const PLATFORM = 'src/platform/';
const NETINFO = /^@react-native-community\/netinfo($|\/)/;

/** An identifier's name, or a string literal's value (`import { 'AppState' as A }`). */
const nameOf = (node: Node | undefined) => (node?.type === 'Identifier' ? node.name : node?.value);

/** Whether `source` (the file `filename`) uses React Native's AppState: a named import, or a member of the module. */
function usesAppState(source: string, filename: string): boolean {
    const ast = babel.parseSync(source, {
        babelrc: false,
        configFile: false,
        filename,
        presets: [metroPresetPath],
        caller: metroCaller,
        sourceType: 'unambiguous',
    });
    if (ast === null) {
        throw new Error(`Babel gave no AST for ${filename}`);
    }
    let found = false;
    const modules = new Set<string>();
    babel.traverse(ast, {
        enter({ node }) {
            if (node.type === 'ImportDeclaration' && node.source?.value === 'react-native') {
                for (const specifier of node.specifiers ?? []) {
                    if (specifier.type === 'ImportSpecifier') {
                        found ||= nameOf(specifier.imported) === 'AppState';
                    } else if (specifier.local.name !== undefined) {
                        modules.add(specifier.local.name);
                    }
                }
            }
            if (node.type === 'MemberExpression' && nameOf(node.property) === 'AppState') {
                const { object } = node;
                const isModule = object?.type === 'Identifier' && modules.has(object.name ?? '');
                const isRequire =
                    object?.type === 'CallExpression' &&
                    nameOf(object.callee) === 'require' &&
                    object.arguments?.[0]?.value === 'react-native';
                found ||= isModule || isRequire;
            }
        },
    });
    return found;
}

/** The files of `files` (relative to `root`) outside src/platform that bind AppState or NetInfo. */
function bindingsOutsidePlatform(root: string, files: readonly string[]): string[] {
    return files.flatMap((file) => {
        if (file.startsWith(PLATFORM)) {
            return [];
        }
        const source = readFileSync(join(root, file), 'utf8');
        const found: string[] = [];
        // Babel with Metro's preset is the costly part (two parses of every file
        // took over 20 s under load), so a file is parsed only when its text could
        // hold what the check looks for: a module name has `netinfo` in it, and
        // AppState is named, as an identifier or a string, as `AppState`.
        if (source.includes('netinfo') && moduleNames(source, join(root, file)).some((name) => NETINFO.test(name))) {
            found.push(`${file}: NetInfo`);
        }
        if (source.includes('AppState') && usesAppState(source, join(root, file))) {
            found.push(`${file}: AppState`);
        }
        return found;
    });
}

describe('the platform bindings', () => {
    it('bind AppState and NetInfo in src/platform alone', () => {
        expect(sourceFiles.length).toBeGreaterThan(0);
        expect(bindingsOutsidePlatform(mobile, sourceFiles)).toEqual([]);
        expect(sourceFiles).toEqual(expect.arrayContaining(['src/platform/app-state.ts', 'src/platform/network.ts']));
    });
});

describe('the check itself', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'socio-bindings-'));
    afterAll(() => {
        rmSync(scratch, { recursive: true, force: true });
    });
    const files: Record<string, string> = {
        'src/sync/named.ts': "import { AppState as State } from 'react-native';\nexport const s = State;\n",
        'src/sync/namespace.ts': "import * as RN from 'react-native';\nexport const s = RN.AppState.currentState;\n",
        'src/sync/default.ts': "import RN from 'react-native';\nexport const s = RN.AppState;\n",
        'src/sync/required.ts': "export const s = require('react-native').AppState;\n",
        'src/sync/netinfo.ts': "import NetInfo from '@react-native-community/netinfo';\nexport const n = NetInfo;\n",
        'src/sync/netinfo-type.ts':
            "import type { NetInfoState } from '@react-native-community/netinfo';\nexport type N = NetInfoState;\n",
        'src/screens/fine.tsx':
            "import { View } from 'react-native';\nconst AppState = 1;\nexport const v = [View, AppState];\n",
        'src/platform/app-state.ts': "import { AppState } from 'react-native';\nexport const s = AppState;\n",
    };
    for (const [file, source] of Object.entries(files)) {
        const path = join(scratch, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source);
    }

    it('finds every way in, a type import of NetInfo included, and nothing in src/platform', () => {
        expect(bindingsOutsidePlatform(scratch, Object.keys(files)).sort()).toEqual([
            'src/sync/default.ts: AppState',
            'src/sync/named.ts: AppState',
            'src/sync/namespace.ts: AppState',
            'src/sync/netinfo-type.ts: NetInfo',
            'src/sync/netinfo.ts: NetInfo',
            'src/sync/required.ts: AppState',
        ]);
    });
});
