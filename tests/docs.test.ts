import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { Role, User } from '@socio/shared/types';

import { buildDocsCatalog, readDocs } from '../src/server/docs/catalog.js';
import type { DocsFile } from '../src/server/docs/contract.js';
import { mountDocsExports } from '../src/server/docs/http.js';
import type { WebOptions } from '../src/server/web/contract.js';
import { userServices, type WebServiceSources } from '../src/server/web/services.js';

const page = (audience: DocsFile['audience'], name: string, body: string): DocsFile => ({
    audience,
    name,
    markdown: `---\ntitle: ${audience} guide\ndescription: How to use ${audience}\n---\n\n${body}`,
});
const files = [
    page('user', 'index.md', 'Public shared instruction.\n\n## First chat\n\nTalk to a socio.'),
    page('admin', 'index.md', 'ADMIN_SENTINEL hidden settings'),
    page('operate', 'index.md', 'OPERATOR_SENTINEL hidden storage'),
];
const catalog = () => buildDocsCatalog(files);
describe('server-only documentation catalog', () => {
    it('filters page, tree, metadata, search, Markdown and both LLM exports by fresh role', async () => {
        const docs = await catalog();
        // CB-390: admins read the guides to running Socio too.
        for (const role of [undefined, 'member', 'admin'] as const) {
            const admin = role === 'admin',
                operator = role === 'admin';
            expect(!!docs.screen('/docs/admin', role)).toBe(admin);
            expect(!!docs.screen('/docs/operate', role)).toBe(operator);
            expect(!!docs.markdown('/docs/admin', role)).toBe(admin);
            expect(!!docs.markdown('/docs/operate', role)).toBe(operator);
            const publicResult = JSON.stringify(docs.screen('/docs', role));
            expect(publicResult.includes('/docs/admin')).toBe(admin);
            expect(publicResult.includes('/docs/operate')).toBe(operator);
            for (const full of [false, true]) {
                const exportText = docs.llms(full, role);
                expect(exportText.includes('/docs/admin')).toBe(admin);
                expect(exportText.includes('/docs/operate')).toBe(operator);
                if (!admin) {
                    expect(exportText).not.toContain('ADMIN_SENTINEL');
                }
                if (!operator) {
                    expect(exportText).not.toContain('OPERATOR_SENTINEL');
                }
            }
            expect((await docs.search('OPERATOR_SENTINEL', role)).length > 0).toBe(operator);
            expect((await docs.search('ADMIN_SENTINEL', role)).length > 0).toBe(admin);
            expect(docs.screen('/docs/no-such-page', role)).toBeNull();
        }
        expect(docs.screen('/docs')?.page.toc).toContainEqual({
            title: 'First chat',
            url: '#first-chat',
            depth: 2,
        });
        expect(JSON.stringify(docs.screen('/docs'))).not.toMatch(/markdown|audience|ADMIN_SENTINEL|OPERATOR_SENTINEL/);
    });
    it('re-resolves viewer before lookup per request and revocation loses every restricted surface', async () => {
        const docs = await catalog();
        let role: Role = 'admin',
            calls = 0;
        const request = () =>
            userServices({ docs } as WebServiceSources, async () => {
                calls++;
                return { id: 'test', role } as User;
            });
        expect(await request().docsPage?.('/docs/operate')).not.toBeNull();
        expect(JSON.stringify(await request().docsTree?.())).toContain('/docs/operate');
        role = 'member';
        expect(await request().docsPage?.('/docs/operate')).toBeNull();
        // The not-found page's navigation is the viewer's own (CB-264).
        expect(JSON.stringify(await request().docsTree?.())).not.toMatch(/\/docs\/(?:operate|admin)/);
        expect(await request().docsMarkdown?.('/docs/operate')).toBeNull();
        expect(await request().docsSearch?.('OPERATOR_SENTINEL')).toEqual([]);
        expect(await request().docsLlms?.(true)).not.toContain('OPERATOR_SENTINEL');
        expect(await request().docsPage?.('/docs/unknown')).toBeNull();
        expect(calls).toBe(8);
    });
    it('rejects executable markup, unsafe URLs, audience overrides, collisions and restricted public links', async () => {
        for (const body of [
            '<script>alert(1)</script>',
            '[attack](javascript:alert)',
            '![beacon](https://example.com/x.png)',
            '[secret](/docs/operate)',
            '[missing](/docs/missing)',
        ]) {
            await expect(buildDocsCatalog([page('user', 'index.md', body), files[2]])).rejects.toThrow();
        }
        await expect(
            buildDocsCatalog([
                {
                    ...files[0],
                    markdown: '---\ntitle: Title\ndescription: D\nrole: operator\n---\ntext',
                },
            ]),
        ).rejects.toThrow();
        await expect(buildDocsCatalog([files[0], files[0]])).rejects.toThrow();
        await expect(
            buildDocsCatalog([page('admin', 'index.md', '[restricted](/docs/operate)'), files[2]]),
        ).rejects.toThrow();
        await expect(
            buildDocsCatalog([page('user', 'index.md', '[restricted](/docs/admin)'), files[1]]),
        ).rejects.toThrow();
        await expect(buildDocsCatalog([page('user', 'operate.md', 'shadow')])).rejects.toThrow();
        await expect(
            buildDocsCatalog([
                {
                    ...files[0],
                    markdown: '---\ntitle: First\ntitle: Again\ndescription: D\n---\ntext',
                },
            ]),
        ).rejects.toThrow();
    });
    it('renders Markdown as sanitized data, keeps code literal and bounds searches', async () => {
        const docs = await buildDocsCatalog([
            page('user', 'index.md', '```js\n<script>neverExecute()</script>\n```\n\n**Useful** [page](/docs).'),
        ]);
        const tree = JSON.stringify(docs.screen('/docs'));
        expect(tree).toContain('neverExecute');
        expect(tree).not.toContain('"tagName":"script"');
        expect(await docs.search('')).toEqual([]);
        await expect(docs.search('x'.repeat(129))).rejects.toThrow('search limit');
    });
    it('reads only bounded confined regular Markdown files, refusing symlinks and hardlinks', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'socio-docs-'));
        try {
            for (const a of ['user', 'admin', 'operate']) {
                await mkdir(join(dir, a));
            }
            await writeFile(join(dir, 'user/index.md'), files[0].markdown);
            expect(await readDocs(dir)).toHaveLength(1);
            await symlink(join(dir, 'user/index.md'), join(dir, 'admin/index.md'));
            await expect(readDocs(dir)).rejects.toThrow();
            await rm(join(dir, 'admin/index.md'));
            await link(join(dir, 'user/index.md'), join(dir, 'admin/index.md'));
            await expect(readDocs(dir)).rejects.toThrow();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
    it('raw exports precede static fallback, require identity even on404 and never cache restricted answers', async () => {
        const docs = await catalog();
        let role: Role | undefined,
            calls = 0;
        const app = new Hono<AppEnv>();
        mountDocsExports(app, {
            origin: 'https://socio.example',
            services: () => ({
                headers: [],
                services: userServices({ docs } as WebServiceSources, async () => {
                    calls++;
                    return role ? ({ id: 'test', role } as User) : null;
                }),
            }),
        } as unknown as WebOptions);
        app.get('*', (c) => c.text('static fallback'));
        for (const [path, status] of [
            ['/docs.md', 200],
            ['/docs/operate.md', 404],
            ['/docs/missing.md', 404],
            ['/llms.txt', 200],
            ['/llms-full.txt', 200],
            ['/docs/search?query=OPERATOR_SENTINEL', 200],
        ] as const) {
            const r = await app.request('https://socio.example' + path);
            expect(r.status).toBe(status);
            expect(r.headers.get('cache-control')).toBe('private, no-store');
            expect(r.headers.get('vary')).toContain('Cookie');
            expect(await r.text()).not.toMatch(/OPERATOR_SENTINEL|ADMIN_SENTINEL|static fallback/);
        }
        expect(calls).toBe(6);
        role = 'admin';
        expect(await (await app.request('https://socio.example/docs/operate.md')).text()).toContain(
            'OPERATOR_SENTINEL',
        );
        role = 'member';
        expect((await app.request('https://socio.example/docs/operate.md')).status).toBe(404);
        expect(
            (
                await app.request('https://socio.example/llms-full.txt', {
                    headers: { 'sec-fetch-site': 'same-site' },
                })
            ).status,
        ).toBe(404);
        expect((await app.request('https://foreign.example/docs.md')).status).toBe(403);
        expect((await app.request('https://socio.example/docs.md', { method: 'POST' })).status).toBe(405);
        const head = await app.request('https://socio.example/docs.md', {
            method: 'HEAD',
        });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
    });
});
