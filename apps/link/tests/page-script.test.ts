// The pages' script (src/page-script.ts), run as the Worker serves it against a stand-in browser
// (helpers.ts): it reads the fragment only to fill in the page, agrees with @socio/shared's
// parseAppLink on which links are whole, never makes a request (so no request carries the
// fragment), and never goes anywhere by itself: an invite forwards only on a tap.

import { describe, expect, it } from 'vitest';

import {
    APP_VARIANTS,
    type AppLink,
    appLink,
    isLinkHost,
    LINK_HOST,
    LINK_KINDS,
    LINK_STAGING_HOST,
    type LinkKind,
    normalizeCode,
    parseAppLink,
    SIGN_IN_CODE_LENGTH,
} from '@socio/shared/device-sign-in';

import { get, hostOf, pageParts, runPage } from './helpers';

const FIELDS: { [K in LinkKind]: AppLink<K>['fields'] } = {
    cb: { code: 'ABCDEFGH2345', state: 'state-abcdefghijklmnop' },
    c: { code: 'ABCD2345' },
    d: { c: 'ABCDEFGH2345' },
    i: { t: 'invite-token-123' },
    w: {},
};

const link = (variant: AppLink['variant'], kind: LinkKind, host = 'brain.example.com', fields = FIELDS[kind]) =>
    appLink({ kind, variant, host, fields } as AppLink, hostOf(variant));

/** Runs the page the Worker serves for `href`'s path, at `href`. */
async function open(href: string) {
    const url = new URL(href);
    const response = await get(url.pathname, {}, url.host);
    expect(response.status, href).toBe(200);
    return runPage(await response.text(), href);
}

/** Every way a page could reach the network or leave by itself. */
const expectStill = (run: Awaited<ReturnType<typeof open>>, href: string) => expect(run.touched, href).toEqual([]);

describe('a whole link', () => {
    it('fills in only the page, and gives no element a link back to the page itself', async () => {
        for (const variant of APP_VARIANTS) {
            for (const kind of LINK_KINDS) {
                const href = link(variant, kind);
                const run = await open(href);
                expectStill(run, href);
                expect(run.elements.get('invalid')?.hidden, href).toBe(true);
                expect(run.elements.has('open'), href).toBe(false);
                for (const element of run.elements.values()) {
                    expect(element.href === undefined || !element.href.startsWith(href.split('#')[0] ?? ''), href).toBe(
                        true,
                    );
                }
            }
        }
    });

    it("never shows the sheet's code on the callback page, nor the pairing code", async () => {
        for (const kind of ['cb', 'd'] as const) {
            const run = await open(link('production', kind));
            const shown = [...run.elements.values()].map((element) => element.textContent).join(' ');
            expect(shown, kind).not.toContain('ABCD');
        }
    });

    it('shows a sign-in code in groups of four, and only a well-formed one', async () => {
        const run = await open(link('production', 'c', 'brain.example.com', { code: 'abcd-2345' }));
        expect(run.elements.get('code')).toMatchObject({ hidden: false, textContent: 'ABCD-2345' });
        for (const code of ['ABCD234', 'ABCD23456', 'ABCD0345', 'ABCDO345', 'ABCD-23I5', '<b>ABCD2345</b>']) {
            const bad = await open(link('production', 'c', 'brain.example.com', { code }));
            expect(normalizeCode(code, SIGN_IN_CODE_LENGTH), code).toBeNull();
            expect(bad.elements.get('code')?.hidden, code).toBe(true);
            expect(bad.elements.get('invalid')?.hidden, code).toBe(false);
        }
    });
});

describe('an invite', () => {
    it('forwards to the workspace only through the button, on every path', async () => {
        for (const variant of APP_VARIANTS) {
            const href = link(variant, 'i', 'brain.example.com', { t: 'a b&c=d/é' });
            const run = await open(href);
            expectStill(run, href);
            expect(run.elements.get('continue'), variant).toMatchObject({
                hidden: false,
                href: 'https://brain.example.com/reset-password?token=a%20b%26c%3Dd%2F%C3%A9',
            });
        }
    });

    it('keeps the port on preview and development paths', async () => {
        const run = await open(link('development', 'i', 'localhost:3000'));
        expect(run.elements.get('continue')?.href).toBe('https://localhost:3000/reset-password?token=invite-token-123');
    });

    it('offers nothing to continue to without a token', async () => {
        const href = `https://${LINK_HOST}/app/i/brain.example.com`;
        const run = await open(href);
        expectStill(run, href);
        expect(run.elements.get('continue')?.hidden).toBe(true);
        expect(run.elements.get('invalid')?.hidden).toBe(false);
    });
});

describe('a broken link', () => {
    const shown = (run: Awaited<ReturnType<typeof open>>) => run.elements.get('invalid')?.hidden === false;

    it('agrees with parseAppLink, but refuses a workspace port on production paths', async () => {
        const fragments: Record<string, string[]> = {
            cb: [
                '',
                '#',
                '#code=ABCDEFGH2345&state=state-abcdefghijklmnop',
                '#code=ABCDEFGH2345&state=state-abcdefghijklmnop&ws=brain.example.com&x=1',
                '#code=ABCDEFGH2345&code=ABCDEFGH2345&state=s&ws=brain.example.com',
                '#code=&state=state-abcdefghijklmnop&ws=brain.example.com',
                '#code=ABCDEFGH2345&state&ws=brain.example.com',
                '#=x&code=ABCDEFGH2345&state=s&ws=brain.example.com',
                '#code=ABCDEFGH2345&state=%E0%A4%A&ws=brain.example.com',
                '#code=ABCDEFGH2345&state=s&ws=Brain.example.com',
                '#code=ABCDEFGH2345&state=s&ws=brain_example.com',
                '#code=ABCDEFGH2345&state=s&ws=brain.example.com:8443',
                '#code=ABCDEFGH2345&state=s&ws=localhost:3000',
                '#code=ABCDEFGH2345&state=s&ws=evil.example%2Fpath',
                `#code=ABCDEFGH2345&state=s&ws=${'a'.repeat(261)}`,
                '#code=ABCDEFGH2345&state=s&ws=brain.example.com',
            ],
            c: [
                '',
                '#code=ABCD2345',
                '#code=ABCD2345&ws=brain.example.com:1',
                '#code=ABCD2345&ws=brain.example.com',
                '#ws=brain.example.com',
            ],
            d: ['', '#', '#c=', '#c=ABCDEFGH2345&c=ABCDEFGH2345', '#c=ABCDEFGH2345&x=1', '#c=ABCDEFGH2345'],
            i: ['', '#t=', '#t=abc&t=abc', '#t=abc&ws=brain.example.com', '#t=abc', '#t=%ZZ'],
            w: ['', '#', '#x=1', '#t=abc'],
        };
        for (const variant of APP_VARIANTS) {
            for (const kind of LINK_KINDS) {
                const base = link(variant, kind).split('#')[0] ?? '';
                for (const fragment of fragments[kind] ?? []) {
                    const href = `${base}${fragment}`;
                    const parsed = parseAppLink(href, hostOf(variant));
                    const whole = parsed !== null && !(variant === 'production' && parsed.host.includes(':'));
                    const run = await open(href);
                    expectStill(run, href);
                    expect(shown(run), href).toBe(!whole);
                }
            }
        }
    });

    it('checks a workspace host in the fragment as isLinkHost does', async () => {
        const hosts = [
            'brain.example.com',
            'a',
            'a-b.c',
            '-a.b',
            'a-.b',
            'a..b',
            'a.b.',
            'xn--bcher-kva.example',
            'A.b',
            'a_b.c',
            'a.b:1',
            'a.b:123456',
            'a.b:',
            '1.2.3.4:80',
            '[::1]:80',
            'a b',
            'a.b/c',
            'a.b@c',
            `${'a'.repeat(250)}.example`,
            `${'a'.repeat(261)}`,
        ];
        for (const host of hosts) {
            const href = `https://${LINK_STAGING_HOST}/dev/c#code=ABCD2345&ws=${encodeURIComponent(host)}`;
            const run = await open(href);
            expect(run.elements.get('invalid')?.hidden, host).toBe(isLinkHost(host));
        }
    });
});

describe('the stand-in browser catches what a page script must not do', () => {
    /** A served page with its script swapped for `script`, run at a whole invite link. */
    const runInstead = async (script: string) => {
        const href = link('production', 'i');
        const url = new URL(href);
        const html = await (await get(url.pathname, {}, url.host)).text();
        const { scripts } = pageParts(html);
        return runPage(html.replace(scripts[0] ?? '', script), href);
    };

    it('passes the real script, which touches nothing else', async () => {
        const href = link('production', 'i');
        expect((await open(href)).touched).toEqual([]);
    });

    it.each([
        ['document.location', "document.location = 'https://x.example/?token=' + location.hash.slice(1);"],
        ['document.location.href', "document.location.href = 'https://x.example/' + location.hash;"],
        ['document.cookie', 'document.cookie = "t=" + location.hash;'],
        ['document.title', 'document.title = location.hash;'],
        ['document.write', 'document.write(location.hash);'],
        ['document.createElement', "document.createElement('img');"],
        ['document.body', 'document.body.innerHTML = location.hash;'],
        ['a bare location', "location = 'https://x.example/' + location.hash;"],
        ['location.href', "location.href = 'https://x.example/' + location.hash;"],
        ['location.assign', "location.assign('https://x.example/' + location.hash);"],
        ['window.location', "window.location = 'https://x.example/' + location.hash;"],
        ['a bare document', 'document = null;'],
        ['innerHTML', "document.getElementById('invalid').innerHTML = '<img src=x>';"],
        ['outerHTML', "document.getElementById('invalid').outerHTML = '<img src=x>';"],
        ['an href on a paragraph', "document.getElementById('invalid').href = 'https://x.example/';"],
        ['setAttribute', "document.getElementById('continue').setAttribute('href', 'https://x.example/');"],
        ['the data block', "document.getElementById('link-data').textContent = 'x';"],
        ['fetch', "fetch('/x' + location.hash);"],
        ['an image', "new Image().src = '/x' + location.hash;"],
        ['sendBeacon', "navigator.sendBeacon('/x', location.hash);"],
    ])('records %s', async (_, script) => {
        const run = await runInstead(`(function () { 'use strict'; ${script} })();`);
        expect(run.touched.length).toBeGreaterThan(0);
    });

    it("lets the invite's anchor take an href, and nothing else", async () => {
        const run = await runInstead(
            "document.getElementById('continue').href = 'https://brain.example.com/'; document.getElementById('invalid').hidden = false; document.getElementById('invalid').textContent = 'x';",
        );
        expect(run.touched).toEqual([]);
        expect(run.elements.get('continue')?.href).toBe('https://brain.example.com/');
    });
});
