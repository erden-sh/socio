import type { SiteEnv } from '../worker/headers.ts';

import { ORIGIN, PAGE_KEYS, PAGES, type PageKey, PRIVACY_EMAIL, SECURITY_EMAIL, SUPPORT_EMAIL } from './facts.ts';
import { pageMarkdown } from './markdown.ts';

// The site's plain files: security.txt, robots.txt, sitemap.xml, llms.txt and
// llms-full.txt.

/**
 * security.txt's expiry (RFC 9116 asks for less than a year ahead). tests/files.test.ts fails 30
 * days before it, so it is renewed in time; push it a year on when that happens.
 */
export const SECURITY_TXT_EXPIRES = '2027-11-16T00:00:00.000Z';

export const securityTxt = () => `Contact: mailto:${SECURITY_EMAIL}
Expires: ${SECURITY_TXT_EXPIRES}
Preferred-Languages: en
Canonical: ${ORIGIN}/.well-known/security.txt
`;

/** Production allows everything and names the sitemap; staging and local disallow everything. */
export const robotsTxt = (env: SiteEnv) =>
    env === 'production'
        ? `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`
        : 'User-agent: *\nDisallow: /\n';

const url = (key: PageKey) => `${ORIGIN}${PAGES[key].path}`;

export const sitemapXml = (lastmod: string) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGE_KEYS.map((key) => `  <url><loc>${url(key)}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;

/** One line per page, for llms.txt. */
const LINES: Record<PageKey, string> = {
    home: 'What Socio is: chat, rooms, pages, a board and approvals, with AI socios, on the web and on phones.',
    'self-host': 'Running Socio on your own servers, and the Sustainable Use License in plain words. Code coming soon.',
    hosted: 'Hosted Socio, run by Ingenio Ventures: early access and the waitlist. No price yet.',
    support: 'Answers about signing in, workspaces, notifications and the app, and how to reach a person.',
    privacy: 'Privacy Policy: what Socio collects, why, who sees it and how long it is kept.',
    terms: 'Terms of Service for the hosted service and the apps.',
    cookies: 'Cookie Policy: every cookie and storage item the site and apps use.',
    'delete-account': 'How to leave a workspace, how an admin removes an account, and what happens to the data.',
};

/** llms.txt (llmstxt.org): what Socio is, the pages, the license, and who to write to. */
export const llmsTxt = () => `# Socio

> Socio is a team workspace with AI socios: chats and rooms, Spaces and pages, a board, approvals, memories and schedules, on the web and in native iPhone and Android apps. Socios do the busywork and ask a person before anything that sends, pays or publishes. Socio is published by Ingenio Ventures Inc.

Socio's code is coming soon under the Sustainable Use License: free to run for your own team, on your own servers, with any OpenAI-compatible model; selling it as a competing hosted service is not allowed. Hosted Socio is in early access, with a waitlist and no price yet.

## Pages

${PAGE_KEYS.map((key) => `- [${PAGES[key].title.replace(/ · Socio$/, '')}](${url(key)}): ${LINES[key]}`).join('\n')}

## Contact

- Support and the hosted waitlist: ${SUPPORT_EMAIL}
- Privacy and account requests: ${PRIVACY_EMAIL}
- Security reports: ${SECURITY_EMAIL} (${ORIGIN}/.well-known/security.txt)

## Optional

- [Every page as Markdown](${ORIGIN}/llms-full.txt)
`;

/** llms-full.txt: every page's text as Markdown, in the sitemap's order. */
export const llmsFullTxt = (pages: Readonly<Record<PageKey, string>>) =>
    `# Socio: the full site as text\n\nThe pages of ${ORIGIN}, as Markdown, for AI agents.\n\n${PAGE_KEYS.map(
        (key) => `---\n\nSource: ${url(key)}\n\n${pageMarkdown(pages[key])}\n`,
    ).join('\n')}`;
