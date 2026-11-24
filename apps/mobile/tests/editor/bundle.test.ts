import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSchema } from '@tiptap/core';
import { afterAll, describe, expect, it } from 'vitest';

import { documentExtensions } from '../../../../packages/client/src/modules/pages/editor/markdown';
import { EDITOR_ATTRIBUTES, REFUSED_PASTE, REFUSED_PASTE_NOTICE } from '../../editor/extensions';
import { PAGE_CSS } from '../../editor/styles';
import { bundle, contentSecurityPolicy, cspHash } from '../../scripts/build-editor.mts';
import { EDITOR_CSP, EDITOR_HTML, EDITOR_PACKAGES, EDITOR_SCHEMA } from '../../src/editor/generated/editor-html';

// The page editor's WebView document: scripts/build-editor.mts
// builds editor/ into src/editor/generated/editor-html.ts. These hold the
// generated file to its sources, its CSP to the lockdown's, its bundle to one copy
// of Tiptap and ProseMirror at the web's versions, and its schema, ARIA and
// paste rule to the web's editor.

const app = join(import.meta.dirname, '../..');
const root = join(app, '../..');
const webEditor = join(root, 'packages/client/src/modules/pages/editor');

const head = /<head>([\s\S]*?)<\/head>/.exec(EDITOR_HTML)?.[1] ?? '';
const scripts = [...EDITOR_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
const styles = [...EDITOR_HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '');
/** The document without its script's and style's text: the markup alone. */
const markup = EDITOR_HTML.replace(/<script>[\s\S]*?<\/script>/, '<script></script>').replace(
    /<style>[\s\S]*?<\/style>/,
    '<style></style>',
);

/** The stylesheet tentap's native side injects on every load, read from tentap's source. */
function dynamicHeightCss() {
    const require = createRequire(join(app, 'package.json'));
    const folder = join(require.resolve('@10play/tentap-editor/package.json'), '..');
    const source = readFileSync(join(folder, 'src/shared/dynamicHeightStyle.ts'), 'utf8');
    const css = /DYNAMIC_HEIGHT_CSS\s*=\s*'([^']*)'/.exec(source)?.[1];
    expect(css, "tentap's DYNAMIC_HEIGHT_CSS").toBeTruthy();
    return css!;
}

const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf('@'));
const versionOf = (spec: string) => spec.slice(spec.lastIndexOf('@') + 1);

describe("the editor's document", () => {
    it('is current: --check rebuilds it and finds no change', () => {
        const result = spawnSync(process.execPath, [join(app, 'scripts/build-editor.mts'), '--check'], {
            cwd: app,
            encoding: 'utf8',
            env: { ...process.env },
        });
        expect(result.stderr + result.stdout).toContain('is current');
        expect(result.status).toBe(0);
    }, 120_000);

    it('starts its <head> with the CSP, so the policy covers everything after it', () => {
        const first = /^\s*<([a-z]+)[^>]*>/.exec(head);
        expect(first?.[1]).toBe('meta');
        expect(first?.[0]).toContain('http-equiv="Content-Security-Policy"');
        expect(first?.[0]).toContain(`content="${EDITOR_CSP}"`);
        expect(EDITOR_HTML.match(/Content-Security-Policy/g)).toHaveLength(1);
    });

    it('holds one inline script and one inline style, and names nothing to load', () => {
        expect(scripts).toHaveLength(1);
        expect(styles).toHaveLength(1);
        expect(markup).not.toMatch(/\s(src|href|srcset|action|poster|data)=/i);
        expect(markup).not.toMatch(/<(link|iframe|img|object|embed|base|form)\b/i);
        // Nothing in the script that HTML would read as the end of it, or as a comment.
        expect(scripts[0]).not.toMatch(/<(!--|\/?script)/i);
    });

    it("has the lockdown's CSP: the script and styles by hash, pictures only as data: URIs", () => {
        const [script = '', style = ''] = [scripts[0], styles[0]];
        expect(EDITOR_CSP).toBe(contentSecurityPolicy(script, style, dynamicHeightCss()));
        expect(EDITOR_CSP.split('; ')).toEqual([
            "default-src 'none'",
            `script-src ${cspHash(script)} 'report-sample'`,
            `style-src ${cspHash(style)} ${cspHash(dynamicHeightCss())} 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'report-sample'`,
            'img-src data:',
            "base-uri 'none'",
            "form-action 'none'",
        ]);
        expect(EDITOR_CSP).not.toMatch(/unsafe-|https?:|\*/);
    });

    it('bundles one copy of each Tiptap, ProseMirror and React package', () => {
        const names = EDITOR_PACKAGES.map(nameOf);
        expect(new Set(names).size).toBe(names.length);
        expect(names.filter((name) => name === 'prosemirror-model')).toHaveLength(1);
        for (const name of ['@tiptap/core', '@tiptap/pm', '@tiptap/markdown', 'react', 'react-dom']) {
            expect(names).toContain(name);
        }
    });

    it("bundles the web's Tiptap and React versions", () => {
        const client = JSON.parse(readFileSync(join(root, 'packages/client/package.json'), 'utf8')) as {
            dependencies: Record<string, string>;
            peerDependencies?: Record<string, string>;
        };
        const require = createRequire(join(root, 'packages/client/package.json'));
        const installed = (name: string) =>
            (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
        for (const spec of EDITOR_PACKAGES) {
            const name = nameOf(spec);
            if (name.startsWith('@tiptap/') && name in client.dependencies) {
                expect(spec, spec).toBe(`${name}@${client.dependencies[name]}`);
            }
            if (name === 'react' || name === 'react-dom') {
                expect(versionOf(spec), spec).toBe(installed(name));
            }
        }
        expect(EDITOR_PACKAGES).toContain(`@tiptap/core@${client.dependencies['@tiptap/core']}`);
    });
});

describe("the build's guard on tentap's prebuilt web bundle", () => {
    // `@10play/tentap-editor/web` embeds its own Tiptap and ProseMirror, which
    // Rollup counts as tentap's: the copy check can't see them, so the entry
    // itself fails the build, by name or by path.
    const tentapWeb = join(
        createRequire(join(app, 'package.json')).resolve('@10play/tentap-editor/package.json'),
        '../lib-web/index.mjs',
    );
    const folder = mkdtempSync(join(tmpdir(), 'socio-editor-guard-'));
    afterAll(() => rmSync(folder, { recursive: true, force: true }));
    const entry = (name: string, text: string) => {
        const path = join(folder, name);
        writeFileSync(path, text);
        return path;
    };

    it('fails the build when the bundle imports it', async () => {
        await expect(bundle(entry('by-name.ts', "import '@10play/tentap-editor/web';\n"))).rejects.toThrow(
            /@10play\/tentap-editor\/web carries a second Tiptap and ProseMirror/,
        );
    }, 60_000);

    it('fails the build when a module reaches its file by path', async () => {
        await expect(bundle(entry('by-path.ts', `import ${JSON.stringify(tentapWeb)};\n`))).rejects.toThrow(
            /tentap's prebuilt web bundle/,
        );
    }, 60_000);
});

describe("the editor's page layout", () => {
    it('pads the page evenly on every side (the owner rule)', () => {
        const rule = /#root div \.ProseMirror\{([^}]*)\}/.exec(PAGE_CSS)?.[1] ?? '';
        expect(rule).toContain('box-sizing:border-box');
        expect(/(?:^|;)padding:([^;]*)/.exec(rule)?.[1]).toBe('16px');
    });
});

describe("the editor's drift from the web", () => {
    it("has the web's node and mark names", () => {
        const schema = getSchema(documentExtensions());
        expect(EDITOR_SCHEMA).toEqual({
            nodes: Object.keys(schema.nodes).sort(),
            marks: Object.keys(schema.marks).sort(),
        });
        for (const atom of ['datasetView', 'embedCard', 'pageImage']) {
            expect(EDITOR_SCHEMA.nodes).toContain(atom);
        }
    });

    it("has the web's ARIA and paste rule", () => {
        const web = readFileSync(join(webEditor, 'RichEditor.tsx'), 'utf8');
        for (const [name, value] of Object.entries(EDITOR_ATTRIBUTES)) {
            expect(web, name).toContain(`${/^[a-z]+$/.test(name) ? name : `'${name}'`}: '${value}'`);
        }
        expect(web).toContain(`${REFUSED_PASTE}.test(html)`);
        expect(web).toContain(`'${REFUSED_PASTE_NOTICE}'`);
    });
});
