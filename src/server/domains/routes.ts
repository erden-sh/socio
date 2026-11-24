import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireOperator } from '@socio/foundation/http/guards';
import type { DomainOpStarted } from '@socio/shared/domains';

import { DomainsError, type DomainsShape } from './contract.js';

const provisionInput = z.object({ hostname: z.string().min(1).max(253) }).strict();

const STATUS: Partial<Record<DomainsError['code'], 400 | 404 | 409 | 503>> = {
    not_configured: 503,
    invalid_hostname: 400,
    outside_zone: 400,
    covered: 400,
    busy: 409,
    not_managed: 404,
};

/**
 * `/api/domains`, operators only (403 for admins and members):
 * `GET /domains` (status), `POST /domains/base` (set up or repair the
 * base), `POST /domains/hosts { hostname }` (provision one),
 * `DELETE /domains/hosts/:hostname`. Operations answer 202 with the op and
 * run in the background (a certificate can take minutes); the page polls.
 */
export function domainRoutes(domains: DomainsShape) {
    const app = new Hono<AppEnv>();
    app.use('/domains', requireOperator);
    app.use('/domains/*', requireOperator);
    const refusal = (error: unknown) => {
        if (error instanceof DomainsError && STATUS[error.code]) {
            return {
                body: { error: error.message, code: error.code },
                status: STATUS[error.code]!,
            };
        }
        throw error;
    };
    app.get('/domains', async (c) => c.json(await domains.status()));
    app.post('/domains/base', async (c) => {
        try {
            const { op } = await domains.startEnsureBase(c.get('user').id);
            return c.json({ op } satisfies DomainOpStarted, 202);
        } catch (error) {
            const { body, status } = refusal(error);
            return c.json(body, status);
        }
    });
    app.post('/domains/hosts', async (c) => {
        const parsed = provisionInput.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
            return c.json({ error: 'Give a hostname.' }, 400);
        }
        try {
            const { op } = await domains.startProvision(parsed.data.hostname, c.get('user').id);
            return c.json({ op } satisfies DomainOpStarted, 202);
        } catch (error) {
            const { body, status } = refusal(error);
            return c.json(body, status);
        }
    });
    app.delete('/domains/hosts/:hostname', async (c) => {
        try {
            const { op } = await domains.startRemove(c.req.param('hostname'), c.get('user').id);
            return c.json({ op } satisfies DomainOpStarted, 202);
        } catch (error) {
            const { body, status } = refusal(error);
            return c.json(body, status);
        }
    });
    return app;
}
