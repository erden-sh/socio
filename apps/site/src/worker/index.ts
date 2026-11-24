import { robotsHeaders, SECURITY_HEADERS, type SiteEnv } from './headers';

// Socio's public site (socio.sh; README.md). Cloudflare serves the built pages and files straight
// from the static assets, with dist/_headers. Only the paths in wrangler.toml's run_worker_first
// reach this Worker:
//
// - `/forms`: where the waitlist, notify-me and support forms post. Until the form handler lands
//   (Turnstile, D1, rate limit, honeypot, the email notice), it answers 503 with a page that
//   gives the addresses to write to instead, and keeps nothing it was sent.
//
// The analytics proxy, a later change, joins ROUTES here. Anything else is passed to the assets, so the
// Worker never serves a page of its own beyond these.
//
// It keeps nothing and logs nothing: no storage binding yet, no console line, and Workers Logs,
// traces and Logpush are off in wrangler.toml.

/** The static assets binding: only what the Worker uses of it, so this compiles in Node too. */
export interface AssetsBinding {
    fetch(request: Request): Promise<Response>;
}

export interface Env {
    ASSETS: AssetsBinding;
    SITE_ENV?: SiteEnv;
}

type Route = (request: Request, env: Env) => Promise<Response> | Response;

const html = (env: Env, status: number, body: string, extra: Record<string, string> = {}) =>
    new Response(body, {
        status,
        headers: {
            ...SECURITY_HEADERS,
            ...robotsHeaders(env.SITE_ENV ?? 'local'),
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extra,
        },
    });

/** What /forms answers until the handler lands: plain HTML, no stylesheet or script, so it needs nothing from the build. */
export const FORMS_CLOSED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Forms open soon · Socio</title>
</head>
<body>
<main>
<h1>Our forms open soon</h1>
<p>Nothing you sent was kept. Until then, please write to us:</p>
<ul>
<li>Support and the hosted waitlist: <a href="mailto:support@ingenioventures.com">support@ingenioventures.com</a></li>
<li>Privacy and account requests: <a href="mailto:privacy@ingenioventures.com">privacy@ingenioventures.com</a></li>
</ul>
<p><a href="/">Back to socio.sh</a></p>
</main>
</body>
</html>
`;

/** The Worker's own paths. The analytics proxy joins them, and the form handler replaces `/forms`. */
export const ROUTES: Readonly<Record<string, Route>> = {
    '/forms': (request, env) =>
        request.method === 'POST'
            ? html(env, 503, FORMS_CLOSED_PAGE, { 'Retry-After': '86400' })
            : html(env, 405, FORMS_CLOSED_PAGE, { Allow: 'POST' }),
};

export async function handle(request: Request, env: Env): Promise<Response> {
    const route = ROUTES[new URL(request.url).pathname];
    return route ? route(request, env) : env.ASSETS.fetch(request);
}

export default { fetch: (request: Request, env: Env) => handle(request, env) };
