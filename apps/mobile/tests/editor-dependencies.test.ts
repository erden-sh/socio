import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The page editor's dependencies: tentap (@10play/tentap-editor) and
// react-native-webview. The editor's WebView bundle runs the web's
// documentExtensions() (packages/client's pages editor) inside tentap's
// advanced setup, so Tiptap and ProseMirror must be one copy at the web's
// version: two copies of @tiptap/core or prosemirror-model break `instanceof`
// and schema checks, and a newer Tiptap would read Markdown differently from
// the web. tentap asks for `^3.11.0` of each Tiptap package, so the root's
// overrides (pnpm-workspace.yaml) pin the ones it names to the web's version, scoped to tentap
// (`@10play/tentap-editor>@tiptap/core`): a bare override would rewrite the
// web client's install too. This walks pnpm-lock.yaml from tentap and from
// packages/client.

const app = join(import.meta.dirname, '..');
const root = join(app, '../..');
// The root's YAML parser (its devDependency): the app declares nothing for this.
const { parse } = createRequire(join(root, 'package.json'))('yaml') as { parse: (text: string) => unknown };

const TENTAP = '@10play/tentap-editor';

type Dependencies = Record<string, { version: string }>;

interface Lockfile {
    importers: Record<string, Partial<Record<string, Dependencies>>>;
    packages: Record<string, unknown>;
    snapshots: Record<string, Partial<Record<string, Record<string, string>>> | null>;
}

const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')) as Lockfile;

/** A snapshot key's package name: `@scope/name@1.0.0(peer@2.0.0)` gives `@scope/name`. */
const nameOf = (key: string) => key.slice(0, key.indexOf('@', 1));

/** A snapshot key without its resolved peers: `a@1(b@2)` gives `a@1`. */
const baseOf = (key: string) => key.split('(')[0] ?? key;

/** A dependency's snapshot key from its name and the version the lockfile gives (an alias is a key already). */
const keyOf = (name: string, version: string) => {
    if (/^(link|file|workspace):/.test(version)) {
        return undefined;
    }
    return /^(@[^/]+\/)?[^@/]+@/.test(baseOf(version)) ? version : `${name}@${version}`;
};

/** The peers resolved in a key's suffix: `a@1(b@2(c@3))(d@4)` gives `b@2(c@3)` and `d@4`. */
function resolvedPeers(key: string): string[] {
    const peers: string[] = [];
    let depth = 0;
    let start = -1;
    for (let index = key.indexOf('('); index !== -1 && index < key.length; index++) {
        if (key[index] === '(') {
            if (depth++ === 0) {
                start = index + 1;
            }
        } else if (key[index] === ')' && --depth === 0) {
            peers.push(key.slice(start, index));
        }
    }
    return peers;
}

/** Every package (`name@version`) the snapshot keys reach: dependencies, optional ones and resolved peers. */
function closure(start: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...start];
    for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const snapshot = lock.snapshots[key] ?? {};
        for (const section of ['dependencies', 'optionalDependencies']) {
            for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
                const next = keyOf(name, version);
                if (next !== undefined) {
                    queue.push(next);
                }
            }
        }
        queue.push(...resolvedPeers(key));
    }
    return new Set([...seen].map(baseOf));
}

/** An importer's own dependencies, devDependencies included, as snapshot keys. */
const importerKeys = (id: string) =>
    ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((section) =>
        Object.entries(lock.importers[id]?.[section] ?? {}).flatMap(
            ([name, { version }]) => keyOf(name, version) ?? [],
        ),
    );

const isEditorCore = (name: string) => name.startsWith('@tiptap/') || name.startsWith('prosemirror-');

const tentapVersion = lock.importers['apps/mobile']?.dependencies?.[TENTAP]?.version ?? '';
const tentap = [...closure([`${TENTAP}@${tentapVersion}`])].filter((key) => isEditorCore(nameOf(key))).sort();
const web = closure(importerKeys('packages/client'));
const webTiptap = baseOf(lock.importers['packages/client']?.dependencies?.['@tiptap/core']?.version ?? '');

describe("the page editor's dependencies", () => {
    it('are tentap and react-native-webview, pinned in the app', () => {
        const { dependencies = {} } = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };
        expect(dependencies[TENTAP]).toBe('1.1.0');
        expect(dependencies['react-native-webview']).toBe('14.0.1');
        expect(baseOf(tentapVersion)).toBe('1.1.0');
    });

    it("reach Tiptap and ProseMirror only at the web's versions", () => {
        // A walk that found nothing would pass too.
        expect(webTiptap).toMatch(/^\d+\.\d+\.\d+$/);
        expect(tentap).toContain(`@tiptap/core@${webTiptap}`);
        expect(tentap).toContain(`@tiptap/pm@${webTiptap}`);
        expect(tentap.some((key) => key.startsWith('prosemirror-model@'))).toBe(true);
        for (const key of tentap) {
            if (nameOf(key).startsWith('@tiptap/')) {
                expect(key).toBe(`${nameOf(key)}@${webTiptap}`);
            }
            // The web has every ProseMirror package tentap reaches, at that version.
            if (nameOf(key).startsWith('prosemirror-')) {
                expect(web.has(key), `${key} isn't the web's`).toBe(true);
            }
        }
    });

    it('install one copy of each Tiptap and ProseMirror package in the workspace', () => {
        const versions = new Map<string, string[]>();
        for (const key of Object.keys(lock.packages)) {
            if (isEditorCore(nameOf(key))) {
                versions.set(nameOf(key), [...(versions.get(nameOf(key)) ?? []), key]);
            }
        }
        expect(versions.size).toBeGreaterThan(10);
        expect([...versions.values()].filter((keys) => keys.length > 1)).toEqual([]);
    });

    it('pin Tiptap through overrides scoped to tentap, at the web’s version', () => {
        const { overrides } = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as {
            overrides: Record<string, string>;
        };
        const tiptap = Object.entries(overrides).filter(([key]) => key.includes('@tiptap/'));
        expect(tiptap.length).toBeGreaterThan(0);
        for (const [key, version] of tiptap) {
            expect(key, key).toMatch(new RegExp(`^${TENTAP}>@tiptap/[\\w-]+$`));
            expect(version, key).toBe(webTiptap);
        }
        // Each Tiptap package tentap names itself has its override, so a tentap bump never floats one.
        const manifest = JSON.parse(
            readFileSync(createRequire(join(app, 'package.json')).resolve(`${TENTAP}/package.json`), 'utf8'),
        ) as { dependencies?: Record<string, string> };
        const named = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@tiptap/'));
        expect(tiptap.map(([key]) => key.slice(TENTAP.length + 1)).sort()).toEqual(named.sort());
    });
});
