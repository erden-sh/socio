import { describe, expect, it } from 'vitest';

import { ORIGIN, PAGE_KEYS, PAGES, SECURITY_EMAIL } from '../src/build/facts.ts';
import { SECURITY_TXT_EXPIRES } from '../src/build/files.ts';

import { distStaging, pageHtml, readBuilt, resolvePath } from './helpers.ts';

// The site's plain files: security.txt, robots.txt, sitemap.xml, llms.txt and
// llms-full.txt, as the build writes them.

describe('/.well-known/security.txt', () => {
    const file = readBuilt('.well-known/security.txt');
    const field = (name: string) => new RegExp(`^${name}: (.+)$`, 'm').exec(file)?.[1];

    it('has the RFC 9116 fields: Contact, Expires, Preferred-Languages and Canonical', () => {
        expect(field('Contact')).toBe(`mailto:${SECURITY_EMAIL}`);
        expect(field('Expires')).toBe(SECURITY_TXT_EXPIRES);
        expect(field('Preferred-Languages')).toBe('en');
        expect(field('Canonical')).toBe(`${ORIGIN}/.well-known/security.txt`);
        // A Policy line waits for the public repository.
        expect(field('Policy')).toBeUndefined();
    });

    it('expires less than a year ahead, and this fails 30 days before it does: renew it then', () => {
        const expires = Date.parse(SECURITY_TXT_EXPIRES);
        const days = (expires - Date.now()) / 86_400_000;
        expect(days, `security.txt expires ${SECURITY_TXT_EXPIRES}: move it a year on`).toBeGreaterThan(30);
        expect(days).toBeLessThanOrEqual(366);
    });
});

describe('robots.txt', () => {
    it('allows everything on production and names the sitemap', () => {
        expect(readBuilt('robots.txt')).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
    });

    it('disallows everything on staging', () => {
        expect(readBuilt('robots.txt', distStaging())).toBe('User-agent: *\nDisallow: /\n');
    });
});

describe('sitemap.xml', () => {
    it('lists the 8 pages, each with the build date', () => {
        const sitemap = readBuilt('sitemap.xml');
        const urls = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod><\/url>/g)];
        expect(urls.map((match) => match[1])).toEqual(PAGE_KEYS.map((key) => `${ORIGIN}${PAGES[key].path}`));
        expect(new Set(urls.map((match) => match[2])).size).toBe(1);
        expect(sitemap).not.toContain('404');
    });
});

describe('llms.txt and llms-full.txt', () => {
    it('llms.txt follows llmstxt.org: a title, a summary, and links that resolve', () => {
        const file = readBuilt('llms.txt');
        expect(file.startsWith('# Socio\n\n> ')).toBe(true);
        const links = [...file.matchAll(/\]\((https:\/\/socio\.sh[^)]*)\)/g)].map((match) => match[1] ?? '');
        expect(links.length).toBe(PAGE_KEYS.length + 1);
        for (const link of links) {
            expect(resolvePath(link.slice(ORIGIN.length) || '/'), link).not.toBeNull();
        }
    });

    it('llms-full.txt holds every page’s text, without the drawn app or the forms', () => {
        const file = readBuilt('llms-full.txt');
        for (const key of PAGE_KEYS) {
            expect(file, key).toContain(`Source: ${ORIGIN}${PAGES[key].path}\n`);
            const h1 = /<h1>([\s\S]*?)<\/h1>/
                .exec(pageHtml(key))?.[1]
                ?.replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ');
            expect(file, key).toContain(`# ${h1}`);
        }
        expect(file).toContain('We may update this policy from time to time');
        expect(file).not.toMatch(/<\/?(div|span|p|a|b|svg|img|section|br|ul|li|table|tr|td|details|summary)\b/);
        expect(file).not.toContain('Coral Street');
        expect(file).not.toContain('Leave this empty');
    });
});
