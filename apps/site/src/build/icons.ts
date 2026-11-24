import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

// Lucide icons, the client's set (lucide-react, a root dependency), inlined as SVG at build time.
// Each icon module holds its drawing as `__iconData.node`: [tag, attributes] pairs. The site loads
// no icon font and no React; the markup is the same as lucide's own.

const require = createRequire(import.meta.url);
const ICONS = join(dirname(require.resolve('lucide-react/package.json')), 'dist/esm/icons');
const cache = new Map<string, string>();

type IconNode = [string, Record<string, string>][];

function inner(name: string): string {
    let svg = cache.get(name);
    if (svg === undefined) {
        const source = readFileSync(join(ICONS, `${name}.mjs`), 'utf8');
        // A renamed icon re-exports its new name's module.
        const alias = /export \{ default \} from '\.\/([\w-]+)\.mjs'/.exec(source);
        if (alias?.[1]) {
            svg = inner(alias[1]);
            cache.set(name, svg);
            return svg;
        }
        const match = /node: (\[[\s\S]*?\]),\n\s*aliases/.exec(source) ?? /node: (\[[\s\S]*?\])\n\};/.exec(source);
        if (!match) {
            throw new Error(`lucide icon ${name}: no node`);
        }
        // A literal of arrays, objects and strings: evaluated with no globals at all.
        const nodes = runInNewContext(`(${match[1]})`, Object.create(null)) as IconNode;
        svg = nodes
            .map(
                ([tag, attrs]) =>
                    `<${tag} ${Object.entries(attrs)
                        .filter(([key]) => key !== 'key')
                        .map(([key, value]) => `${key}="${value}"`)
                        .join(' ')}/>`,
            )
            .join('');
        cache.set(name, svg);
    }
    return svg;
}

export const icon = (name: string, cls = 'i') =>
    `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner(name)}</svg>`;
