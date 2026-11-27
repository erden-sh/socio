// The pages (src/pages.ts): one for every variant and kind, the paths @socio/shared's parseAppLink
// takes and no other, production refusing a host with a port, and nothing on a page that could
// make a request: no third-party anything, a CSP that allows only the page's own script and style.

import { describe, expect, it } from 'vitest';

import {
    APP_VARIANTS,
    type AppLink,
    appLink,
    LINK_HOST,
    LINK_KINDS,
    type LinkKind,
    parseAppLink,
    VARIANT_LINK_PATHS,
} from '@socio/shared/device-sign-in';

import { LINK_APPS } from '../src/apps';
import { PAGE_SCRIPT } from '../src/page-script';
import { FRAGMENT_KEYS, hostParts, parseLinkPath, STORE_LINKS } from '../src/pages';

import { get, hostOf, pageParts, runPage } from './helpers';

const FIELDS: { [K in LinkKind]: AppLink<K>['fields'] } = {
    cb: { code: 'ABCDEFGH2345', state: 'state-abcdefghijklmnop' },
    c: { code: 'ABCD2345' },
    d: { c: 'ABCDEFGH2345' },
    i: { t: 'invite-token-123' },
    w: {},
};

const link = (variant: AppLink['variant'], kind: LinkKind, host = 'brain.example.com') =>
    appLink({ kind, variant, host, fields: FIELDS[kind] } as AppLink, hostOf(variant));
/** A link's path: what the Worker sees. */
const pathOf = (href: string) => new URL(href).pathname;

describe('the pages', () => {
    it('serve a page for every variant and kind, with the headers that keep it to itself', async () => {
        for (const variant of APP_VARIANTS) {
            for (const kind of LINK_KINDS) {
                const response = await get(pathOf(link(variant, kind)));
                expect(response.status, `${variant} ${kind}`).toBe(200);
                expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
                expect(response.headers.get('referrer-policy')).toBe('no-referrer');
                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(response.headers.get('x-frame-options')).toBe('DENY');
                expect(response.headers.get('content-security-policy')).toMatch(/^default-src 'none'; /);
            }
        }
    });

    it("write the fragment's keys appLink writes for each kind", () => {
        for (const kind of LINK_KINDS) {
            const href = link('production', kind);
            const fragment = new URL(href).hash.slice(1);
            const keys = fragment ? fragment.split('&').map((pair) => pair.split('=')[0]) : [];
            expect([...keys].sort(), kind).toEqual([...FRAGMENT_KEYS[kind]].sort());
        }
    });

    it('take exactly the paths parseAppLink takes, but a production host with a port', () => {
        const paths = [
            ...APP_VARIANTS.flatMap((variant) =>
                LINK_KINDS.flatMap((kind) => [
                    pathOf(link(variant, kind)),
                    pathOf(link(variant, kind, 'localhost:8080')),
                    pathOf(link(variant, kind, '192.168.1.20:3000')),
                    pathOf(link(variant, kind, 'workspace')),
                ]),
            ),
            '/',
            '/app',
            '/app/',
            '/app/x',
            '/app/cb/',
            '/app/cb/brain.example.com',
            '/app/c/extra',
            '/app/w',
            '/app/w/',
            '/app/w/brain.example.com/',
            '/app/w/brain.example.com/more',
            '/app/w/Brain.Example.com',
            '/app/w/brain_example.com',
            '/app/w/-brain.example.com',
            '/app/w/brain.example.com.',
            '/app/w/brain..example.com',
            '/app/w/brain%2Eexample.com',
            '/app/w/brain.example.com:',
            '/app/w/brain.example.com:123456',
            `/app/w/${'a'.repeat(261)}`,
            '/App/w/brain.example.com',
            '/production/w/brain.example.com',
            '/prod/w/brain.example.com',
            '/preview/W/brain.example.com',
            '//app/w/brain.example.com',
            '/app//w/brain.example.com',
        ];
        for (const path of paths) {
            const kind = path.split('/')[2] ?? '';
            const fragment = (LINK_KINDS as readonly string[]).includes(kind)
                ? new URL(link('development', kind as LinkKind)).hash
                : '';
            const parsed = parseAppLink(`https://${LINK_HOST}${path}${fragment}`);
            const expected = parsed !== null && !(parsed.variant === 'production' && parsed.host.includes(':'));
            expect(parseLinkPath(path) !== null, path).toBe(expected);
        }
    });

    it('refuse a host with a port on production paths only', async () => {
        for (const kind of ['d', 'i', 'w'] as const) {
            expect((await get(`/app/${kind}/brain.example.com:8443`)).status, kind).toBe(404);
            expect((await get(`/preview/${kind}/brain.example.com:8443`)).status, kind).toBe(200);
            expect((await get(`/dev/${kind}/localhost:3000`)).status, kind).toBe(200);
        }
    });

    it('answer anything else with the same plain 404, a query too', async () => {
        for (const path of [
            '/',
            '/favicon.ico',
            '/app/w/brain.example.com?utm_source=x',
            '/app/cb?code=ABCD',
            '/.well-known/x',
        ]) {
            const response = await get(path);
            expect(response.status, path).toBe(404);
            expect(await response.text(), path).toContain('Not a Socio link');
        }
    });

    it('take GET and HEAD only, and HEAD has no body', async () => {
        const head = await get('/app/w/brain.example.com', { method: 'HEAD' });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
            const response = await get('/app/w/brain.example.com', { method });
            expect(response.status, method).toBe(405);
            expect(response.headers.get('allow')).toBe('GET, HEAD');
        }
    });

    it('show the workspace host with its registrable domain emphasized', async () => {
        expect(hostParts('brain.example.test')).toEqual({ lead: 'brain.', domain: 'example.test', port: '' });
        expect(hostParts('localhost:3000')).toEqual({ lead: '', domain: 'localhost', port: ':3000' });
        expect(hostParts('192.168.1.20:3000')).toEqual({ lead: '', domain: '192.168.1.20', port: ':3000' });
        const html = await (await get('/app/i/acme.brain.example.com')).text();
        expect(html).toContain('<p class="host"><span>acme.brain.</span><b>example.com</b></p>');
    });
});

describe('nothing on a page makes a request', () => {
    const pages = async () =>
        Promise.all(
            [...APP_VARIANTS.flatMap((variant) => LINK_KINDS.map((kind) => pathOf(link(variant, kind)))), '/'].map(
                async (path) => ({ path, response: await get(path) }),
            ),
        );

    it('allow only their own inline script and style, by hash', async () => {
        const digest = async (text: string) =>
            Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64');
        for (const { path, response } of await pages()) {
            const html = await response.text();
            const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
            expect(response.headers.get('content-security-policy'), path).toBe(
                [
                    "default-src 'none'",
                    `script-src 'sha256-${await digest(PAGE_SCRIPT)}'`,
                    `style-src 'sha256-${await digest(style)}'`,
                    "base-uri 'none'",
                    "form-action 'none'",
                    "frame-ancestors 'none'",
                    "require-trusted-types-for 'script'",
                ].join('; '),
            );
            const { scripts } = pageParts(html);
            expect(scripts, path).toEqual(path === '/' ? [] : [PAGE_SCRIPT]);
        }
    });

    it('load nothing: no src, no stylesheet, no form, no frame, no outside URL', async () => {
        for (const { path, response } of await pages()) {
            const html = await response.text();
            expect(html, path).not.toMatch(/\ssrc=|<link|<form|<iframe|<img|<object|<embed|@import|url\(/i);
            // The script's one URL is the invite's, which it builds from the path's host for the button.
            const markup = html.replace(PAGE_SCRIPT, '');
            expect(markup.match(/https?:\/\/[^\s"'<]*/g) ?? [], path).toEqual([]);
            expect(PAGE_SCRIPT.match(/https?:\/\/[^\s"'<]*/g)).toEqual(['https://']);
            expect(html, path).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
        }
    });

    it('never show the code on the sheet callback or Add a device pages', async () => {
        for (const variant of APP_VARIANTS) {
            for (const kind of ['cb', 'd'] as const) {
                const html = await (await get(pathOf(link(variant, kind)))).text();
                expect(html, `${variant} ${kind}`).not.toContain('id="code"');
            }
        }
    });

    it('link no store yet: placeholders until the launch, and the page says to ask the admin', async () => {
        expect(STORE_LINKS).toEqual({ appStore: null, play: null });
        expect(await (await get('/app/w/brain.example.com')).text()).toContain("ask your workspace's admin");
    });

    it('name the variant on test-build invites', async () => {
        expect(await (await get('/preview/i/brain.example.com')).text()).toContain('a test build');
        expect(await (await get('/app/i/brain.example.com')).text()).not.toContain('a test build');
        expect(VARIANT_LINK_PATHS.production).toBe('app');
    });
});

describe('how a page gets back to the app', () => {
    /** Every href a page has, as served and after its script ran on a whole link. */
    const hrefs = async (href: string) => {
        const url = new URL(href);
        const html = await (await get(url.pathname, {}, url.host)).text();
        const served = [...html.matchAll(/\shref="([^"]*)"/g)].map((match) => match[1] ?? '');
        const filled = [...runPage(html, href).elements.values()].flatMap((element) => element.href ?? []);
        return [...served, ...filled];
    };

    it('never links a page to itself, which iOS would keep in Safari', async () => {
        for (const variant of APP_VARIANTS) {
            for (const kind of LINK_KINDS) {
                const href = link(variant, kind);
                const self = href.split('#')[0] ?? '';
                for (const target of await hrefs(href)) {
                    expect(target.startsWith(self) || target.startsWith('#'), `${variant} ${kind}: ${target}`).toBe(
                        false,
                    );
                }
            }
        }
    });

    it('builds no custom-scheme URL carrying anything: only a bare scheme, and only on w', async () => {
        for (const variant of APP_VARIANTS) {
            const scheme = LINK_APPS.find((app) => app.variant === variant)?.scheme;
            for (const kind of LINK_KINDS) {
                const custom = (await hrefs(link(variant, kind))).filter((target) => !target.startsWith('https://'));
                expect(custom, `${variant} ${kind}`).toEqual(kind === 'w' ? [`${scheme}://`] : []);
                for (const target of custom) {
                    expect(target, `${variant} ${kind}`).not.toMatch(/code|state|[?#&]c=|[?#&]t=/);
                }
            }
        }
        // The script's only URL is the https one it builds for the invite.
        expect(PAGE_SCRIPT.match(/[a-z][a-z0-9+.-]*:\/\//gi)).toEqual(['https://']);
    });

    it('tells the person what to do instead, and never shows the code on cb', async () => {
        const text = async (path: string) => (await get(path)).text();
        const cb = await text('/app/cb');
        expect(cb).toContain('Go back to the Socio app and choose Continue again.');
        expect(cb).not.toMatch(/<a\s|<output|id="code"/);
        const device = await text('/app/d/brain.example.com');
        expect(device).toContain('go to Add a workspace and tap “Scan the QR code from Socio on a computer.”');
        expect(device).toContain('Opening this link from your camera or a message also works.');
        expect(device).toContain('If it keeps opening here, update Socio and scan again.');
        expect(device).not.toMatch(/<output|id="code"/);
        expect(await text('/app/c')).toContain('type this code there');
        const invite = await text('/app/i/brain.example.com');
        expect(invite).toContain('id="continue"');
        expect(invite).not.toMatch(/<a\s[^>]*href="(?!https:)/);
    });

    it('keeps hidden elements hidden whatever their class says', async () => {
        const html = await (await get('/app/i/brain.example.com')).text();
        expect(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1]).toContain('[hidden]{display:none!important}');
    });
});
