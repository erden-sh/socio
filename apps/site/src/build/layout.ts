import { artPath, type Character, CHARACTERS } from './art.ts';
import { ORIGIN, PAGES, type PageKey, PUBLISHER } from './facts.ts';
import { icon } from './icons.ts';

// The shell every page shares: <head> (search and link-preview tags), the header with Sebas as
// the logo, the footer, and the cookie banner and dialog. Ported from the approved mockups,
// with the owner's round-2 answers: the code
// page is "Self-host" at /self-host. No inline style or script anywhere: the CSP allows neither.

/** The built stylesheet and script, by their hashed names (vite's bundle). */
export interface Assets {
    css: string;
    js: string;
}

/** A character, as an image. */
export const m = (id: Character, alt = '') => `<img src="${artPath(id)}" alt="${alt}" width="256" height="256">`;

/** A module's tone tile: the tint square with the icon in the tone's ink. */
export const sq = (tone: string, ic: string, extra = '') =>
    `<span class="tone-square ${extra} t-${tone}">${icon(ic)}</span>`;

export const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A menu path as the reader sees it: each label in a key cap, joined by ›. Labels come from facts.ts MENU_PATHS. */
export const menuPath = (labels: readonly string[]) =>
    labels.map((label) => `<span class="kbd">${escapeHtml(label)}</span>`).join(' › ');

export const ogImage = (key: PageKey) => `${ORIGIN}/og/${key}.png`;

function head(key: PageKey, assets: Assets, extra: string): string {
    const p = PAGES[key];
    const url = `${ORIGIN}${p.path}`;
    const title = escapeHtml(p.title);
    const desc = escapeHtml(p.desc);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfbfa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111112" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Socio">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ogImage(key)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${ogImage(key)}">
<link rel="alternate" type="text/plain" title="For AI agents" href="/llms.txt">
<link rel="alternate" type="text/plain" title="The site as text, for AI agents" href="/llms-full.txt">
<link rel="stylesheet" href="${assets.css}">
<script type="module" src="${assets.js}"></script>
${extra}</head>`;
}

type Active = 'product' | 'self-host' | 'hosted' | 'support' | 'legal' | null;

const NAV: [string, string, Active][] = [
    ['/#features', 'Product', 'product'],
    ['/self-host', 'Self-host', 'self-host'],
    ['/hosted', 'Hosted', 'hosted'],
    ['/support', 'Support', 'support'],
];

function header(active: Active): string {
    const links = NAV.map(
        ([href, label, key]) => `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`,
    ).join('\n    ');
    return `<header class="site-header"><div class="container">
  <a class="logo" href="/"><span class="mark">${m('sebas')}</span>Socio</a>
  <nav class="nav" aria-label="Main">
    ${links}
  </nav>
  <div class="header-cta">
    <a class="btn btn-ghost" href="/self-host">Run it yourself</a>
    <a class="btn btn-primary" href="/hosted#waitlist">Join the waitlist</a>
    <details class="menu">
      <summary class="menu-btn" aria-label="Menu">${icon('menu')}</summary>
      <nav class="menu-panel" aria-label="Menu">
        ${NAV.map(([href, label]) => `<a href="${href}">${label}</a>`).join('\n        ')}
        <a href="/self-host">Run it yourself</a>
        <a class="btn btn-primary" href="/hosted#waitlist">Join the waitlist</a>
      </nav>
    </details>
  </div>
</div></header>`;
}

function footer(): string {
    return `<footer class="site-footer"><div class="container">
  <div class="footer-grid">
    <div>
      <a class="logo" href="/"><span class="mark">${m('sebas')}</span>Socio</a>
      <p class="footer-blurb">Your team’s workspace, with AI socios. By ${PUBLISHER}</p>
      <div class="footer-crew">${CHARACTERS.map((id) => m(id)).join('')}</div>
    </div>
    <div><h5>Product</h5><ul>
      <li><a href="/#features">Features</a></li>
      <li><a href="/self-host">Self-host</a></li>
      <li><a href="/hosted">Hosted plans</a></li>
      <li><a href="/support">Support</a></li>
    </ul></div>
    <div><h5>Legal</h5><ul>
      <li><a href="/privacy">Privacy Policy</a></li>
      <li><a href="/terms">Terms of Service</a></li>
      <li><a href="/cookies">Cookie Policy</a></li>
      <li><a href="/delete-account">Delete your account</a></li>
    </ul></div>
    <div><h5>Company</h5><ul>
      <li><a href="https://erden.sh">Erden ${icon('arrow-up-right')}</a></li>
      <li><a href="/support#contact">Contact</a></li>
      <li><a href="/.well-known/security.txt">Security</a></li>
      <li><a href="/llms.txt">For AI agents</a></li>
    </ul></div>
  </div>
  <div class="footer-bottom">
    <span>© 2026 ${PUBLISHER} Socio, Socio.sh, Erden, and Erden.sh are trademarks of ${PUBLISHER} The socio characters are trademarks of ${PUBLISHER}</span>
    <span><button type="button" data-open-cookie-settings>Cookie settings</button></span>
  </div>
</div></footer>`;
}

/** The banner (hidden until the script decides) and the Cookie settings dialog. */
function consent(): string {
    return `<aside class="consent" id="consent-banner" hidden aria-labelledby="c-h" aria-describedby="c-p">
  <div class="top">${m('sebas')}<div><h4 id="c-h">Can we count your visit?</h4><p id="c-p">We’d like to use cookies to see which pages help and what to improve. No ads, and we never sell it. You can change your mind any time.</p></div></div>
  <div class="row"><button class="btn btn-outline" type="button" data-consent="reject">Reject all</button><button class="btn btn-outline" type="button" data-consent="accept">Accept all</button></div>
  <div class="links"><button type="button" data-consent="customize">Customize</button><a href="/cookies">Cookie Policy</a></div>
</aside>
<dialog class="dialog" id="consent-settings" aria-labelledby="d-h">
  <header>${sq('mint', 'cookie')}<div><h3 id="d-h">Cookie settings</h3><p>Choose what socio.sh may store. Your choice is kept on this device and applies to the website only.</p></div><button class="x" type="button" data-consent="close" aria-label="Close">${icon('x')}</button></header>
  <div class="pref"><div class="txt"><b>Strictly necessary <span class="badge t-slate">Always on</span></b><p>Remembers this choice and protects our forms from spam. Nothing here tracks you.</p></div><input class="switch" type="checkbox" role="switch" checked disabled aria-label="Strictly necessary, always on"></div>
  <div class="pref"><div class="txt"><b><label for="consent-analytics">Product analytics</label></b><p>Counts visits and clicks with PostHog, through our own domain, so we can see which pages help. Off, we count page views alone, with no cookie and nothing that identifies you. No ads, no selling, no cross-site tracking.</p></div><input class="switch" id="consent-analytics" type="checkbox" role="switch"></div>
  <footer><button class="btn btn-outline" type="button" data-consent="reject">Reject all</button><button class="btn btn-outline" type="button" data-consent="accept">Accept all</button><button class="btn btn-primary" type="button" data-consent="save">Save choices</button></footer>
</dialog>
`;
}

export interface PageOptions {
    key: PageKey;
    active: Active;
    body: string;
    assets: Assets;
    /** More for <head>: JSON-LD on the home page. */
    headExtra?: string;
}

export const page = ({ key, active, body, assets, headExtra = '' }: PageOptions) =>
    `${head(key, assets, headExtra)}
<body>
<a class="skip" href="#main">Skip to content</a>
${header(active)}
<main id="main">
${body}
</main>
${footer()}
${consent()}</body>
</html>
`;
