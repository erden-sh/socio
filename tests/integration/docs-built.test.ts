import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Hono } from 'hono';
import type { ServerBuild } from 'react-router';
import { it, expect } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { Role, User } from '@socio/shared/types';

import { buildDocsCatalog } from '../../src/server/docs/catalog.js';
import { mountDocsExports } from '../../src/server/docs/http.js';
import { mountWeb, type WebMountOptions } from '../../src/server/web/mount.js';
import { userServices, type WebServiceSources } from '../../src/server/web/services.js';

// Run after `pnpm build`: actual production route/data handling, no server/socket/provider.
it.skipIf(!existsSync('dist/web/server/index.js'))(
    'production docs SSR and data requests have identical fresh role boundaries and never ship restricted content assets',
    async () => {
        const entry = pathToFileURL(resolve('dist/web/server/index.js')).href;
        const build = (await import(/* @vite-ignore */ entry)) as ServerBuild;
        const docs = await buildDocsCatalog(
            (['user', 'admin', 'operate'] as const).map((a) => ({
                audience: a,
                name: 'index.md',
                markdown: `---\ntitle: ${a} catalog\ndescription: Useful ${a} guide\n---\n\n${a === 'operate' ? 'CB94_OPERATOR_PRIVATE_7a6b9d' : a === 'admin' ? 'CB94_ADMIN_PRIVATE_e19a82' : 'Public help contents.'}`,
            })),
        );
        let role: Role | undefined;
        const app = new Hono<AppEnv>();
        // As the composition mounts them (composition/http/web.ts): the
        // docs' exports, then the pages.
        const options: WebMountOptions = {
            build,
            mode: 'production',
            origin: 'https://socio.example',
            clientDir: resolve('dist/web/client'),
            services: () => ({
                headers: [],
                services: userServices({ docs } as WebServiceSources, async () =>
                    role ? ({ id: 'test', role } as User) : null,
                ),
            }),
        };
        mountDocsExports(app, options);
        mountWeb(app, options);
        // Admins read the guides to running Socio too (CB-390: no operator role).
        for (const r of [undefined, 'member', 'admin'] as const) {
            role = r;
            for (const [path, allowed] of [
                ['/docs', true],
                ['/docs/admin', r === 'admin'],
                ['/docs/operate', r === 'admin'],
            ] as const) {
                for (const suffix of ['', '.data', '.md']) {
                    const res = await app.request('https://socio.example' + path + suffix);
                    expect(res.status, `${r} ${path}${suffix}`).toBe(allowed ? 200 : 404);
                    expect(res.headers.get('cache-control')).toContain('no-store');
                    const text = await res.text();
                    if (r !== 'admin') {
                        expect(text).not.toContain('CB94_OPERATOR_PRIVATE_7a6b9d');
                        expect(text).not.toContain('CB94_ADMIN_PRIVATE_e19a82');
                    }
                    if (path === '/docs' && suffix === '') {
                        expect(text).toContain('Public help contents.');
                    }
                }
            }
        }
        role = 'admin';
        expect((await app.request('https://socio.example/docs/operate')).status).toBe(200);
        role = 'member';
        expect((await app.request('https://socio.example/docs/operate')).status).toBe(404);
        const assets = await readdir('dist/web/client/assets');
        for (const name of assets.filter((n) => /\.(js|json)$/.test(n))) {
            const text = await readFile(resolve('dist/web/client/assets', name), 'utf8');
            expect(text).not.toMatch(/CB94_OPERATOR_PRIVATE_7a6b9d|CB94_ADMIN_PRIVATE_e19a82|content\/docs\/operate/);
        }
        for (const p of ['/content/docs/operate/index.md', '/assets/operate/index.md']) {
            expect((await app.request('https://socio.example' + p)).status).toBe(404);
        }
    },
    30000,
);
