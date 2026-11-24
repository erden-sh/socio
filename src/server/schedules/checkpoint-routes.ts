import { Hono, type Context, type Handler } from 'hono';
import { z } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv } from '@socio/foundation/http/app-env';

import type { ModuleServicesAccess } from '../modules/contract.js';

import { JobError } from './jobs.js';
import { CLAIM_MAX, ITEMS_PER_CALL, type LongRunService } from './long-runs.js';
import { FullLongRuns } from './tags.js';

const key = z.string().min(1).max(200);
const bodies = {
    items: z
        .object({
            keys: z.array(key).max(ITEMS_PER_CALL).default([]),
            complete: z.boolean().optional(),
        })
        .strict(),
    claim: z.object({ limit: z.number().int().min(1).max(CLAIM_MAX).optional() }).strict(),
    done: z
        .object({
            key,
            write: z
                .object({
                    dataset: z.string().min(1).max(100),
                    table: z.string().min(1).max(64),
                    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
                    key: z.array(z.string()).min(1).max(8),
                })
                .strict()
                .optional(),
        })
        .strict(),
    fail: z
        .object({
            key,
            error: z.string().max(2000).default(''),
            retry: z.boolean().optional(),
            status: z.number().int().min(100).max(599).optional(),
            retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
        })
        .strict(),
    checkpoint: z.object({ value: z.unknown() }).strict(),
    pause: z
        .object({
            reason: z.string().max(2000).default(''),
            status: z.number().int().min(100).max(599).optional(),
            retryAfterSeconds: z.number().int().min(0).max(86_400).optional(),
        })
        .strict(),
    complete: z.object({ summary: z.string().max(2000).optional() }).strict(),
};

/**
 * The checkpoint API (CB-122), `$CB_DATA_URL/job`: a batch of a job that
 * runs until done, with its run's data token, declares and claims items,
 * marks each done or failed, keeps a checkpoint, pauses on a source's
 * refusal and says when the job is complete. Mounted with the data
 * routes, the only ones a data token reaches; a session can't use it.
 */
export function jobCheckpointRoutes(platform: { readonly longRuns: LongRunService }) {
    const app = new Hono<AppEnv>();
    const runs = platform.longRuns;
    const handle =
        (work: (c: Context<AppEnv>) => unknown): Handler<AppEnv> =>
        async (c) => {
            const scope = c.get('dataToken');
            if (scope?.purpose !== 'job') {
                return c.json({ error: 'Only a job run’s data token reaches the checkpoint API.' }, 403);
            }
            try {
                return c.json((await work(c)) ?? { ok: true });
            } catch (error) {
                if (error instanceof JobError || error instanceof DataError) {
                    return c.json({ error: error.message }, error.status);
                }
                throw error;
            }
        };
    const body = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            throw new JobError('Invalid request.');
        }
        return parsed.data;
    };
    const scope = (c: Context<AppEnv>) => c.get('dataToken')!;

    app.get(
        '/',
        handle((c) => runs.batchState(scope(c))),
    );
    app.post(
        '/items',
        handle(async (c) => {
            const input = await body(c, bodies.items);
            return runs.addItems(scope(c), input.keys, !!input.complete);
        }),
    );
    app.post(
        '/claim',
        handle(async (c) => {
            const input = await body(c, bodies.claim);
            return runs.claim(scope(c), input.limit ?? 10);
        }),
    );
    app.post(
        '/done',
        handle(async (c) => {
            const input = await body(c, bodies.done);
            return runs.done(scope(c), input.key, input.write);
        }),
    );
    app.post(
        '/fail',
        handle(async (c) => runs.fail(scope(c), await body(c, bodies.fail))),
    );
    app.post(
        '/checkpoint',
        handle(async (c) => {
            const input = await body(c, bodies.checkpoint);
            return runs.checkpoint(scope(c), input.value);
        }),
    );
    app.post(
        '/pause',
        handle(async (c) => runs.pause(scope(c), await body(c, bodies.pause))),
    );
    app.post(
        '/complete',
        handle(async (c) => {
            const input = await body(c, bodies.complete);
            return runs.markComplete(scope(c), input.summary);
        }),
    );
    return app;
}

/**
 * The checkpoint routes over the long runs the app's services hold
 * (`FullLongRuns`): what the data space's module mounts at `/data/job`
 * (`makeDataModule`, the module registry), read when it mounts them.
 */
export const jobCheckpointRoutesOf = (services: ModuleServicesAccess) =>
    jobCheckpointRoutes({ longRuns: services.get(FullLongRuns) });
