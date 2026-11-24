import type { Character } from './art.ts';
import type { PageKey } from './facts.ts';

// The link-preview images (1200×630), one per page, and the apple-touch icon: HTML templates that
// scripts/render.mjs renders with Playwright's Chromium into public/, where they are committed.
// Only that script loads these; the site never serves them.

export const OG_CARDS: Record<PageKey, { kicker: string; title: string; tone: string; crew: Character[] }> = {
    home: { kicker: 'Your team’s workspace', title: 'With AI socios.', tone: 'mint', crew: ['manny', 'sebas'] },
    'self-host': { kicker: 'Code coming soon', title: 'Run Socio yourself.', tone: 'indigo', crew: ['rulo', 'iggy'] },
    hosted: { kicker: 'Early access', title: 'We run Socio for you.', tone: 'amber', crew: ['mingo', 'sebas'] },
    support: { kicker: 'Support', title: 'How can we help?', tone: 'sky', crew: ['manny', 'lino'] },
    privacy: { kicker: 'Legal', title: 'Privacy Policy', tone: 'emerald', crew: ['flake'] },
    terms: { kicker: 'Legal', title: 'Terms of Service', tone: 'indigo', crew: ['lino'] },
    cookies: { kicker: 'Legal', title: 'Cookie Policy', tone: 'amber', crew: ['sebas'] },
    'delete-account': { kicker: 'Account and data', title: 'Delete your account', tone: 'rose', crew: ['rosy'] },
};

const img = (id: Character) => `<img src="/art/${id}.svg" alt="" width="256" height="256">`;

/** A card, with the built stylesheet at `css`. */
export function ogHtml(key: PageKey, css: string): string {
    const card = OG_CARDS[key];
    return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>
body{margin:0;width:1200px;height:630px;overflow:hidden;background:var(--canvas)}
.og{position:relative;width:1200px;height:630px;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden}
.og::before{content:'';position:absolute;inset:0;z-index:-1;background:radial-gradient(45% 60% at 10% 10%,color-mix(in oklab,var(--tone) 28%,transparent),transparent 70%),radial-gradient(40% 55% at 95% 100%,color-mix(in oklab,var(--sky-500) 20%,transparent),transparent 70%)}
.og .k{font-size:28px;font-weight:650;color:var(--tone-ink);letter-spacing:.02em;margin-top:56px}
.og h1{font-size:76px;letter-spacing:-.045em;line-height:1.02;max-width:760px;margin-top:18px}
.og .crew{position:absolute;right:56px;bottom:40px;display:flex}.og .crew img{width:220px;height:220px;margin-left:-60px;filter:drop-shadow(0 16px 20px rgb(0 0 0/.18))}
.og .logo{font-size:34px}.og .logo .mark{width:60px;height:60px;border-radius:18px}.og .logo .mark img{width:52px;height:52px}
.og .url{position:absolute;left:80px;bottom:72px;font-size:24px;font-weight:600;color:var(--muted-foreground)}
</style></head><body><div class="og t-${card.tone}"><div><div class="logo"><span class="mark">${img('sebas')}</span>Socio</div><div class="k">${card.kicker}</div><h1>${card.title}</h1></div><span class="url">socio.sh</span><div class="crew">${card.crew.map(img).join('')}</div></div></body></html>`;
}

/** The apple-touch icon (180×180): Sebas on his warm tile, as the header's logo mark. */
export const touchIconHtml = (css: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>
html,body{margin:0;width:180px;height:180px;overflow:hidden;background:#ffe9d8}
.logo .mark{width:180px;height:180px;border-radius:0}.logo .mark img{width:150px;height:150px}
</style></head><body><span class="logo"><span class="mark">${img('sebas')}</span></span></body></html>`;
