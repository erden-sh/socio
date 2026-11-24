import { readFileSync } from 'node:fs';

import { Hono } from 'hono';
import { expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    CONTENT_SECURITY_POLICY,
    pageContentSecurityPolicy,
    securityHeaders,
} from '@socio/foundation/http/security-headers';

const directives = (policy: string) => policy.split(';').map((part) => part.trim());

it('keeps the CSP as it was for everything but pages: scripts only from the app, none inline', () => {
    // The policy before the theme work (release 2, C4); change it only to
    // tighten it.
    expect(CONTENT_SECURITY_POLICY).toBe(
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    );
    expect(directives(CONTENT_SECURITY_POLICY).find((part) => part.startsWith('script-src'))).toBe("script-src 'self'");
});

it('lets a page run only the inline scripts that carry its nonce', () => {
    // Accepted 2026-10-09 (CB-61): the one change from the policy above is the
    // nonce in script-src. No 'unsafe-inline', no 'strict-dynamic'.
    const page = directives(pageContentSecurityPolicy('bm9uY2U='));
    const strict = directives(CONTENT_SECURITY_POLICY);
    expect(page.find((part) => part.startsWith('script-src'))).toBe("script-src 'self' 'nonce-bm9uY2U='");
    expect(page.filter((part) => !part.startsWith('script-src'))).toEqual(
        strict.filter((part) => !part.startsWith('script-src')),
    );
});

it('sends the page policy with the response that set a nonce, the strict one otherwise', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', securityHeaders);
    app.get('/page', (c) => {
        c.set('cspNonce', 'bm9uY2U=');
        // A raw response, as React Router returns one.
        return new Response('<!doctype html>', {
            headers: { 'Content-Type': 'text/html' },
        });
    });
    app.get('/file.js', (c) => c.body('// file'));
    const page = await app.request('/page');
    expect(page.headers.get('content-security-policy')).toBe(pageContentSecurityPolicy('bm9uY2U='));
    const file = await app.request('/file.js');
    expect(file.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    for (const response of [page, file]) {
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    // The rendered pages themselves (every inline script nonced, the theme
    // script first) are checked in ssr-document.test.ts.
});

it('keeps every page out of frames, the Socio app’s Continue page included (CB-352)', () => {
    expect(directives(pageContentSecurityPolicy('bm9uY2U='))).toContain("frame-ancestors 'none'");
});

it('themes the first paint from a file', () => {
    expect(readFileSync('packages/client/src/root.tsx', 'utf8')).toContain('<script src="/theme-init.js" />');
    expect(readFileSync('public/theme-init.js', 'utf8')).toContain("localStorage.getItem('theme')");
});
