import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z, ZodError } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { GITHUB_REPOSITORY, type GitHubAppView, type GitHubConnectNext } from '@socio/shared/github-types';

import * as connect from './connect.js';
import { type GitHubAdminShape, type GitHubOptions, GitHubError } from './contract.js';
import { FlowStateError, SealedAppError } from './settings.js';

// Null goes back to the environment's value.
const repositoryInput = z
    .object({ repository: z.string().trim().regex(GITHUB_REPOSITORY).nullable() })
    .partial()
    .strict();
const createdInput = z
    .object({
        code: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
        state: z.string().min(1).max(200),
    })
    .strict();
const installedInput = z
    .object({
        installationId: z.string().regex(/^[1-9]\d{0,18}$/),
        state: z.string().min(1).max(200),
    })
    .strict();

/**
 * What the routes read of the platform's configuration, at the moment of
 * use: the app's origin and how GitHub is reached.
 */
export interface GitHubRouteConfig {
    readonly appOrigin?: string;
    readonly githubAccess?: GitHubOptions;
}

/** What the routes are built with: the App's settings, and the configuration. */
export interface GitHubRouteDeps {
    readonly github: GitHubAdminShape;
    readonly config: GitHubRouteConfig;
}

/**
 * The GitHub App, for admins only (the module's `access: 'admin'` guards
 * every path): the repository whose owner gets it, and "Connect GitHub"
 * (CB-32). Coding sessions' Git proxy and pull requests use the App
 * (CB-239). Its key is never sent back.
 */
export function githubRoutes({ github, config }: GitHubRouteDeps) {
    const app = new Hono<AppEnv>();
    const connectDeps: connect.ConnectDeps = {
        settings: github,
        appOrigin: config.appOrigin,
        github: config.githubAccess,
        log: (line) => console.log(line),
    };
    const view = () => github.view(!!config.appOrigin);
    app.get('/github', async (c) => c.json<GitHubAppView>(await view()));
    app.put('/github', async (c) => {
        const parsed = repositoryInput.safeParse(await c.req.json());
        if (!parsed.success) {
            return c.json({ error: 'Send repository as owner/name; null goes back to the server’s.' }, 400);
        }
        await github.save(parsed.data);
        console.log(`GitHub: settings changed by user=${c.get('user').id}`);
        return c.json<GitHubAppView>(await view());
    });
    // "Connect GitHub": GitHub's App manifest flow (connect.ts).
    app.post('/github/connect', async (c) =>
        c.json<GitHubConnectNext>(await connect.start(connectDeps, c.get('user').id)),
    );
    app.get('/github/manifest', async (c) => {
        const nonce = randomBytes(16).toString('base64');
        const page = await connect.manifestPage(connectDeps, c.get('user').id, c.req.query('state') ?? '', nonce);
        return c.html(page.html, 200, {
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${page.formAction}; base-uri 'none'; frame-ancestors 'none'`,
            'Referrer-Policy': 'no-referrer',
        });
    });
    app.post('/github/created', async (c) => {
        const parsed = createdInput.safeParse(await c.req.json());
        if (!parsed.success) {
            return c.json({ error: 'Send the code and state from GitHub.' }, 400);
        }
        return c.json<GitHubConnectNext>(await connect.created(connectDeps, c.get('user').id, parsed.data));
    });
    app.post('/github/installed', async (c) => {
        const parsed = installedInput.safeParse(await c.req.json());
        if (!parsed.success) {
            return c.json({ error: 'Send the installation id and state from GitHub.' }, 400);
        }
        await connect.installed(connectDeps, c.get('user').id, parsed.data);
        return c.json<GitHubAppView>(await view());
    });
    // Forgets the App here; it stays on GitHub until deleted there.
    app.delete('/github/app', async (c) => {
        await github.forgetApp();
        console.log(`GitHub: App disconnected by user=${c.get('user').id}`);
        return c.json<GitHubAppView>(await view());
    });

    app.onError((error, c) => {
        // The connect flow: what GitHub or the state check said.
        if (error instanceof FlowStateError || error instanceof SealedAppError) {
            return c.json({ error: error.message }, 409);
        }
        if (error instanceof GitHubError) {
            return c.json({ error: error.message }, 502);
        }
        if (error instanceof ZodError || error instanceof SyntaxError) {
            return c.json({ error: 'Invalid JSON request.' }, 400);
        }
        console.error('GitHub request failed:', error.name);
        return c.json({ error: 'GitHub settings could not complete this request.' }, 500);
    });
    return app;
}
