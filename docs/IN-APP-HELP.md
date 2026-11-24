# In-app help platform (CB-94)

Socio serves plain Markdown guides through its existing Hono server and React Router SSR at `/docs`. Fumadocs Core and UI16.17.8 provide the server source loader, search engine, layout, navigation and TOC. The styling uses Socio's existing light/dark theme and system fonts. The implementation follows Erden's in-app docs design and the [official React Router integration](https://www.fumadocs.dev/docs/manual-installation/react-router) and [server source API](https://www.fumadocs.dev/docs/headless/source-api).

`content/docs/user/*.md` maps to `/docs/<slug>`, `admin/*.md` to `/docs/admin/<slug>`, and `operate/*.md` to `/docs/operate/<slug>`. `index.md` maps to the section root. Files have exactly `title` and `description` YAML frontmatter. The directory determines audience; frontmatter cannot override access. Markdown supports tables, fenced code, headings and HTTPS/local links. Raw HTML and image embeds are rejected. Guides are text-first; no remote image fetches occur.

The process reads bounded, real regular files and compiles them once at startup into sanitized HAST. Invalid frontmatter, markup, filenames, duplicate paths, missing docs links, or links from a lower to a higher audience refuse startup. No MDX or content is imported by the client. Docker packages `content/docs` separately from `dist/web/client`. The static boundary check and a Vite client graph guard reject content imports. The browser receives only the current page, TOC and allowed tree as plain data, rendered with a fixed HAST runtime.

Public/member viewers get user guides; admins also get admin guides; operators get all three sections. Each request resolves the current viewer before any catalog lookup, including unknown paths. There is no cross-request identity or audience cache. All docs responses use `no-store` and vary by Cookie, Origin and Accept. Restricted and unknown pages return404 and render the same **Article not found** page in the help center (the viewer's own navigation, a link back to `/docs` and a search button), so the page never says which it was (CB-264). Data navigation, raw Markdown (`/docs.md`, `/docs/<slug>.md`), search (`/docs/search?query=...`), `/llms.txt`, and `/llms-full.txt` use the same role-filtered catalog. Raw exports mount before static files, retain host/method checks and reject sibling/cross-site requests. Search is server-only, limited to128 characters,20 results and8 active searches; no downloadable index exists. Background-tab/BFCache restoration reloads the docs to recheck access.

`getDocsCatalog()` in `src/server/docs/catalog.ts` is the shared process accessor. The catalog exposes `list(role)`, `screen(url, role)`, `markdown(url, role)`, `search(query, role)`, and `llms(full, role)`. Callers must resolve the viewer freshly before invoking it; a role is trusted server identity, never request input. The MCP integration uses an explicit new permission rather than widening existing grants.

Validation commands:

```sh
pnpm run check:docs-boundary
pnpm run typecheck
pnpm run build
pnpm exec vitest run tests/docs*.test.*
```

The production-build test skips without `dist/web/server/index.js`; run it after building. It exercises the actual built SSR and `.data` routes for every role, revocation between requests, raw exports, static fallback and asset sentinels without a listening socket, model call, authentication mutation or real workspace data.
