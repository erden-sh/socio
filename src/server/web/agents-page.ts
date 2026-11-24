import type { Hono, Env } from 'hono';

import type { WebSettings } from './contract.js';

const escape = (text: string) =>
    text.replace(
        /[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );

const duration = (ms: number) => {
    const seconds = Math.round(ms / 1000);
    return seconds % 60 || seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minutes`;
};

const size = (bytes: number) =>
    bytes >= 1_000_000 ? `${Math.round(bytes / 100_000) / 10} MB` : `${Math.round(bytes / 1000)} kB`;

/**
 * The public page the agent User-Agent links to. It is the same for every
 * visitor, built once from the server's settings, and holds no user data.
 */
export function agentsPage(settings: WebSettings) {
    const contact = settings.contact
        ? `<a href="${escape(settings.contact)}">${escape(settings.contact.replace(/^mailto:/, ''))}</a>`
        : 'the operator of this Socio workspace (the site serving this page)';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Socio agents</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;color:#1f2328}code{font-size:.9em;background:#f3f4f6;padding:.1em .3em;border-radius:4px}h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem}</style>
</head>
<body>
<h1>Socio agents</h1>
<p>Socio is self-hosted workspace software. Its agents, called socios, read public web pages and APIs when a person using the workspace asks them to. Requests from them carry this User-Agent:</p>
<p><code>${escape(settings.userAgent)}</code></p>
<h2>User-directed, not a crawler</h2>
<p>Each request is made because a person asked their agent for something; the agent operates on that person's behalf. It does not crawl, index or follow links on its own. It only reads, with GET or HEAD, and follows at most five redirects.</p>
<p>Requests carry nothing that identifies the person: no name, email address, account, cookies or logins. Some agents may instead be set to browse through an ordinary browser, which then uses that browser's own identity.</p>
<h2>Limits</h2>
<ul>
<li>At most ${settings.perHostPerMinute} requests a minute to one site from each agent, and ${settings.globalPerMinute} a minute from the whole workspace.</li>
<li>Responses are cached (Cache-Control and ETag are respected), and at most ${size(settings.maxBytes)} of a response is read.</li>
<li>A request gives up after ${duration(settings.timeoutMs)}.</li>
</ul>
<h2>Slowing down or opting out</h2>
<p>Answer with HTTP <code>429</code> or <code>403</code>. The workspace's agents then stop requesting from your site for the time in <code>Retry-After</code>, or for ${duration(settings.cooldownMs)} if there is none, and tell the person that the site declined. A <code>503</code> with <code>Retry-After</code> works the same way.</p>
<h2>Contact</h2>
<p>Each workspace is run by its own operator. To reach the one whose agents made a request, contact ${contact}.</p>
</body>
</html>
`;
}

/** Serves `/agents`: public, static, no sign-in and no cookies. */
export function serveAgentsPage<E extends Env>(app: Hono<E>, settings: WebSettings) {
    const html = agentsPage(settings);
    app.get('/agents', (c) => {
        c.header('Cache-Control', 'public, max-age=3600');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Referrer-Policy', 'no-referrer');
        c.header(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        return c.html(html);
    });
}
