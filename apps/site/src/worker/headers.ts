// The site's response headers, in one place: the Worker sets them on what it answers itself, and
// the build writes them into dist/_headers for the static assets, which Cloudflare serves without
// running the Worker (wrangler.toml, run_worker_first). tests/headers.test.ts holds both.

/** Where the site runs: `local` is wrangler dev, and only production may be indexed. */
export type SiteEnv = 'local' | 'staging' | 'production';

/**
 * The Content Security Policy: the site's own scripts, styles and images, nothing inline, no
 * frames of it anywhere. Turnstile's script and frame are allowed now so the form handler doesn't
 * change the policy; its script loads only on pages with a form, once the handler lands.
 * Analytics (a later change) go through the site's own origin (`connect-src 'self'`), never to a third party.
 */
export const CSP_DIRECTIVES: readonly (readonly [string, ...string[]])[] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", 'https://challenges.cloudflare.com'],
    ['frame-src', 'https://challenges.cloudflare.com'],
    ['connect-src', "'self'"],
    ['img-src', "'self'", 'data:'],
    ['style-src', "'self'"],
    ['base-uri', "'none'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.map((directive) => directive.join(' ')).join('; ');

/** On every response, page or file. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

/** Hashed build output (Vite's assets/ directory): the name changes with the content. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Only production is indexed: staging and wrangler dev say noindex on every response. */
export const robotsHeaders = (env: SiteEnv): Record<string, string> =>
    env === 'production' ? {} : { 'X-Robots-Tag': 'noindex' };

/** dist/_headers: the security headers on every path, long caching for hashed assets. */
export function headersFile(env: SiteEnv): string {
    const lines = (headers: Record<string, string>) =>
        Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);
    return [
        '/*',
        ...lines({ ...SECURITY_HEADERS, ...robotsHeaders(env) }),
        '/assets/*',
        ...lines({ 'Cache-Control': IMMUTABLE }),
        '',
    ].join('\n');
}
