import type { Assets } from '../layout.ts';
import { m, page } from '../layout.ts';

// The 404 page (wrangler.toml, not_found_handling = "404-page"). Not in the sitemap.

export const notFound = (assets: Assets) =>
    page({
        key: 'home',
        active: null,
        assets,
        body: `<section class="page-hero t-sky"><div class="container with-art">
  <div><h1>We couldn’t find that page.</h1><p class="lede">It may have moved. Try the <a class="inline-link" href="/">home page</a> or <a class="inline-link" href="/support">Support</a>.</p></div>
  <div class="art">${m('iggy')}</div>
</div></section>`,
    }).replace(
        /<title>[^<]*<\/title>/,
        '<title>Page not found · Socio</title>\n<meta name="robots" content="noindex">',
    );
