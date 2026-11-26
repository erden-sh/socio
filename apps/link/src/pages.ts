import {
    APP_VARIANTS,
    type AppVariant,
    CODE_ALPHABET,
    isLinkHost,
    LINK_KINDS,
    type LinkKind,
    SIGN_IN_CODE_LENGTH,
    VARIANT_LINK_PATHS,
} from '@socio/shared/device-sign-in';

import { appsFor } from './apps';
import { PAGE_SCRIPT } from './page-script';

// The pages behind each app link (@socio/shared/device-sign-in's LINK_KINDS). A link opens
// the app when it is installed and verified; these pages are what the browser shows otherwise.
// They are static: the Worker sees only the path (variant, kind, and for `d`, `i` and `w` the
// workspace host), never the fragment, which the page's own script reads (page-script.ts). No
// third-party request: no font, image, stylesheet or script from anywhere, and a CSP that allows
// only the page's own inline script and style, by hash.

/** A link's path as the Worker reads it. */
export interface LinkPath {
    variant: AppVariant;
    kind: LinkKind;
    /** The workspace host, for the kinds that carry it in the path (`d`, `i`, `w`). */
    host: string | null;
}

/** The fragment's keys by kind: what @socio/shared's appLink writes (tests/pages.test.ts holds them to it). */
export const FRAGMENT_KEYS: Readonly<Record<LinkKind, readonly string[]>> = {
    cb: ['code', 'state', 'ws'],
    c: ['code', 'ws'],
    d: ['c'],
    i: ['t'],
    w: [],
};

const HOST_IN_PATH: ReadonlySet<LinkKind> = new Set(['d', 'i', 'w']);
const VARIANT_BY_PATH = new Map(APP_VARIANTS.map((variant) => [VARIANT_LINK_PATHS[variant], variant]));

/**
 * The link a path names, or null. Like parseAppLink: a known variant and kind, the host in the path
 * for `d`, `i` and `w` (isLinkHost) and none for `cb` and `c`. On production paths a host with a
 * port is refused, as the production app's address check refuses it; preview and development
 * keep ports (local and bench workspaces).
 */
export function parseLinkPath(pathname: string): LinkPath | null {
    const segments = pathname.split('/');
    if (segments[0] !== '') {
        return null;
    }
    const variant = VARIANT_BY_PATH.get(segments[1] ?? '');
    const kind = segments[2] as LinkKind;
    if (!variant || !(LINK_KINDS as readonly string[]).includes(kind)) {
        return null;
    }
    if (!HOST_IN_PATH.has(kind)) {
        return segments.length === 3 ? { variant, kind, host: null } : null;
    }
    const host = segments[3];
    if (segments.length !== 4 || host === undefined || !isLinkHost(host)) {
        return null;
    }
    if (variant === 'production' && host.includes(':')) {
        return null;
    }
    return { variant, kind, host };
}

/** A host split as the app's WorkspaceHost shows it: the registrable part emphasized. */
export function hostParts(host: string) {
    const at = host.indexOf(':');
    const name = at < 0 ? host : host.slice(0, at);
    const port = at < 0 ? '' : host.slice(at);
    const labels = name.split('.');
    if (/^\d+(\.\d+){3}$/.test(name) || labels.length <= 2) {
        return { lead: '', domain: name, port };
    }
    return { lead: `${labels.slice(0, -2).join('.')}.`, domain: labels.slice(-2).join('.'), port };
}

const VARIANT_NAMES: Readonly<Record<AppVariant, string>> = {
    production: 'Socio',
    preview: 'Socio Preview',
    development: 'Socio Dev',
};

/**
 * Where to get the production app. Placeholders until the launch (and the team beta's public
 * links, if the owner wants them here): with none, the page tells people to ask their admin.
 */
export const STORE_LINKS: { readonly appStore: string | null; readonly play: string | null } = {
    appStore: null,
    play: null,
};

const STYLE = `
:root{color-scheme:light dark}
[hidden]{display:none!important}
body{font:17px/1.45 -apple-system,system-ui,sans-serif;margin:0;background:#fbf7ef;color:#1d1b16}
main{max-width:28rem;margin:0 auto;padding:32px 24px}
h1{font-size:24px;margin:0 0 12px}
p{margin:0 0 12px}
.host{font-size:20px;word-break:break-all}.host b{font-weight:700}.host span{opacity:.7}
.button{display:block;margin:20px 0 8px;padding:14px;border-radius:12px;background:#2f6b4f;color:#fff;text-align:center;text-decoration:none;font-weight:600}
.button.secondary{background:transparent;color:inherit;border:1px solid currentColor}
output{display:block;margin:16px 0;font:600 28px ui-monospace,monospace;letter-spacing:.08em}
.note{font-size:15px;opacity:.8}
.warning{padding:12px;border-radius:12px;background:#f6e3b4;color:#3d2f05}
@media (prefers-color-scheme:dark){body{background:#16140f;color:#efe9dc}.button{background:#3f8a66}}
`;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const sha256 = async (text: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
};

let policy: Promise<string> | undefined;

/** The pages' Content-Security-Policy: nothing but the page's own script and style, by hash. */
export function contentSecurityPolicy(): Promise<string> {
    policy ??= Promise.all([sha256(PAGE_SCRIPT), sha256(STYLE)]).then(([script, style]) =>
        [
            "default-src 'none'",
            `script-src 'sha256-${script}'`,
            `style-src 'sha256-${style}'`,
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            "require-trusted-types-for 'script'",
        ].join('; '),
    );
    return policy;
}

function hostHtml(host: string) {
    const { lead, domain, port } = hostParts(host);
    return `<p class="host">${lead ? `<span>${escapeHtml(lead)}</span>` : ''}<b>${escapeHtml(domain)}</b>${port ? `<span>${escapeHtml(port)}</span>` : ''}</p>`;
}

function getTheApp(variant: AppVariant) {
    if (variant !== 'production') {
        return `<p class="note">This link is for ${VARIANT_NAMES[variant]}, a test build of Socio. Install it from your team's test channel, then open the link again.</p>`;
    }
    const links = [
        STORE_LINKS.appStore &&
            `<a class="button secondary" href="${escapeHtml(STORE_LINKS.appStore)}">Get Socio on the App Store</a>`,
        STORE_LINKS.play &&
            `<a class="button secondary" href="${escapeHtml(STORE_LINKS.play)}">Get Socio on Google Play</a>`,
    ].filter(Boolean);
    return links.length > 0
        ? `<p class="note">No Socio app on this device yet?</p>${links.join('')}`
        : `<p class="note">No Socio app on this device yet? It's in a private beta: ask your workspace's admin how to get it, then open this link again.</p>`;
}

const INVALID = `<p id="invalid" hidden>This link isn't complete. Ask for a new one.</p>`;

/**
 * The open button `w` offers: the variant's bare scheme (`socio://`), which opens the app as it is.
 * No page links to itself (iOS keeps a same-host link in Safari), and no custom-scheme URL ever
 * carries anything: a scheme isn't verified, so a code, pairing code, token or state in one could
 * reach another app that registered it. `w` carries no secret, and the others offer none.
 */
const OPEN_BARE = (variant: AppVariant) =>
    `<a class="button" href="${escapeHtml(appsFor([variant])[0]?.scheme ?? 'socio')}://">Open the ${escapeHtml(VARIANT_NAMES[variant])} app</a>`;

function body(link: LinkPath): { title: string; html: string } {
    const { variant, kind, host } = link;
    switch (kind) {
        case 'cb':
            // The sign-in sheet's callback, when no app took it. Harmless: no button and never the
            // code. The app can't be reopened from here with the code (only the sheet's own
            // callback hands it over), and each try mints fresh values, so it says to try again.
            return {
                title: 'Back to the Socio app',
                html: `<h1>Back to the Socio app</h1>
<p>Signing in didn't make it back to the app.</p>
<p>Go back to the Socio app and choose Continue again.</p>${INVALID}`,
            };
        case 'c':
            return {
                title: 'Your Socio sign-in code',
                html: `<h1>Your sign-in code</h1>
<output id="code" hidden></output>${INVALID}
<p>Open the Socio app on your own device and type this code there.</p>
<p class="note">It works once, for 15 minutes. Never type it anywhere else.</p>`,
            };
        case 'd':
            // Add a device: the pairing code stays in the fragment and is never shown here. People
            // land here mostly when the installed app hasn't picked up the link association yet.
            // There is no in-app scanner yet, so the "scan the code in the app" wording comes back
            // when it ships (CB-566).
            return {
                title: 'Add a device to Socio',
                html: `<h1>Add a device</h1>
<p>If Socio is installed, open this link from your camera or a message so it opens in the app.</p>
<p>If it still opens here, reinstall Socio, then scan the code again.</p>${INVALID}
${getTheApp(variant)}`,
            };
        case 'i':
            return {
                title: 'Your Socio invite',
                html: `<h1>You're invited to a Socio workspace</h1>
${hostHtml(host ?? '')}
${variant === 'production' ? '' : `<p class="warning">This invite is for ${VARIANT_NAMES[variant]}, a test build.</p>`}
<p>Only continue if you expected an invite to this workspace.</p>
<a class="button" id="continue" hidden>Set your password on ${escapeHtml(host ?? '')}</a>${INVALID}
<p class="note">Then sign in to this workspace in the Socio app with your email and that password.</p>
${getTheApp(variant)}`,
            };
        case 'w':
            return {
                title: 'A Socio workspace',
                html: `<h1>Your Socio workspace</h1>
${hostHtml(host ?? '')}${INVALID}
${OPEN_BARE(variant)}
<p class="note">In the app, add this workspace by its address.</p>
${getTheApp(variant)}`,
            };
    }
}

/** The page for a link: static but for what its script fills in from the fragment. */
export function linkPage(link: LinkPath): string {
    const data = {
        kind: link.kind,
        keys: FRAGMENT_KEYS[link.kind],
        host: link.host,
        noPort: link.variant === 'production',
        codeAlphabet: CODE_ALPHABET,
        codeLength: SIGN_IN_CODE_LENGTH,
    };
    const { title, html } = body(link);
    return htmlDocument(
        title,
        `${html}
<script type="application/json" id="link-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${PAGE_SCRIPT}</script>`,
    );
}

/** The page for anything else under the link domain. */
export const notFoundPage = () =>
    htmlDocument('Not a Socio link', `<h1>Not a Socio link</h1><p>This address isn't a link Socio made.</p>`);

const htmlDocument = (title: string, main: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${main}
</main></body>
</html>
`;
