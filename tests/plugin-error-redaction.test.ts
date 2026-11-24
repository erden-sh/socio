// A plugin runtime's error text reaches the admin's answer and the server log
// only after redaction: a refusal or failure that echoes a credential (a
// registry login, a bearer token, a URL with a password) must not carry it out.
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { pluginRoutes } from '../src/server/plugins/routes.js';
import type { PluginService } from '../src/server/plugins/service.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const MESSAGE = `pull refused for https://deploy:hunter2-registry-pass@registry.example.test/acme (Authorization: Bearer ${SECRET})`;

function app(error: Error) {
    const plugins = {
        setEnabled: async () => {
            throw error;
        },
    } as unknown as PluginService;
    const routes = new Hono<AppEnv>();
    routes.use('*', async (c, next) => {
        c.set('user', { id: 'u-admin', name: 'admin', role: 'admin' });
        await next();
    });
    routes.route('/api', pluginRoutes(plugins, {} as never, { audit: () => {} }));
    return routes;
}

afterEach(() => {
    vi.restoreAllMocks();
});

it('redacts credentials in a runtime refusal before the admin sees it', async () => {
    const answer = await app(Object.assign(new Error(MESSAGE), { status: 400 })).request(
        '/api/plugins/acme-notes/enable',
        { method: 'POST' },
    );
    expect(answer.status).toBe(409);
    const text = JSON.stringify(await answer.json());
    expect(text).toContain('pull refused');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('hunter2-registry-pass');
});

it('redacts credentials in an unexpected failure before it is logged', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args);
    });
    const answer = await app(Object.assign(new Error(MESSAGE), { status: 500 })).request(
        '/api/plugins/acme-notes/enable',
        { method: 'POST' },
    );
    expect(answer.status).toBe(502);
    const log = JSON.stringify(logged);
    expect(log).toContain('pull refused');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('hunter2-registry-pass');
});
