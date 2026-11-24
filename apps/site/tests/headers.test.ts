import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/worker/headers.ts';
import { handle, type Env } from '../src/worker/index.ts';

import { distStaging, readBuilt } from './helpers.ts';

// The strict headers: on the static assets through dist/_headers, and on the
// Worker's own responses.

/** dist/_headers as rules: path pattern → headers. */
function parseHeaders(file: string): Map<string, Record<string, string>> {
    const rules = new Map<string, Record<string, string>>();
    let current: Record<string, string> | null = null;
    for (const line of file.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        if (!line.startsWith(' ')) {
            current = {};
            rules.set(line.trim(), current);
        } else if (current) {
            const at = line.indexOf(':');
            current[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
    }
    return rules;
}

const directives = (csp: string) =>
    Object.fromEntries(
        csp.split(';').map((part) => {
            const [name = '', ...values] = part.trim().split(/\s+/);
            return [name, values];
        }),
    );

describe('the Content Security Policy', () => {
    it('allows only the site itself, plus Turnstile’s script and frame for the forms', () => {
        expect(directives(CONTENT_SECURITY_POLICY)).toEqual({
            'default-src': ["'self'"],
            'script-src': ["'self'", 'https://challenges.cloudflare.com'],
            'frame-src': ['https://challenges.cloudflare.com'],
            'connect-src': ["'self'"],
            'img-src': ["'self'", 'data:'],
            'style-src': ["'self'"],
            'base-uri': ["'none'"],
            'form-action': ["'self'"],
            'frame-ancestors': ["'none'"],
        });
        expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-|\*/);
    });
});

describe('dist/_headers', () => {
    it('sends the security headers on every path and caches hashed assets for a year', () => {
        const rules = parseHeaders(readBuilt('_headers'));
        expect([...rules.keys()]).toEqual(['/*', '/assets/*']);
        expect(rules.get('/*')).toEqual({
            'content-security-policy': CONTENT_SECURITY_POLICY,
            'strict-transport-security': 'max-age=63072000; includeSubDomains',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-resource-policy': 'same-origin',
            'permissions-policy': SECURITY_HEADERS['Permissions-Policy'],
        });
        expect(rules.get('/assets/*')).toEqual({ 'cache-control': 'public, max-age=31536000, immutable' });
    });

    it('adds X-Robots-Tag: noindex on staging only', () => {
        expect(readBuilt('_headers')).not.toMatch(/x-robots-tag/i);
        expect(parseHeaders(readBuilt('_headers', distStaging())).get('/*')?.['x-robots-tag']).toBe('noindex');
    });
});

describe('the Worker', () => {
    const assets: Request[] = [];
    const env = (SITE_ENV: Env['SITE_ENV']): Env => ({
        SITE_ENV,
        ASSETS: {
            fetch: async (request) => {
                assets.push(request);
                return new Response('asset');
            },
        },
    });

    it('answers a form post with 503 and the addresses to write to, with the strict headers, keeping nothing', async () => {
        const response = await handle(
            new Request('https://socio.sh/forms', { method: 'POST', body: new URLSearchParams({ kind: 'support' }) }),
            env('production'),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
        expect(response.headers.get('strict-transport-security')).toBe(SECURITY_HEADERS['Strict-Transport-Security']);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-robots-tag')).toBeNull();
        const body = await response.text();
        expect(body).toContain('mailto:support@ingenioventures.com');
        expect(body).toContain('Nothing you sent was kept');
        expect(body).not.toMatch(/<script|style=/);
    });

    it('refuses anything but POST on /forms, and says noindex off production', async () => {
        const response = await handle(new Request('https://site-staging.socio.sh/forms'), env('staging'));
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST');
        expect(response.headers.get('x-robots-tag')).toBe('noindex');
    });

    it('passes every other path to the static assets', async () => {
        assets.length = 0;
        const response = await handle(new Request('https://socio.sh/privacy'), env('production'));
        expect(await response.text()).toBe('asset');
        expect(assets.map((request) => new URL(request.url).pathname)).toEqual(['/privacy']);
    });
});
