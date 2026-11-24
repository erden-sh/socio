import { appsFor, type LinkApp, variantsForHost } from './apps';
import { contentSecurityPolicy, linkPage, notFoundPage, parseLinkPath } from './pages';
import { appleAppSiteAssociation, assetLinks } from './well-known';

// The link domain's Worker (link.socio.sh and link-staging.socio.sh; README.md). It serves:
//
// - `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`, each variant
//   claiming only its own path prefix (well-known.ts);
// - a static page for each app link, `/<variant path>/<kind>…` (pages.ts), which a browser shows
//   when no app took the link.
//
// Each host serves only its own variants (apps.ts, HOST_VARIANTS): link.socio.sh production and
// preview, link-staging.socio.sh development, and a bench's tunnel (DEV_LINK_HOST, passed with
// `--var` to wrangler dev, never in wrangler.toml) development. Any other host gets a 404.
//
// It keeps nothing and logs nothing: no storage binding, no console line, and Workers Logs,
// traces and Logpush are off in wrangler.toml. It sees only paths, which name a workspace host at
// most; codes and invite tokens ride in the fragment, which no request carries. GET and HEAD only.
// WebCrypto only: no runtime dependency beyond @socio/shared's device sign-in table, no
// `nodejs_compat`.

const COMMON = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
};

const PAGE_HEADERS = {
    ...COMMON,
    'content-type': 'text/html; charset=utf-8',
    // The same page for everyone, but nothing about a link is worth keeping in a cache.
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** What the Worker reads from its environment: only the bench's optional tunnel host. */
export interface Env {
    DEV_LINK_HOST?: string;
}

const WELL_KNOWN: Readonly<Record<string, (apps: readonly LinkApp[]) => unknown>> = {
    '/.well-known/apple-app-site-association': appleAppSiteAssociation,
    '/.well-known/assetlinks.json': assetLinks,
};

const respond = (request: Request, status: number, body: string, headers: Record<string, string>) =>
    new Response(request.method === 'HEAD' ? null : body, { status, headers });

export async function handle(request: Request, env: Env = {}): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { ...COMMON, allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const csp = await contentSecurityPolicy();
    const notFound = () => respond(request, 404, notFoundPage(), { ...PAGE_HEADERS, 'content-security-policy': csp });
    const variants = variantsForHost(url.host, env.DEV_LINK_HOST);
    if (!variants) {
        return notFound();
    }
    const file = WELL_KNOWN[url.pathname];
    if (file) {
        return respond(request, 200, JSON.stringify(file(appsFor(variants))), {
            ...COMMON,
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
        });
    }
    // Links never have a query (parseAppLink refuses one), and a host opens only its own variants.
    const link = url.search === '' ? parseLinkPath(url.pathname) : null;
    if (!link || !variants.includes(link.variant)) {
        return notFound();
    }
    return respond(request, 200, linkPage(link), { ...PAGE_HEADERS, 'content-security-policy': csp });
}

export default { fetch: (request, env) => handle(request, env) } satisfies ExportedHandler<Env>;
