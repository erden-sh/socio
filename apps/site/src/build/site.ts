import { headersFile, type SiteEnv } from '../worker/headers.ts';

import { CHARACTERS, readArt } from './art.ts';
import { PAGE_KEYS, PAGES, type PageKey } from './facts.ts';
import { llmsFullTxt, llmsTxt, robotsTxt, securityTxt, sitemapXml } from './files.ts';
import type { Assets } from './layout.ts';
import { deleteAccount } from './pages/delete-account.ts';
import { home } from './pages/home.ts';
import { hosted } from './pages/hosted.ts';
import { cookies, privacy, terms } from './pages/legal.ts';
import { notFound } from './pages/not-found.ts';
import { selfHost } from './pages/self-host.ts';
import { support } from './pages/support.ts';

// Everything the build writes besides Vite's own bundle: the pages, the character art, the
// favicon, the plain files and _headers. vite.config.ts's plugin emits each into dist/.

const RENDER: Record<PageKey, (assets: Assets) => string> = {
    home,
    'self-host': selfHost,
    hosted,
    support,
    privacy,
    terms,
    cookies,
    'delete-account': deleteAccount,
};

export interface SiteOptions {
    assets: Assets;
    env: SiteEnv;
    /** The sitemap's lastmod, YYYY-MM-DD. */
    built: string;
}

/** Every file, by its path under dist/. */
export function renderSite({ assets, env, built }: SiteOptions): Map<string, string> {
    const files = new Map<string, string>();
    const pages = Object.fromEntries(PAGE_KEYS.map((key) => [key, RENDER[key](assets)])) as Record<PageKey, string>;
    for (const key of PAGE_KEYS) {
        files.set(PAGES[key].file, pages[key]);
    }
    files.set('404.html', notFound(assets));
    for (const id of CHARACTERS) {
        files.set(`art/${id}.svg`, readArt(id));
    }
    files.set('favicon.svg', readArt('sebas'));
    files.set('.well-known/security.txt', securityTxt());
    files.set('robots.txt', robotsTxt(env));
    files.set('sitemap.xml', sitemapXml(built));
    files.set('llms.txt', llmsTxt());
    files.set('llms-full.txt', llmsFullTxt(pages));
    files.set('_headers', headersFile(env));
    return files;
}
