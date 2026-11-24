// Builds the page editor's WebView bundle into one HTML document and
// writes it to src/editor/generated/editor-html.ts.
//
//   node apps/mobile/scripts/build-editor.mts            writes the file
//   node apps/mobile/scripts/build-editor.mts --check    exits 1 if it is stale
//
// The document holds everything: the bundle's script and one <style> inline,
// and a CSP that lets nothing else in (tried on both engines):
// no request leaves, the script runs by its hash, styles by theirs, pictures
// only as `data:` URIs. The bundle is editor/index.ts, built with the root's
// Vite: every Tiptap, ProseMirror and React module comes from one folder, and
// the build fails on a second one. The app's tests run --check.
//
// No file watchers (a shared host's inotify limit is shared by every worktree):
// build() doesn't watch, and the dev server that loads the build's inputs runs
// with `watch: null`.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { build, createServer, parseAst, type Rollup } from 'vite';

const app = join(import.meta.dirname, '..');
const root = join(app, '../..');
const editor = join(app, 'editor');
export const OUTPUT = join(app, 'src/editor/generated/editor-html.ts');

const alias = [{ find: /^@socio\/shared\/(.*)$/, replacement: `${join(root, 'packages/shared/src')}/$1.ts` }];

// One copy whichever package asks: tentap's Tiptap is the web's version
// (pnpm-workspace.yaml's overrides), and dedupe makes Vite take the root's copy of each.
const dedupe = [
    'zod',
    'react',
    'react-dom',
    '@tiptap/core',
    '@tiptap/pm',
    '@tiptap/react',
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-transform',
];

/** The packages that must be one copy: Tiptap, ProseMirror and React. */
const SINGLE = /^(@tiptap\/|prosemirror-|react$|react-dom$)/;

/**
 * tentap's prebuilt web bundle (`@10play/tentap-editor/web`, its `lib-web/`)
 * carries its own Tiptap and ProseMirror inside it. Rollup counts those modules
 * as tentap's, which SINGLE ignores, so the copy check below can't see them:
 * the build refuses the entry itself. tentap's web side comes from its source.
 */
const TENTAP_WEB = /^@10play\/tentap-editor\/(web|lib-web)(\/|$)/;
const TENTAP_WEB_FILE = /\/@10play\/tentap-editor\/lib-web\//;

/** Fails the build on tentap's prebuilt web bundle, by import or by path. */
export const refuseTentapWeb = {
    name: 'socio-refuse-tentap-web',
    enforce: 'pre' as const,
    resolveId(source: string) {
        if (TENTAP_WEB.test(source)) {
            throw new Error(`${source} carries a second Tiptap and ProseMirror: import tentap's src/ instead.`);
        }
        return null;
    },
    load(id: string) {
        if (TENTAP_WEB_FILE.test(id)) {
            throw new Error(`${id} is tentap's prebuilt web bundle, with a second Tiptap and ProseMirror.`);
        }
        return null;
    },
};

/** Where a `<` that HTML reads inside a <script> may start: `</script`, `<script`, `<!--`. */
const HTML_IN_SCRIPT = /<(?=!--|\/?script)/gi;

/**
 * The script with every `<` that HTML would read inside a <script> written
 * `\x3C`: `</script` ends it early, and `<!--` then `<script` put the parser
 * where `</script>` no longer ends it. Only inside string and regular
 * expression literals and untagged templates, where `\x3C` is the same `<`
 * (marked's comment rule, React DOM's `<script><\/script>`); anywhere else,
 * a tagged template's raw text included, the build fails.
 */
export function inlineSafe(code: string) {
    const ranges: [number, number][] = [];
    const visit = (node: unknown, raw: boolean): void => {
        if (Array.isArray(node)) {
            node.forEach((child) => visit(child, raw));
            return;
        }
        if (!node || typeof node !== 'object') {
            return;
        }
        const { type, start, end } = node as { type?: string; start: number; end: number };
        if (type === 'Literal' && /^['"/]/.test(code[start] ?? '')) {
            ranges.push([start, end]);
        }
        if (type === 'TemplateElement' && !raw) {
            ranges.push([start, end]);
        }
        for (const [key, child] of Object.entries(node)) {
            // A tagged template's own text is raw; the expressions inside it aren't.
            const quasi = type === 'TaggedTemplateExpression' ? key === 'quasi' : false;
            visit(child, quasi || (type === 'TemplateLiteral' && raw && key === 'quasis'));
        }
    };
    visit(parseAst(code), false);
    return code.replace(HTML_IN_SCRIPT, (match, offset: number) => {
        if (!ranges.some(([start, end]) => start <= offset && offset < end)) {
            throw new Error(`The bundle holds "${code.slice(offset, offset + 8)}" outside a literal, at ${offset}.`);
        }
        return '\\x3C';
    });
}

/** `'sha256-…'` of a script's or a stylesheet's exact text, as a CSP source. */
export const cspHash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** The bundle of `entry` (editor/index.ts; a test's own) and its packages. */
export async function bundle(entry = join(editor, 'index.ts')) {
    const output = await build({
        configFile: false,
        logLevel: 'warn',
        root: editor,
        plugins: [refuseTentapWeb],
        resolve: { alias, dedupe },
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
            write: false,
            minify: true,
            target: 'es2020',
            lib: { entry, formats: ['iife'], name: 'socioEditor' },
        },
    });
    const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
        'output' in result ? result.output : [],
    );
    if (chunks.some((chunk) => chunk.type === 'asset')) {
        throw new Error('The bundle emitted an asset: styles go in editor/styles.ts, everything inline.');
    }
    const code = (chunks as Rollup.OutputChunk[]).map((chunk) => chunk.code).join('\n');
    // Each package folder the modules came from, by package name.
    const folders = new Map<string, Set<string>>();
    for (const id of (chunks as Rollup.OutputChunk[]).flatMap((chunk) => chunk.moduleIds)) {
        const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(id);
        if (match?.[1] && match[2] && SINGLE.test(match[2])) {
            folders.set(match[2], (folders.get(match[2]) ?? new Set()).add(match[1]));
        }
    }
    const doubled = [...folders].filter(([, paths]) => paths.size > 1);
    if (doubled.length > 0) {
        const list = doubled.map(([name, paths]) => `${name}: ${[...paths].map((path) => relative(root, path))}`);
        throw new Error(`The bundle holds two copies of:\n${list.join('\n')}`);
    }
    const packages = [...folders]
        .map(([name, [folder]]) => {
            const { version } = JSON.parse(readFileSync(join(folder!, 'package.json'), 'utf8')) as { version: string };
            return `${name}@${version}`;
        })
        .sort();
    return { js: inlineSafe(code), packages };
}

interface Inputs {
    pageCss: () => string;
    schemaNames: () => { nodes: string[]; marks: string[] };
    DYNAMIC_HEIGHT_CSS: string;
}

/** The stylesheets and the schema, from editor/build-inputs.ts under jsdom. */
async function inputs() {
    // jsdom ships no types; only its constructor and window are used.
    const name = 'jsdom';
    const { JSDOM } = (await import(name)) as { JSDOM: new (html: string, options: object) => { window: Window } };
    const { window } = new JSDOM('<!DOCTYPE html><body></body>', { pretendToBeVisual: true });
    const globals = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver'];
    const saved = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
    for (const key of globals) {
        Object.defineProperty(globalThis, key, {
            value: key === 'window' ? window : (window as unknown as Record<string, unknown>)[key],
            configurable: true,
            writable: true,
        });
    }
    const server = await createServer({
        configFile: false,
        logLevel: 'warn',
        root,
        resolve: { alias },
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] },
        ssr: { noExternal: ['@10play/tentap-editor'] },
    });
    try {
        const loaded = (await server.ssrLoadModule(join(editor, 'build-inputs.ts'))) as Inputs;
        return { css: loaded.pageCss(), schema: loaded.schemaNames(), dynamicHeightCss: loaded.DYNAMIC_HEIGHT_CSS };
    } finally {
        await server.close();
        window.close();
        globals.forEach((key, index) => {
            const descriptor = saved[index];
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                delete (globalThis as Record<string, unknown>)[key];
            }
        });
    }
}

/** The page's CSP. The meta goes first in <head>: a meta CSP covers only what follows it. */
export function contentSecurityPolicy(js: string, css: string, dynamicHeightCss: string) {
    return [
        "default-src 'none'",
        `script-src ${cspHash(js)} 'report-sample'`,
        // Our one <style>, the dynamic-height one tentap's native side injects on
        // every load, and the empty one it adds for each bridge with no extendCSS.
        `style-src ${cspHash(css)} ${cspHash(dynamicHeightCss)} ${cspHash('')} 'report-sample'`,
        'img-src data:',
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** The generated module's text, formatted the way the root's oxfmt leaves it. */
export async function generate() {
    const [{ js, packages }, { css, schema, dynamicHeightCss }] = [await bundle(), await inputs()];
    if (css.includes('</style')) {
        throw new Error('The stylesheet holds "</style".');
    }
    const csp = contentSecurityPolicy(js, css, dynamicHeightCss);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Page editor</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
    const source = `// Generated by apps/mobile/scripts/build-editor.mts from apps/mobile/editor/. Don't edit:
// run \`node apps/mobile/scripts/build-editor.mts\` after a change there, to the web's
// document extensions, or to Tiptap or tentap, and commit the result.
// oxlint-disable

/**
 * The page editor's HTML document, ${Buffer.byteLength(html, 'utf8')} bytes. Pass it as tentap's
 * RichText \`source\` (\`{ html: EDITOR_HTML }\`), never \`customSource\`: tentap then injects its
 * boot script from outside the page, where the CSP doesn't reach.
 */
export const EDITOR_HTML = ${JSON.stringify(html)};

/** The document's Content-Security-Policy. */
export const EDITOR_CSP = ${JSON.stringify(csp)};

/** The Tiptap, ProseMirror and React packages in the bundle, one copy each. */
export const EDITOR_PACKAGES = ${JSON.stringify(packages)};

/** The node and mark names of the bundle's schema. */
export const EDITOR_SCHEMA = ${JSON.stringify(schema)};
`;
    const formatted = spawnSync(join(root, 'node_modules/.bin/oxfmt'), [`--stdin-filepath=${OUTPUT}`], {
        cwd: root,
        input: source,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (formatted.status !== 0) {
        throw new Error(`oxfmt failed: ${formatted.stderr}`);
    }
    return formatted.stdout;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check')) {
        console.error('Usage: node apps/mobile/scripts/build-editor.mts [--check]');
        process.exit(2);
    }
    const text = await generate();
    if (args.includes('--check')) {
        let current = '';
        try {
            current = readFileSync(OUTPUT, 'utf8');
        } catch {}
        if (current !== text) {
            console.error(
                `${relative(root, OUTPUT)} is stale: run node apps/mobile/scripts/build-editor.mts and commit it.`,
            );
            process.exit(1);
        }
        console.log(`${relative(root, OUTPUT)} is current.`);
    } else {
        writeFileSync(OUTPUT, text);
        console.log(`Wrote ${relative(root, OUTPUT)}.`);
    }
    // Vite's handles would keep Node alive.
    process.exit(0);
}
