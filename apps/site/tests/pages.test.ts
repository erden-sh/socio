import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    ERASURE_DAYS,
    FORM_RETENTION_MONTHS,
    ORIGIN,
    PAGE_KEYS,
    PAGES,
    PRIVACY_EMAIL,
    PUBLISHER,
    SECURITY_EMAIL,
    SUPPORT_EMAIL,
} from '../src/build/facts.ts';
import { FORM_ACTION, FORM_KINDS, HONEYPOT } from '../src/build/forms.ts';

import { builtPages, dist, ids, pageHtml, readBuilt, resolvePath, text, walk } from './helpers.ts';

// The built pages (tests/global-setup.ts builds the site): every page exists with its search and
// link-preview tags, every internal link resolves, nothing breaks the CSP, no cloud provider is
// named, and the copy says what the owner confirmed on 2026-11-16.

describe('the build', () => {
    it('writes the 8 pages, the 404 page, and the site files', () => {
        const files = walk(dist());
        for (const key of PAGE_KEYS) {
            expect(files, key).toContain(PAGES[key].file);
        }
        expect(files).toEqual(
            expect.arrayContaining([
                '404.html',
                'favicon.svg',
                'apple-touch-icon.png',
                '.well-known/security.txt',
                'robots.txt',
                'sitemap.xml',
                'llms.txt',
                'llms-full.txt',
                '_headers',
            ]),
        );
        // One hashed stylesheet and one hashed script, nothing else in assets/.
        const assets = files.filter((file) => file.startsWith('assets/'));
        expect(assets).toHaveLength(2);
        expect(assets.some((file) => /^assets\/main-[\w-]+\.css$/.test(file))).toBe(true);
        expect(assets.some((file) => /^assets\/main-[\w-]+\.js$/.test(file))).toBe(true);
    });

    it('compiles the Tailwind utilities the pages use', () => {
        const css = readBuilt(walk(dist()).find((file) => file.endsWith('.css')) ?? '');
        for (const utility of [
            'tw\\:pt-0',
            'tw\\:mt-4',
            'tw\\:grid-cols-\\[minmax',
            'tw\\:\\[--tone2\\:var\\(--amber-500\\)\\]',
        ]) {
            expect(css).toContain(`.${utility}`);
        }
        // The tokens arrive whole, outside the layers, with the dark set under prefers-color-scheme.
        expect(css).toContain('--brand:#438c81');
        expect(css).toMatch(/@media \(prefers-color-scheme:\s*dark\)\{:root\{[^}]*--brand:#7cc3b6/);
        // No preflight: the site's own base styles, as the mockups had.
        expect(css).not.toMatch(/@layer base\{/);
    });
});

describe('every page', () => {
    it('has its title, description, canonical URL, Open Graph and X tags, and an og image that exists', () => {
        for (const key of PAGE_KEYS) {
            const html = pageHtml(key);
            const page = PAGES[key];
            const url = `${ORIGIN}${page.path}`;
            const meta = (attr: string, name: string) =>
                new RegExp(`<meta ${attr}="${name.replace(/[:]/g, '\\:')}" content="([^"]*)">`).exec(html)?.[1];
            expect(html, key).toContain(`<link rel="canonical" href="${url}">`);
            expect(meta('name', 'description'), key).toBeTruthy();
            for (const property of [
                'og:type',
                'og:site_name',
                'og:locale',
                'og:title',
                'og:description',
                'og:image:alt',
            ]) {
                expect(meta('property', property), `${key} ${property}`).toBeTruthy();
            }
            expect(meta('property', 'og:url'), key).toBe(url);
            expect(meta('property', 'og:image:width'), key).toBe('1200');
            expect(meta('property', 'og:image:height'), key).toBe('630');
            expect(meta('name', 'twitter:card'), key).toBe('summary_large_image');
            for (const name of ['twitter:title', 'twitter:description']) {
                expect(meta('name', name), `${key} ${name}`).toBeTruthy();
            }
            const image = meta('property', 'og:image') ?? '';
            expect(meta('name', 'twitter:image'), key).toBe(image);
            expect(image.startsWith(`${ORIGIN}/og/`), key).toBe(true);
            expect(resolvePath(image.slice(ORIGIN.length)), `${key} ${image}`).toBe(`og/${key}.png`);
            expect(html.match(/<meta name="theme-color"/g), key).toHaveLength(2);
            expect(html, key).toContain(
                '<link rel="alternate" type="text/plain" title="For AI agents" href="/llms.txt">',
            );
        }
    });

    it('has the shell: Sebas as the logo, the four nav links, the footer and the cookie settings', () => {
        for (const [key, html] of builtPages()) {
            expect(html, key).toMatch(/<a class="logo" href="\/"><span class="mark"><img src="\/art\/sebas\.svg"/);
            for (const href of ['/#features', '/self-host', '/hosted', '/support']) {
                expect(html, `${key} ${href}`).toContain(`<a href="${href}"`);
            }
            for (const href of [
                '/privacy',
                '/terms',
                '/cookies',
                '/delete-account',
                '/.well-known/security.txt',
                '/llms.txt',
            ]) {
                expect(html, `${key} ${href}`).toContain(`<li><a href="${href}">`);
            }
            expect(text(html), key).toContain(
                `© 2026 ${PUBLISHER} Socio, Socio.sh, Erden, and Erden.sh are trademarks of ${PUBLISHER} The socio characters are trademarks of ${PUBLISHER}`,
            );
            expect(html, key).toContain('id="consent-banner" hidden');
            expect(html, key).toContain('<dialog class="dialog" id="consent-settings"');
        }
    });

    it('resolves every internal link and fragment, and links out only to Erden', () => {
        const external = new Set<string>();
        for (const [key, html] of builtPages()) {
            const own = ids(html);
            for (const [, attr, value] of html.matchAll(/\s(href|src|action)="([^"]+)"/g)) {
                if (!value || value.startsWith('mailto:')) {
                    continue;
                }
                if (/^https?:/.test(value)) {
                    external.add(value);
                    continue;
                }
                if (value.startsWith('#')) {
                    expect(own.has(value.slice(1)), `${key}: ${value}`).toBe(true);
                    continue;
                }
                expect(value.startsWith('/'), `${key}: ${attr}=${value}`).toBe(true);
                if (attr === 'action') {
                    expect(value, key).toBe(FORM_ACTION);
                    continue;
                }
                const file = resolvePath(value);
                expect(file, `${key}: ${value}`).not.toBeNull();
                const fragment = value.split('#')[1];
                if (fragment && file?.endsWith('.html')) {
                    expect(ids(readBuilt(file)).has(fragment), `${key}: ${value}`).toBe(true);
                }
            }
        }
        // Canonical and og URLs on our own origin, and Erden: nothing else leaves the site.
        expect([...external].filter((url) => !url.startsWith(`${ORIGIN}/`))).toEqual(['https://erden.sh']);
    });

    it('sets no inline style or script, so the CSP holds without exceptions', () => {
        for (const [key, html] of builtPages()) {
            expect(html, key).not.toMatch(/\sstyle="/);
            expect(html, key).not.toMatch(/<style[\s>]/);
            expect(html, key).not.toMatch(/\son[a-z]+="/);
            expect(html, key).not.toMatch(/javascript:/);
            for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
                // Our own module, or JSON-LD (a data block, never run).
                expect(tag, key).toMatch(
                    /^<script (type="module" src="\/assets\/main-[\w-]+\.js"|type="application\/ld\+json")>$/,
                );
            }
        }
    });

    it('names no cloud or hosting provider anywhere on the site', () => {
        const PROVIDERS =
            /cloudflare|workers\.dev|\baws\b|amazon web services|\bec2\b|\bs3\b|google cloud|\bgcp\b|firebase|azure|microsoft cloud|hetzner|digitalocean|vercel|netlify|fly\.io|render\.com|heroku|linode|akamai|vultr|\bovh|oracle cloud|backblaze|wasabi|seaweedfs|\bd1\b|\br2\b|resend|tailscale/i;
        const files = walk(dist()).filter((file) => /\.(html|txt|xml)$/.test(file));
        expect(files.length).toBeGreaterThan(10);
        for (const file of files) {
            const content = readBuilt(file);
            expect(PROVIDERS.exec(content)?.[0], file).toBeUndefined();
        }
    });
});

describe('the confirmed copy', () => {
    const all = builtPages()
        .map(([, html]) => text(html))
        .join(' ');

    it('has no placeholder or draft marker left', () => {
        expect(all).not.toMatch(/\bCONFIRM\b|\bTODO\b|\bTBD\b/);
        expect(all).not.toMatch(
            /confirm-tag|this is a draft|\bdraft (policy|terms|version|text)\b|placeholder:|lorem ipsum/i,
        );
    });

    it('gives the support, privacy and security addresses at ingenioventures.com, as mailto links', () => {
        expect(pageHtml('support')).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
        expect(pageHtml('support')).toContain(`href="mailto:${SECURITY_EMAIL}"`);
        expect(pageHtml('privacy')).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
        expect(pageHtml('delete-account')).toContain(`href="mailto:${PRIVACY_EMAIL}"`);
        for (const email of all.match(/[\w.+-]+@[\w.-]+\.[a-z]+/g) ?? []) {
            expect([SUPPORT_EMAIL, PRIVACY_EMAIL, SECURITY_EMAIL], email).toContain(email);
        }
    });

    it('names Ingenio Ventures Inc. and Florida law, and keeps the erasure and form retention windows', () => {
        expect(text(pageHtml('terms'))).toContain('governed by the laws of the State of Florida, USA');
        expect(text(pageHtml('delete-account'))).toContain(`Permanent removal completes within ${ERASURE_DAYS} days`);
        expect(ERASURE_DAYS).toBe(30);
        expect(text(pageHtml('privacy'))).toContain(`deleted ${FORM_RETENTION_MONTHS} months after our last contact`);
        expect(FORM_RETENTION_MONTHS).toBe(12);
        for (const key of ['privacy', 'terms', 'cookies'] as const) {
            const page = text(pageHtml(key));
            expect(page, key).toContain(`Last updated November 16, 2026 ${PUBLISHER}`);
            expect(page, key).toMatch(/We may update (this policy|these terms) from time to time/);
        }
    });

    it('has the privacy policy’s 13 sections, the terms’ 11 and the cookie policy’s 6', () => {
        const count = (html: string) =>
            (html.match(/<article class="prose">[\s\S]*<\/article>/)?.[0].match(/<h2 id=/g) ?? []).length;
        expect(count(pageHtml('privacy'))).toBe(13);
        expect(count(pageHtml('terms'))).toBe(11);
        expect(count(pageHtml('cookies'))).toBe(6);
    });

    it('says rejecting analytics counts page views with no cookie (owner answer 3)', () => {
        expect(text(pageHtml('cookies'))).toContain('if you reject them, we count page views alone, with no cookie');
        expect(text(pageHtml('privacy'))).toContain(
            'we only count page views, with no cookie and nothing that identifies you',
        );
    });

    it('calls the code page Self-host, at /self-host (owner answer 1)', () => {
        expect(PAGES['self-host'].path).toBe('/self-host');
        expect(all).not.toMatch(/Open source/);
        expect(existsSync(join(dist(), 'open-source.html'))).toBe(false);
    });

    it('shows all eight socios on the home page, with no store badge or repository link before launch', () => {
        const home = pageHtml('home');
        for (const name of ['Sebas', 'Manny', 'Mingo', 'Rulo', 'Lino', 'Flake', 'Iggy', 'Rosy']) {
            expect(home, name).toMatch(new RegExp(`<h3>${name}</h3>`));
        }
        expect(all).not.toMatch(/App Store|Google Play/);
        expect(home).not.toMatch(/github\.com/);
    });

    it('has JSON-LD for the publisher and the app on the home page only', () => {
        const blocks = [...pageHtml('home').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
        expect(blocks).toHaveLength(1);
        const data = JSON.parse(blocks[0]?.[1] ?? '') as { '@type': string; name: string }[];
        expect(data.map((item) => [item['@type'], item.name])).toEqual([
            ['Organization', PUBLISHER],
            ['SoftwareApplication', 'Socio'],
        ]);
        for (const key of PAGE_KEYS.filter((key) => key !== 'home')) {
            expect(pageHtml(key), key).not.toContain('application/ld+json');
        }
    });
});

describe('the forms', () => {
    it('post to the Worker without JavaScript, each with its kind and the honeypot', () => {
        const kinds: string[] = [];
        for (const [key, html] of builtPages()) {
            for (const [form] of html.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
                expect(form, key).toMatch(new RegExp(`^<form class="[^"]*" method="post" action="${FORM_ACTION}">`));
                const kind = /<input type="hidden" name="kind" value="([^"]+)">/.exec(form)?.[1] ?? '';
                kinds.push(kind);
                expect(form, key).toContain(`name="${HONEYPOT}" tabindex="-1" autocomplete="off"`);
                expect(form, key).toMatch(/<button class="[^"]*" type="submit">/);
                expect(form, key).toMatch(/name="email" type="email"[^>]* required/);
                // Every field a person fills has a label.
                for (const [, id] of form.matchAll(/<(?:input|select|textarea) class="[^"]*" id="([^"]+)"/g)) {
                    expect(form, `${key} #${id}`).toContain(`<label for="${id}">`);
                }
            }
        }
        expect(kinds.sort()).toEqual([...FORM_KINDS].sort());
    });

    it('leave no made-up visitor data in the fields', () => {
        for (const [key, html] of builtPages()) {
            for (const [form] of html.matchAll(/<form\b[\s\S]*?<\/form>/g)) {
                expect(form.match(/<input(?![^>]*type="(hidden|checkbox)")[^>]*\svalue="/g), key).toBeNull();
                expect(form, key).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/);
            }
        }
    });
});
