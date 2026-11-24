import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { inject } from 'vitest';

import { PAGE_KEYS, PAGES, type PageKey } from '../src/build/facts.ts';

export const dist = () => inject('dist');
export const distStaging = () => inject('distStaging');

export const readBuilt = (path: string, root = dist()) => readFileSync(join(root, path), 'utf8');

/** Every built page's HTML, by key, plus the 404 page. */
export function builtPages(): [string, string][] {
    return [
        ...PAGE_KEYS.map((key): [string, string] => [key, readBuilt(PAGES[key].file)]),
        ['404', readBuilt('404.html')],
    ];
}

export const pageHtml = (key: PageKey) => readBuilt(PAGES[key].file);

/** Every file under dir, relative to it. */
export function walk(dir: string): string[] {
    const out: string[] = [];
    const visit = (path: string) => {
        for (const name of readdirSync(path)) {
            const full = join(path, name);
            if (statSync(full).isDirectory()) {
                visit(full);
            } else {
                out.push(relative(dir, full));
            }
        }
    };
    visit(dir);
    return out;
}

/**
 * The file a site path resolves to under dist/, the way Workers static assets resolve it
 * (html_handling auto-trailing-slash): `/` → index.html, `/x` → x.html or x/index.html, and a
 * file path as itself. Null when nothing serves it.
 */
export function resolvePath(path: string, root = dist()): string | null {
    const clean = decodeURIComponent(path.split('#')[0]?.split('?')[0] ?? '');
    const candidates =
        clean === '/' ? ['index.html'] : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
    return (
        candidates.find((file) => file && existsSync(join(root, file)) && statSync(join(root, file)).isFile()) ?? null
    );
}

/** The ids a page defines. */
export const ids = (html: string) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

/** A page's visible text: tags, scripts and styles dropped. */
export const text = (html: string) =>
    html
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');
