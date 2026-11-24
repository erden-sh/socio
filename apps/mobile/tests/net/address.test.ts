import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLEARTEXT_HOSTS } from '../../plugins/network-security';
import { addressRules, checkAddress, checkUrl, LOCAL_HTTP_HOSTS } from '../../src/net/address';
import { VARIANTS, type VariantName } from '../../variant';

// Workspace addresses: what a
// person may type, and which origins each variant's builds accept.

/** A check's outcome as one string: the origin, or the problem. */
function outcome(text: string, variant: string): string {
    const checked = checkAddress(text, variant);
    return checked.ok ? checked.address.origin : checked.problem;
}

const B = 'https://brain.example.test';
const ALL = (expected: string): [string, string, string] => [expected, expected, expected];

/** [what the person types, production, preview, development]. */
const VECTORS: [string, string, string, string][] = [
    // Any https host on the default port, in every build (owner, 2026-11-15).
    ['brain.example.test', ...ALL(B)],
    ['https://brain.example.test', ...ALL(B)],
    ['brain.example.org', ...ALL('https://brain.example.org')],
    ['https://team.example.org/', ...ALL('https://team.example.org')],
    ['acme.socio.app', ...ALL('https://acme.socio.app')],
    ['https://brain.acme.example.test', ...ALL('https://brain.acme.example.test')],
    ['example.com', ...ALL('https://example.com')],

    // A host before an `@` isn't the host: userinfo, in every variant.
    ['https://brain.example.test@evil.example', ...ALL('userinfo')],
    ['brain.example.test@evil.example', ...ALL('userinfo')],
    ['https://ada:secret@brain.example.test', ...ALL('userinfo')],
    ['ada@brain.example.test', ...ALL('userinfo')],
    ['https://@evil.example', ...ALL('userinfo')],
    // The URL's host is evil.example in both, though a reader takes the one after the `@`.
    ['evil.example\\@brain.example.test', ...ALL('userinfo')],
    ['evil.example?@brain.example.test', ...ALL('userinfo')],
    ['brain.example.test#@evil.example', ...ALL('userinfo')],
    // The parser skips every slash and backslash after the scheme, so the authority starts after them too.
    ['//evil.example\\@brain.example.test', ...ALL('userinfo')],
    ['https:////evil.example\\@brain.example.test', ...ALL('userinfo')],
    ['https://\\\\/evil.example\\@brain.example.test', ...ALL('userinfo')],
    ['///evil.example?@brain.example.test', ...ALL('userinfo')],
    ['https:///evil.example#@brain.example.test', ...ALL('userinfo')],
    ['//@evil.example', ...ALL('userinfo')],
    // Those slashes alone change nothing.
    ['https:////brain.example.test', ...ALL(B)],

    // A host that starts like another is its own host: the screens show it, its registrable domain emphasized.
    ['brain.example.test.evil.example', ...ALL('https://brain.example.test.evil.example')],
    ['https://brain.example.test%2eevil.example', ...ALL('https://brain.example.test.evil.example')],
    ['example.test', ...ALL('https://example.test')],
    ['other.example.test', ...ALL('https://other.example.test')],

    // Case.
    ['BRAIN.EXAMPLE.TEST', ...ALL(B)],
    ['HTTPS://Brain.Example.Test/', ...ALL(B)],

    // One trailing dot goes; any other empty label is broken.
    ['brain.example.test.', ...ALL(B)],
    ['https://brain.example.test./chats', ...ALL(B)],
    ['brain.example.test..', ...ALL('unreadable')],
    ['brain..example.test', ...ALL('unreadable')],
    ['.brain.example.test', ...ALL('unreadable')],

    // Ports: the default is no port at all.
    ['https://brain.example.test:443', ...ALL(B)],
    ['brain.example.test:443', ...ALL(B)],
    ['https://brain.example.test:0443', ...ALL(B)],
    ['brain.example.test:8443', 'port', ...pair('https://brain.example.test:8443')],
    ['https://brain.example.test:99999', ...ALL('unreadable')],

    // IDNs: UTS #46, then punycode, which is what the screens show.
    ['brаin.example.test', ...ALL('https://xn--brin-63d.example.test')], // a Cyrillic а
    ['ｂｒａｉｎ。ｅｘａｍｐｌｅ。ｔｅｓｔ', ...ALL(B)], // full-width letters and dots map to the same host
    ['bücher.example', ...ALL('https://xn--bcher-kva.example')],
    ['https://xn--bcher-kva.example', ...ALL('https://xn--bcher-kva.example')],

    // Only the origin is kept: the path, query and fragment go.
    ['https://brain.example.test/chats/abc?tab=1#message-9', ...ALL(B)],
    ['brain.example.test/chats/abc', ...ALL(B)],
    ['https://brain.example.test/@evil.example', ...ALL(B)],

    // Whitespace: trimmed around it, refused inside it (the URL parser would drop tabs and line breaks).
    ['  brain.example.test\n', ...ALL(B)],
    [' brain.example.test　', ...ALL(B)],
    ['brain.example .test', ...ALL('unreadable')],
    ['brain.example\t.test', ...ALL('unreadable')],
    ['brain.example\n.test', ...ALL('unreadable')],
    ['https://brain.example.test/a b', ...ALL('unreadable')],
    ['', ...ALL('empty')],
    [' \n\t', ...ALL('empty')],

    // Schemes.
    ['http://brain.example.test', ...ALL('insecure')],
    ['ftp://brain.example.test', ...ALL('scheme')],
    ['wss://brain.example.test', ...ALL('scheme')],
    ['socio://w/abc', ...ALL('scheme')],
    // No `://`, so https is assumed: https://javascript:alert(1) isn't a URL.
    ['javascript:alert(1)', ...ALL('unreadable')],
    ['https://', ...ALL('unreadable')],
    ['https:///', ...ALL('unreadable')],

    // Local servers: plain http only in development, only to the network config's hosts, on any port.
    ['http://localhost:4352', 'insecure', 'insecure', 'http://localhost:4352'],
    ['http://127.0.0.1:4352', 'insecure', 'insecure', 'http://127.0.0.1:4352'],
    ['http://10.0.2.2:4352', 'insecure', 'insecure', 'http://10.0.2.2:4352'],
    ['HTTP://LOCALHOST.:4352/chats', 'insecure', 'insecure', 'http://localhost:4352'],
    ['http://127.1:4352', 'insecure', 'insecure', 'http://127.0.0.1:4352'],
    ['http://localhost:80', 'insecure', 'insecure', 'http://localhost'],
    ['http://[::1]:4352', ...ALL('insecure')],
    ['http://192.168.1.20:4352', ...ALL('insecure')],
    ['http://localhost.evil.example', ...ALL('insecure')],
    ['http://app.localhost:4352', ...ALL('insecure')],
    // With no scheme it's https: every build takes any host, and a test build any port too.
    ['localhost:4352', 'port', ...pair('https://localhost:4352')],
    ['https://10.0.0.5', ...ALL('https://10.0.0.5')],
    ['https://[::1]:8443', 'port', ...pair('https://[::1]:8443')],
];

function pair(expected: string): [string, string] {
    return [expected, expected];
}

const COLUMNS: VariantName[] = ['production', 'preview', 'development'];

describe('checkAddress', () => {
    it.each(COLUMNS.map((variant, column) => [variant, column] as const))(
        'accepts what the %s build accepts, and nothing else',
        (variant, column) => {
            for (const [text, ...expected] of VECTORS) {
                expect(outcome(text, variant), JSON.stringify(text)).toBe(expected[column]);
            }
        },
    );

    it("gives production's rules to any value that names no test build", () => {
        expect(addressRules('development')).toBe('development');
        expect(addressRules('preview')).toBe('preview');
        for (const variant of [
            'production',
            'staging',
            '',
            'Preview',
            'DEVELOPMENT',
            'dev',
            'toString',
            'constructor',
        ]) {
            expect(addressRules(variant), variant).toBe('production');
            for (const [text, production] of VECTORS) {
                expect(outcome(text, variant), `${variant}: ${JSON.stringify(text)}`).toBe(production);
            }
        }
    });

    it('covers every variant the build knows', () => {
        expect([...COLUMNS].sort()).toEqual(Object.keys(VARIANTS).sort());
    });

    it('gives the host to show from the URL, with its port when not the default', () => {
        const check = (text: string, variant: string) => {
            const checked = checkAddress(text, variant);
            return checked.ok ? checked.address : checked.problem;
        };
        expect(check('ＢＲＡＩＮ.example.test.', 'production')).toEqual({
            origin: 'https://brain.example.test',
            host: 'brain.example.test',
        });
        expect(check('brаin.example.test:8443/x', 'preview')).toEqual({
            origin: 'https://xn--brin-63d.example.test:8443',
            host: 'xn--brin-63d.example.test:8443',
        });
        expect(check('http://localhost:4352', 'development')).toEqual({
            origin: 'http://localhost:4352',
            host: 'localhost:4352',
        });
    });
});

describe('checkUrl', () => {
    it('checks only the origin of a URL already parsed, as a redirect target is', () => {
        const target = new URL('https://BRAIN.example.org./api/auth/session?x=1#y');
        expect(checkUrl(target, 'production')).toEqual({
            ok: true,
            address: { origin: 'https://brain.example.org', host: 'brain.example.org' },
        });
        expect(checkUrl(new URL('https://@brain.example.test.evil.example/'), 'production')).toEqual({
            ok: true,
            address: { origin: 'https://brain.example.test.evil.example', host: 'brain.example.test.evil.example' },
        });
        expect(checkUrl(new URL('https://brain.acme.example.test:8443/'), 'production')).toEqual({
            ok: false,
            problem: 'port',
        });
        expect(checkUrl(new URL('https://ada@brain.example.test/'), 'preview')).toEqual({
            ok: false,
            problem: 'userinfo',
        });
        expect(checkUrl(new URL('ftp://brain.example.test/'), 'development')).toEqual({
            ok: false,
            problem: 'scheme',
        });
    });
});

describe('the lists', () => {
    it('allow plain http to exactly the hosts a development release build’s network config does', () => {
        expect(LOCAL_HTTP_HOSTS).toEqual([...CLEARTEXT_HOSTS]);
    });
});

describe("on the device's URL", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The app parses with Expo's WHATWG URL (whatwg-url-minimum, which expo's
    // runtime installs as the global URL), not Node's. Every vector gives the
    // same answer with it, in every variant.
    it('gives the same answers as under Node', () => {
        const fromExpo = createRequire(createRequire(import.meta.url).resolve('expo/package.json'));
        const { URL: DeviceURL } = fromExpo('whatwg-url-minimum') as { URL: typeof URL };
        expect(DeviceURL).not.toBe(URL);
        const underNode = COLUMNS.map((variant) => VECTORS.map(([text]) => outcome(text, variant)));
        vi.stubGlobal('URL', DeviceURL);
        expect(globalThis.URL).toBe(DeviceURL);
        const onDevice = COLUMNS.map((variant) => VECTORS.map(([text]) => outcome(text, variant)));
        expect(onDevice).toEqual(underNode);
    });
});
