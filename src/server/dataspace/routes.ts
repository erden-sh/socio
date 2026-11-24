import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv, DataTokenScope } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import type { DataSpaceState, DataUsageState } from '@socio/shared/data-types';
import { specRunBody } from '@socio/shared/dataset-query/result';
import { specValidateBody } from '@socio/shared/dataset-query/spec';
import { VIEW_NO_ACCESS, VIEW_NO_ACCESS_CODE, viewQueryBody } from '@socio/shared/dataset-view';
import { answerSchema } from '@socio/shared/dataset-views/schema';
import { DATA_API_TOKENS_PATH, dataApiTokenCreateBody, type DataApiScope } from '@socio/shared/dataspace/api-tokens';
import { type DataApiOperation } from '@socio/shared/dataspace/operations';
import { isAdmin } from '@socio/shared/roles';

import type { ActorActionsShape, ActorsShape } from '../actors/contract.js';
import type { SpacesShape } from '../workspace/contract.js';

import { type AgentActor, type DataActor, type DataCountersShape } from './contract.js';
import { dataView } from './data-views.js';
import { APPROVAL_HEADER, DataAuthority, OBO_HEADER } from './obo.js';
import { BatchExpectationError } from './query-runner.js';
import { SpecRunner } from './query-spec/run.js';
import { validateSpec } from './query-spec/validate.js';
import type { DataSpace } from './space.js';
import { DatasetViews } from './views.js';

/**
 * What the data routes are given: the data space, socio access, and the
 * workspace's pages and Space reads. The consume-once approvals are actors'
 * `ActorActions` (`consumeAppAction`), from the module's services.
 */
export type DataRoutesPlatform = {
    readonly data: DataSpace;
    readonly actors: ActorsShape;
    /**
     * Embedded dataset views read pages (only that a page exists, which
     * pages' `PageStoreShape` satisfies), and who reads a Space.
     */
    readonly workspace: { readonly pages: { get(spaceId: string, id: string): unknown } } & Pick<
        SpacesShape,
        'readsSpace'
    >;
    /** The change counters its conditional answers read (CB-451). */
    readonly counters: DataCountersShape;
};

/**
 * The job checkpoint routes (CB-122) the data routes mount at `/data/job`,
 * made where they mount them: schedules' `jobCheckpointRoutesOf` over the
 * app's services, which the module registry (`modules/index.ts`) passes
 * to the module, so dataspace names nothing of schedules but through this
 * signature. They move to the composition root's HTTP files when it mounts
 * them.
 */
export type DataJobRoutes = () => Hono<AppEnv>;

/** File uploads carry base64, so they get their own body limit (app.ts). */
export const DATA_UPLOAD_PATH = /^\/api\/data\/files$/;
/** Appends to an analytical table stream their body to disk under their own limit (CB-369). */
export const DATA_APPEND_PATH = /^\/api\/data\/datasets\/[^/]+\/tables\/[^/]+\/append$/;
/** The idempotency key of an append: a retried one adds nothing. */
export const APPEND_ID_HEADER = 'x-cb-append-id';

const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const queryBody = z
    .object({
        sql: z.string().min(1).max(20_000),
        params: z.array(value).max(100).optional(),
        maxRows: z.number().int().min(1).optional(),
    })
    .strict();
const datasetBody = z
    .object({
        name: z.string().min(1).max(80),
        description: z.string().max(500).optional(),
        // "New dataset" in a Space (CB-451): made there, under a page or at its root.
        sharedSpaceId: z.string().min(1).max(64).optional(),
        spaceParentId: z.string().min(1).max(64).nullable().optional(),
    })
    .strict();
const datasetPatch = z
    .object({
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
        sharedSpaceId: z.string().min(1).max(64).nullable().optional(),
        // Days kept rows are kept (CB-369); null keeps all of them.
        historyDays: z.number().int().min(1).max(3650).nullable().optional(),
        // Its place in its Space (CB-451): under a page or at the root, at a key.
        spaceParentId: z.string().min(1).max(64).nullable().optional(),
        spacePosition: z.string().min(1).max(80).nullable().optional(),
    })
    .strict();
const grantBody = z
    .object({
        dotId: z.string().min(1).max(64),
        datasetId: z.string().min(1).max(64).optional(),
        folder: z.string().min(1).max(512).optional(),
        access: z.enum(['read', 'write']),
    })
    .strict();
/**
 * A batch (`DataSpace.batch`): statements that change rows, SQL with bound
 * params or rows as the single write takes them. Its length is checked
 * against `batchMaxStatements` (an admin's limit), each statement by the
 * engine (`batchRuns`).
 */
// CB-475: the changes a statement must make, or the whole batch rolls back.
const expectChanges = z.number().int().min(0).optional();
const batchStatement = z.union([
    z
        .object({
            sql: z.string().min(1).max(20_000),
            params: z.array(value).max(100).optional(),
            expectChanges,
        })
        .strict(),
    z
        .object({
            op: z.literal('insert'),
            table: z.string().min(1).max(63),
            rows: z.array(z.record(z.string(), z.unknown())).min(1),
            expectChanges,
        })
        .strict(),
    z
        .object({
            op: z.literal('upsert'),
            table: z.string().min(1).max(63),
            rows: z.array(z.record(z.string(), z.unknown())).min(1),
            key: z.array(z.string().min(1).max(63)).min(1).max(8),
            expectChanges,
        })
        .strict(),
]);
const batchBody = z.object({ statements: z.array(batchStatement).min(1).max(1000) }).strict();
/** A read batch (CB-474): SELECTs, checked against `batchMaxStatements` by `DataSpace.readBatch`. */
const readBatchBody = z
    .object({
        statements: z
            .array(
                z
                    .object({
                        sql: z.string().min(1).max(20_000),
                        params: z.array(value).max(100).optional(),
                    })
                    .strict(),
            )
            .min(1)
            .max(1000),
        maxRows: z.number().int().min(1).optional(),
    })
    .strict();
const budgetBody = z.object({ statementsPerMinute: z.number().nullable() }).strict();
const fileBody = z
    .object({
        path: z.string().min(1).max(512),
        content: z.string(),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
        mediaType: z.string().max(100).optional(),
    })
    .strict();

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';

/** Streams a request body to `file`, refusing it (413) past `maxBytes`. */
async function saveBody(stream: ReadableStream<Uint8Array> | null, file: string, maxBytes: number) {
    if (!stream) {
        throw new DataError('Send the rows in the body.');
    }
    mkdirSync(dirname(file), { recursive: true });
    const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    let size = 0;
    try {
        await pipeline(
            Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>),
            new Transform({
                transform(chunk: Buffer, _encoding, done) {
                    size += chunk.length;
                    done(
                        size > maxBytes
                            ? new DataError(`Send at most ${Math.round(maxBytes / 1048576)} MB per append.`, 413)
                            : null,
                        chunk,
                    );
                },
            }),
            out,
        );
    } catch (error) {
        rmSync(file, { force: true });
        throw error instanceof DataError ? error : new DataError('The body could not be read.');
    }
}

/**
 * The scope a data API token needs for each data operation; null: none
 * reaches it (deletes that need a person, and files). A route a token
 * reaches names its operation, or its scope (`DataAccess.apiScope`); one
 * that names neither refuses every data API token.
 */
export const API_SCOPE_OF: Record<DataApiOperation, DataApiScope | null> = {
    read: 'data:read',
    query: 'data:read',
    analyticsQuery: 'data:read',
    insert: 'data:write',
    upsert: 'data:write',
    batch: 'data:write',
    append: 'data:write',
    appendFrom: 'data:write',
    analyze: 'data:write',
    createTable: 'data:admin',
    addColumn: 'data:admin',
    createIndex: 'data:admin',
    dropIndex: 'data:admin',
    tableHistory: 'data:admin',
    deleteRows: null,
    dropTable: null,
    deleteDataset: null,
    'files.read': null,
    'files.write': null,
    'files.delete': null,
};

/** The data operation a route is, for an app's token (CB-232). */
interface DataAccess {
    op?: DataApiOperation | ((c: Context<AppEnv>) => DataApiOperation | Promise<DataApiOperation>);
    /** A route a data API token reaches without a data operation of its own (a user route opened to it): any of these scopes. */
    apiScope?: DataApiScope | readonly DataApiScope[];
    /** The dataset reference the route names. */
    dataset?: (c: Context<AppEnv>) => string;
    /**
     * A consequential route's input for its approval's parameters
     * (`operations.ts`), from the same values the work uses.
     */
    params?: (c: Context<AppEnv>) => unknown;
}
const attachment = (name: string, extension: string) =>
    `attachment; filename="${name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'dataset'}.${extension}"`;

/**
 * `/api/data`. A signed-in user manages their own data space; datasets
 * other users shared with a Space are read-only to them. A scoped data
 * token (a computer command, a job) acts as its Dot for its user: the
 * Dot's scratch dataset and grants, nothing else (on a company socio's
 * computer, the socio's shared area and, to read, the grants shared with
 * a Space: CB-224), and never the user-only routes (grants, deletes,
 * exports, settings). Admins see everyone's
 * usage, never their data.
 */
export function dataRoutes(
    platform: DataRoutesPlatform,
    actions: Pick<ActorActionsShape, 'consumeAppAction'>,
    jobRoutes: DataJobRoutes,
) {
    const app = new Hono<AppEnv>();
    const space = platform.data;
    const actorOf = (c: Context<AppEnv>): DataActor => {
        const token = c.get('dataToken');
        if (token) {
            return {
                kind: 'token',
                purpose: token.purpose,
                userId: token.userId,
                dotId: token.dotId,
                datasetIds: token.datasetIds,
                ...(token.appId ? { appId: token.appId } : {}),
                ...(token.reach ? { reach: token.reach } : {}),
                ...(token.pluginId ? { pluginId: token.pluginId } : {}),
                ...(token.purpose === 'api' && token.apiToken ? { apiToken: token.apiToken } : {}),
            };
        }
        return { kind: 'user', userId: c.get('user').id };
    };
    const userOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('dataToken')) {
            return c.json({ error: 'A data token can’t do this; the user does it in the app.' }, 403);
        }
        await next();
    };
    const lacksScope = (c: Context<AppEnv>, scope: DataApiScope | readonly DataApiScope[]) =>
        c.json({ error: `This data API token can’t do this: it needs ${[scope].flat().join(' or ')}.` }, 403);
    const hasScope = (token: DataTokenScope, scope: DataApiScope | readonly DataApiScope[]) =>
        [scope].flat().some((one) => !!token.apiToken?.scopes.includes(one));
    /**
     * A user route an admin's data API token with `scope` also reaches;
     * every other data token is refused as `userOnly` refuses it.
     */
    const userOrApi = (scope: DataApiScope | readonly DataApiScope[]): MiddlewareHandler<AppEnv> =>
        async function userOrApi(c, next) {
            const token = c.get('dataToken');
            if (token && token.purpose !== 'api') {
                return c.json({ error: 'A data token can’t do this; the user does it in the app.' }, 403);
            }
            if (token && !hasScope(token, scope)) {
                return lacksScope(c, scope);
            }
            await next();
        };
    // A plugin's token reaches its declared datasets, nothing else: no files.
    // Nor does an admin's data API token: the company's datasets only.
    const datasetsOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
        const purpose = c.get('dataToken')?.purpose;
        if (purpose === 'plugin') {
            return c.json({ error: 'A plugin’s data token reaches the datasets it declares, not files.' }, 403);
        }
        if (purpose === 'api') {
            return c.json({ error: 'A data API token reaches the company’s datasets, not files.' }, 403);
        }
        await next();
    };
    const tokenOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (!c.get('dataToken')) {
            return c.json(
                {
                    error: 'Socios change datasets; the app browses, exports and deletes them.',
                },
                403,
            );
        }
        await next();
    };
    // An app's request on behalf of a person or socio (`x-cb-obo`), and a
    // contract app's request without one: CB-232, `obo.ts`.
    // A socio's consequential call consumes its approval through the
    // consume-once approvals (CB-232).
    const authority = new DataAuthority(space, platform.actors, (input) =>
        actions.consumeAppAction({ ...input, kind: 'data' }),
    );
    /**
     * Runs a route's work. `access` names the data operation a route is for
     * an app's token (its fixed tier) and the dataset it touches; a
     * route without one refuses an app's on-behalf-of request and a
     * contract app's, so a new token route can't skip the check.
     */
    const handle =
        (work: (c: Context<AppEnv>) => unknown, access?: DataAccess): Handler<AppEnv> =>
        async (c) => {
            const token = c.get('dataToken');
            const op = access?.op && (typeof access.op === 'function' ? await access.op(c) : access.op);
            // An admin's data API token: only what its scopes name, on routes
            // that say which (fails closed on any other).
            if (token?.purpose === 'api') {
                const scope = access?.apiScope ?? (op ? API_SCOPE_OF[op] : null);
                if (!scope) {
                    return c.json({ error: 'A data API token can’t do this; an admin does it in the app.' }, 403);
                }
                if (!hasScope(token, scope)) {
                    return lacksScope(c, scope);
                }
            }
            const gate = await authority.gate({
                token,
                actor: token ? (actorOf(c) as AgentActor) : undefined,
                obo: c.req.header(OBO_HEADER),
                op,
                dataset: access?.dataset?.(c),
                approval: c.req.header(APPROVAL_HEADER),
                ...(access?.params ? { params: () => access.params!(c) } : {}),
            });
            if (!gate.ok) {
                return c.json({ error: gate.error }, gate.status);
            }
            let status = 500;
            try {
                const response = await run(c, work);
                status = response.status;
                return response;
            } finally {
                gate.after?.(status);
            }
        };
    const run = async (c: Context<AppEnv>, work: (c: Context<AppEnv>) => unknown): Promise<Response> => {
        try {
            const result = await work(c);
            if (result instanceof Response) {
                return result;
            }
            return c.json(result ?? { ok: true });
        } catch (error) {
            if (error instanceof DataError) {
                return c.json(
                    {
                        error: error.message,
                        ...(error.message === VIEW_NO_ACCESS ? { code: VIEW_NO_ACCESS_CODE } : {}),
                        // CB-475: which statement's expectChanges failed, for a driver to report.
                        ...(error instanceof BatchExpectationError
                            ? {
                                  code: error.code,
                                  index: error.index,
                                  expected: error.expected,
                                  actual: error.actual,
                              }
                            : {}),
                    },
                    error.status,
                );
            }
            if (error instanceof ZodError) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            throw error;
        }
    };
    const datasetParam = (c: Context<AppEnv>) => param(c, 'id');
    const body = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            throw new DataError('Invalid request.');
        }
        return parsed.data;
    };
    const usage = (c: Context<AppEnv>): DataUsageState => {
        const actor = actorOf(c);
        if (actor.kind !== 'user') {
            // A token gets the usage it writes against, without whose (CB-224).
            const own: DataUsageState['own'] = space.tokenUsage(actor);
            delete own.userId;
            return { limits: space.limits, own };
        }
        return {
            limits: space.limits,
            own: space.usage(actor.userId),
            ...(actor.kind === 'user' && isAdmin(c.get('user')) ? { all: space.usageAll() } : {}),
        };
    };

    // `?files=false`: without the file list (the Data page lists files on
    // Media; its first screen and its loader leave them out).
    app.get(
        '/data',
        userOnly,
        handle((c): DataSpaceState =>
            dataView(space, c.get('user'), {
                files: c.req.query('files') !== 'false',
            }),
        ),
    );
    app.get('/data/usage', handle(usage, { op: 'read' }));
    app.get(
        '/data/shared/:dotId/files/raw',
        userOnly,
        handle(async (c) => {
            const { file, data } = await space.getSharedFile(
                c.get('user').id,
                param(c, 'dotId'),
                c.req.query('path') ?? '',
            );
            return new Response(new Uint8Array(data), {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Disposition': attachment(file.path.split('/').pop() ?? 'file', 'bin'),
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store',
                },
            });
        }),
    );
    app.get(
        '/data/shared',
        userOnly,
        handle((c) => space.sharedAreas(c.get('user').id)),
    );
    app.delete(
        '/data/shared/:dotId/files',
        userOnly,
        handle(async (c) => {
            await space.deleteSharedFile(c.get('user').id, param(c, 'dotId'), c.req.query('path') ?? '');
            return { ok: true };
        }),
    );
    app.delete(
        '/data/shared/:dotId/tables/:table',
        userOnly,
        handle((c) => {
            space.deleteSharedTable(c.get('user').id, param(c, 'dotId'), param(c, 'table'));
            return { ok: true };
        }),
    );
    app.delete(
        '/data/shared/:dotId/tables/:table/rows',
        userOnly,
        handle(async (c) => {
            const input = await body(
                c,
                z.object({ rowids: z.array(z.number().int().safe()).min(1).max(1000) }).strict(),
            );
            return space.deleteSharedRows(c.get('user').id, param(c, 'dotId'), param(c, 'table'), input.rowids);
        }),
    );

    // Embedded dataset views: a page block's query, for whoever is
    // looking at the page, through their own access (views.ts).
    const views = new DatasetViews(space, platform.workspace.pages, {
        readsSpace: (viewer, spaceId) => platform.workspace.readsSpace(viewer, spaceId),
    });
    app.post(
        '/data/views/query',
        userOnly,
        handle(async (c) => views.query(c.get('user').id, await body(c, viewQueryBody))),
    );
    // Query specs (CB-451): checked for the person asking, against a
    // table they may read, every problem at once; nothing runs.
    app.post(
        '/data/specs/validate',
        userOnly,
        bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Send a smaller spec.' }, 413) }),
        handle(async (c) => validateSpec(space, c.get('user').id, await body(c, specValidateBody))),
    );
    // Running them: compiled to one SQLite statement and run as the person
    // asking, through the data space's read-only query; a spec with problems
    // answers 400 with every one of them.
    const specs = new SpecRunner(space);
    app.post(
        '/data/specs/run',
        userOnly,
        bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'Send a smaller spec.' }, 413) }),
        handle(async (c) => {
            const answer = await specs.run(c.get('user').id, await body(c, specRunBody));
            return 'ok' in answer ? c.json({ error: 'This spec has problems.', ...answer }, 400) : answer;
        }),
    );
    app.get(
        '/data/datasets',
        handle(
            (c) => {
                const actor = actorOf(c);
                return actor.kind === 'user' ? space.datasetsFor(actor.userId) : space.list(actor);
            },
            { op: 'read' },
        ),
    );
    // The person's datasets in no Space: the sidebar's "Private" group
    // (CB-451), in the Space items' shape. Theirs alone, so its
    // version is theirs (`private-data:<userId>`) and the socios' names.
    app.get(
        '/data/private-items',
        userOnly,
        handle((c) => {
            const userId = c.get('user').id;
            return conditionalJson(
                c,
                () => space.privateItems(userId),
                () => platform.counters.read([`private-data:${userId}`, 'dots']),
            );
        }),
    );
    app.post(
        '/data/datasets',
        userOrApi('data:admin'),
        handle(
            async (c) => {
                const { sharedSpaceId, spaceParentId, ...input } = await body(c, datasetBody);
                // An admin's data API token: a company dataset (owner `ws:workspace`).
                if (c.get('dataToken')) {
                    return c.json(
                        space.createCompanyDataset(actorOf(c) as AgentActor, {
                            ...input,
                            sharedSpaceId,
                            spaceParentId,
                        }),
                        201,
                    );
                }
                if (sharedSpaceId) {
                    return c.json(
                        space.createInSpace(c.get('user').id, { ...input, sharedSpaceId, spaceParentId }),
                        201,
                    );
                }
                if (spaceParentId) {
                    throw new DataError('Put the dataset in a Space first.');
                }
                return c.json(space.createDataset(c.get('user').id, input), 201);
            },
            { apiScope: 'data:admin' },
        ),
    );
    app.get(
        '/data/datasets/:id',
        handle(
            (c) => {
                const actor = actorOf(c);
                return actor.kind === 'user'
                    ? space.detailFor(actor.userId, param(c, 'id'))
                    : space.describe(actor, param(c, 'id'));
            },
            { op: 'read', dataset: datasetParam },
        ),
    );
    app.patch(
        '/data/datasets/:id',
        userOrApi('data:admin'),
        handle(
            async (c) =>
                c.get('dataToken')
                    ? space.updateCompanyDataset(actorOf(c) as AgentActor, param(c, 'id'), await body(c, datasetPatch))
                    : space.updateDataset(c.get('user').id, param(c, 'id'), await body(c, datasetPatch)),
            { apiScope: 'data:admin' },
        ),
    );
    app.delete(
        '/data/datasets/:id',
        userOnly,
        handle((c) => {
            space.deleteDataset(c.get('user').id, param(c, 'id'));
            return { ok: true };
        }),
    );
    app.post(
        '/data/datasets/:id/query',
        handle(
            async (c) => {
                const input = await body(c, queryBody);
                return space.query(actorOf(c), param(c, 'id'), input.sql, input.params ?? [], input.maxRows);
            },
            { op: 'query', dataset: datasetParam },
        ),
    );
    // Several SELECTs read from one snapshot, one operation (CB-474): the
    // read tier, as a query is.
    app.post(
        '/data/datasets/:id/read-batch',
        handle(
            async (c) => {
                const input = await body(c, readBatchBody);
                return space.readBatch(actorOf(c), param(c, 'id'), input.statements, input.maxRows);
            },
            { op: 'query', dataset: datasetParam },
        ),
    );
    // A plugin's data operation budget (CB-473): an admin's override over
    // the workspace's plugin default, or null to clear it.
    app.get(
        '/data/plugins/:pluginId/budget',
        userOnly,
        handle((c) => space.pluginBudget(c.get('user').id, param(c, 'pluginId'))),
    );
    app.put(
        '/data/plugins/:pluginId/budget',
        userOnly,
        handle(async (c) => {
            const { statementsPerMinute } = await body(c, budgetBody);
            return space.setPluginBudget(c.get('user').id, param(c, 'pluginId'), statementsPerMinute);
        }),
    );
    app.get(
        '/data/datasets/:id/tables/:table/rows',
        userOnly,
        handle((c) => {
            const offset = Math.max(0, Math.floor(Number(c.req.query('offset') ?? 0)) || 0);
            const limit = Math.min(200, Math.max(1, Math.floor(Number(c.req.query('limit') ?? 50)) || 50));
            return space.rowsFor(c.get('user').id, param(c, 'id'), param(c, 'table'), offset, limit);
        }),
    );
    // A table's rows changed since a sync token (CB-451): Socio
    // Mobile's offline caches. `cursor`: the last answer's `next`. Its tag
    // is the answer's own hash, so an unchanged table answers `304`.
    app.get(
        '/data/datasets/:id/tables/:table/changes',
        userOnly,
        handle((c) => {
            const since = c.req.query('since');
            if (!since) {
                throw new DataError('Send since: the sync token a read answered (<generation>.<value>).');
            }
            const cursor = c.req.query('cursor');
            const schema = answerSchema(c.req.query('schema'));
            return conditionalJson(c, () => ({
                schema,
                ...space.changesFor(c.get('user').id, param(c, 'id'), param(c, 'table'), since, cursor || undefined),
            }));
        }),
    );
    // Field settings (CB-451): every field of a table with
    // its kind and settings, for whoever may read the dataset (the Fields
    // panel on its item in its Space, and the phone's Fields sheet); a
    // save, by people who may write it, checked against the column's type
    // and the version it started from.
    app.get(
        '/data/datasets/:id/tables/:table/fields',
        // Reading field settings: data:read, or data:admin, which saves them.
        userOrApi(['data:read', 'data:admin']),
        handle(
            (c) => {
                const schema = answerSchema(c.req.query('schema'));
                const token = c.get('dataToken');
                return conditionalJson(c, () => ({
                    ...(token
                        ? space.fieldSettingsForToken(actorOf(c) as AgentActor, param(c, 'id'), param(c, 'table'))
                        : space.fieldSettingsFor(c.get('user').id, param(c, 'id'), param(c, 'table'))),
                    schema,
                }));
            },
            { apiScope: ['data:read', 'data:admin'] },
        ),
    );
    app.put(
        '/data/datasets/:id/tables/:table/fields/:field',
        userOrApi('data:admin'),
        bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ error: 'Send smaller field settings.' }, 413) }),
        handle(
            async (c) => {
                const body = (await c.req.json().catch(() => null)) as unknown;
                const token = c.get('dataToken');
                const outcome = space.saveFieldSetting(
                    token?.apiToken?.createdBy ?? c.get('user').id,
                    param(c, 'id'),
                    param(c, 'table'),
                    param(c, 'field'),
                    body,
                    token ? (actorOf(c) as AgentActor) : undefined,
                );
                const schema = (body as { schema?: unknown } | null)?.schema;
                return outcome.ok
                    ? c.json({ ...outcome.saved, schema: answerSchema(schema) })
                    : c.json(outcome.refusal, outcome.status);
            },
            { apiScope: 'data:admin' },
        ),
    );
    app.get(
        '/data/datasets/:id/export.csv',
        userOnly,
        handle((c) => {
            const table = c.req.query('table') ?? '';
            const { name, csv } = space.csvFor(c.get('user').id, param(c, 'id'), table);
            return new Response(csv, {
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': attachment(`${name}-${table}`, 'csv'),
                    'Cache-Control': 'no-store',
                },
            });
        }),
    );
    app.get(
        '/data/datasets/:id/export.sqlite',
        userOnly,
        handle((c) => {
            const { name, bytes } = space.sqliteFor(c.get('user').id, param(c, 'id'));
            return new Response(new Uint8Array(bytes), {
                headers: {
                    'Content-Type': 'application/vnd.sqlite3',
                    'Content-Disposition': attachment(name, 'sqlite'),
                    'Cache-Control': 'no-store',
                },
            });
        }),
    );
    // Schema and row changes come from Dots: tools in a turn, or a token.
    app.post(
        '/data/datasets/:id/tables',
        tokenOnly,
        handle(
            async (c) => {
                const input = await body(
                    c,
                    z
                        .object({
                            table: z.string(),
                            columns: z.array(z.any()).min(1),
                            ifNotExists: z.boolean().optional(),
                            history: z.boolean().optional(),
                            // CB-369: an analytical table, partitioned by a date column.
                            kind: z.enum(['transactional', 'analytical']).optional(),
                            partitionBy: z.unknown().optional(),
                            // CB-387: days its partitions are kept.
                            retainDays: z.unknown().optional(),
                        })
                        .strict(),
                );
                const { kind, partitionBy, retainDays, ...rest } = input;
                if (kind !== 'analytical' && (partitionBy !== undefined || retainDays !== undefined)) {
                    throw new DataError('partitionBy and retainDays are for analytical tables (kind: "analytical").');
                }
                if (kind === 'analytical' && input.history !== undefined) {
                    throw new DataError('Analytical tables keep no row history: leave out history.');
                }
                const actor = actorOf(c) as Exclude<DataActor, { kind: 'user' }>;
                return space.write(actor, param(c, 'id'), {
                    op: 'create_table',
                    input:
                        kind === 'analytical'
                            ? ({
                                  ...rest,
                                  kind,
                                  partitionBy,
                                  ...(retainDays === undefined ? {} : { retainDays }),
                              } as typeof rest)
                            : rest,
                });
            },
            { op: 'createTable', dataset: datasetParam },
        ),
    );
    app.post(
        '/data/datasets/:id/tables/:table/columns',
        tokenOnly,
        handle(
            async (c) => {
                const { column } = await body(c, z.object({ column: z.any() }).strict());
                const actor = actorOf(c) as Exclude<DataActor, { kind: 'user' }>;
                return space.write(actor, param(c, 'id'), {
                    op: 'add_column',
                    table: param(c, 'table'),
                    column,
                });
            },
            { op: 'addColumn', dataset: datasetParam },
        ),
    );
    // A table's row history on or off (CB-369 Phase H): the dataset's owner
    // (an admin, for a plugin's) in the app, or a plugin on its own dataset.
    app.patch(
        '/data/datasets/:id/tables/:table',
        handle(
            async (c) => {
                const { history } = await body(c, z.object({ history: z.boolean() }).strict());
                return space.setTableHistory(actorOf(c), param(c, 'id'), param(c, 'table'), history);
            },
            { op: 'tableHistory', dataset: datasetParam },
        ),
    );
    // An analytical table's retention (CB-387): an admin's override (days, or
    // null to keep everything) that wins over the plugin's manifest until
    // it is cleared, and a preview of what a retention would drop now.
    app.put(
        '/data/datasets/:id/tables/:table/retention',
        userOnly,
        handle(async (c) => {
            const { days } = await body(c, z.object({ days: z.number().nullable() }).strict());
            return space.setTableRetention(c.get('user').id, param(c, 'id'), param(c, 'table'), { days });
        }),
    );
    app.delete(
        '/data/datasets/:id/tables/:table/retention',
        userOnly,
        handle((c) => space.setTableRetention(c.get('user').id, param(c, 'id'), param(c, 'table'), { clear: true })),
    );
    app.get(
        '/data/datasets/:id/tables/:table/retention/preview',
        userOnly,
        handle((c) => {
            const raw = c.req.query('days');
            return space.previewTableRetention(
                c.get('user').id,
                param(c, 'id'),
                param(c, 'table'),
                raw && /^\d+$/.test(raw) ? Number(raw) : raw,
            );
        }),
    );
    // Compact file (CB-369 Phase H): VACUUM at the next nightly run, or not.
    app.post(
        '/data/datasets/:id/compact',
        userOnly,
        handle(async (c) => {
            const input = await body(c, z.object({ cancel: z.boolean().optional() }).strict());
            return space.requestCompact(c.get('user').id, param(c, 'id'), input.cancel);
        }),
    );
    // Declared secondary indexes (CB-355): a socio's or app's token, or the
    // dataset's owner in the app. Never SQL: a name, columns and `unique`.
    const indexBody = z
        .object({
            name: z.string().min(1).max(63),
            columns: z.array(z.string().min(1).max(63)).min(1).max(8),
            unique: z.boolean().optional(),
            ifNotExists: z.boolean().optional(),
        })
        .strict();
    const indexWrite = (
        c: Context<AppEnv>,
        write:
            | { op: 'create_index'; table: string; index: z.infer<typeof indexBody> }
            | {
                  op: 'drop_index';
                  table: string;
                  name: string;
              }
            | { op: 'analyze'; table?: string },
    ) => {
        const actor = actorOf(c);
        return actor.kind === 'user'
            ? space.ownerIndexWrite(actor.userId, param(c, 'id'), write)
            : space.write(actor, param(c, 'id'), write);
    };
    app.post(
        '/data/datasets/:id/tables/:table/indexes',
        handle(
            async (c) =>
                indexWrite(c, { op: 'create_index', table: param(c, 'table'), index: await body(c, indexBody) }),
            { op: 'createIndex', dataset: datasetParam },
        ),
    );
    app.delete(
        '/data/datasets/:id/tables/:table/indexes/:name',
        handle((c) => indexWrite(c, { op: 'drop_index', table: param(c, 'table'), name: param(c, 'name') }), {
            op: 'dropIndex',
            dataset: datasetParam,
        }),
    );
    // SQLite ANALYZE (CB-355): fresh planner statistics for every table, or
    // one. A declared operation, never SQL; it counts toward the per-minute
    // budget like any write.
    app.post(
        '/data/datasets/:id/analyze',
        handle((c) => indexWrite(c, { op: 'analyze' }), { op: 'analyze', dataset: datasetParam }),
    );
    app.post(
        '/data/datasets/:id/tables/:table/analyze',
        handle((c) => indexWrite(c, { op: 'analyze', table: param(c, 'table') }), {
            op: 'analyze',
            dataset: datasetParam,
        }),
    );
    app.post(
        '/data/datasets/:id/tables/:table/rows',
        tokenOnly,
        handle(
            async (c) => {
                const { rows, key } = await body(
                    c,
                    z
                        .object({
                            rows: z.array(z.record(z.string(), z.unknown())).min(1),
                            key: z.array(z.string()).min(1).max(8).optional(),
                        })
                        .strict(),
                );
                const actor = actorOf(c) as Exclude<DataActor, { kind: 'user' }>;
                return space.write(
                    actor,
                    param(c, 'id'),
                    key
                        ? { op: 'upsert', table: param(c, 'table'), rows, key }
                        : { op: 'insert', table: param(c, 'table'), rows },
                );
            },
            {
                // Hono keeps the parsed body for the handler.
                op: async (c) => {
                    const input: unknown = await c.req.json().catch(() => null);
                    return input && typeof input === 'object' && (input as { key?: unknown }).key !== undefined
                        ? 'upsert'
                        : 'insert';
                },
                dataset: datasetParam,
            },
        ),
    );
    // Analytical tables (CB-369 Phase 1): a bulk append of NDJSON or
    // `{ "rows": [...] }`, streamed to disk under `appendMaxBytes`, never held
    // whole here; `x-cb-append-id` makes a retry add nothing.
    app.post(
        '/data/datasets/:id/tables/:table/append',
        tokenOnly,
        handle(
            async (c) => {
                const actor = actorOf(c) as AgentActor;
                const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
                const format =
                    type === 'application/x-ndjson' || type === 'application/jsonl'
                        ? 'ndjson'
                        : type === 'application/json'
                          ? 'json'
                          : undefined;
                if (!format) {
                    throw new DataError(
                        'Send application/x-ndjson (a row per line) or application/json ({ "rows": [...] }).',
                    );
                }
                const file = space.appendBodyPath(actor, param(c, 'id'));
                try {
                    await saveBody(c.req.raw.body, file, space.limits.appendMaxBytes);
                    return await space.append(
                        actor,
                        param(c, 'id'),
                        param(c, 'table'),
                        { kind: 'body', file, format },
                        c.req.header(APPEND_ID_HEADER)?.trim() || null,
                    );
                } finally {
                    // Whatever happened, the body never outlives its request.
                    rmSync(file, { force: true });
                }
            },
            { op: 'append', dataset: datasetParam },
        ),
    );
    // Copies a transactional table of the same dataset into an analytical one,
    // read in chunks by the analytics process; the source stays.
    app.post(
        '/data/datasets/:id/tables/:table/append-from',
        tokenOnly,
        handle(
            async (c) => {
                const bound = z.union([z.string().max(100), z.number()]);
                const input = await body(
                    c,
                    z
                        .object({
                            from: z.string().min(1).max(63),
                            where: z
                                .object({
                                    column: z.string().min(1).max(63),
                                    from: bound.optional(),
                                    to: bound.optional(),
                                })
                                .strict()
                                .optional(),
                        })
                        .strict(),
                );
                const where = input.where;
                return space.append(
                    actorOf(c) as AgentActor,
                    param(c, 'id'),
                    param(c, 'table'),
                    { kind: 'sqlite', table: input.from, ...(where ? { where } : {}) },
                    c.req.header(APPEND_ID_HEADER)?.trim() ||
                        // ASCII and bounded whatever the bounds hold.
                        `from:${createHash('sha256')
                            .update(
                                JSON.stringify([
                                    input.from,
                                    where?.column ?? null,
                                    where?.from ?? null,
                                    where?.to ?? null,
                                ]),
                            )
                            .digest('hex')}`,
                );
            },
            { op: 'appendFrom', dataset: datasetParam },
        ),
    );
    // DuckDB SQL over both kinds of table: a plugin's own token, or an
    // admin on the Data page. `POST …/query` stays SQLite and transactional.
    app.post(
        '/data/datasets/:id/analytics/query',
        handle(
            async (c) => {
                const input = await body(c, queryBody);
                return space.analyticsQuery(actorOf(c), param(c, 'id'), input.sql, input.params ?? [], input.maxRows);
            },
            { op: 'analyticsQuery', dataset: datasetParam },
        ),
    );
    // Several row changes in one transaction, all or nothing (`DataSpace.batch`).
    app.post(
        '/data/datasets/:id/batch',
        tokenOnly,
        handle(
            async (c) => {
                const input = await body(c, batchBody);
                const actor = actorOf(c) as Exclude<DataActor, { kind: 'user' }>;
                return space.batch(actor, param(c, 'id'), input.statements);
            },
            { op: 'batch', dataset: datasetParam },
        ),
    );
    app.use('/data/files', datasetsOnly);
    app.use('/data/files/*', datasetsOnly);
    app.get(
        '/data/files',
        handle((c) => space.listFiles(actorOf(c), c.req.query('prefix')), {
            op: 'files.read',
        }),
    );
    app.get(
        '/data/files/raw',
        handle(
            async (c) => {
                const { file, data } = await space.getFile(actorOf(c), c.req.query('path') ?? '');
                return new Response(new Uint8Array(data), {
                    headers: {
                        // Downloads only: never rendered on the app's origin.
                        'Content-Type': 'application/octet-stream',
                        'Content-Disposition': attachment(
                            file.path
                                .split('/')
                                .pop()!
                                .replace(/\.[^.]*$/, ''),
                            file.path.split('.').pop() ?? 'bin',
                        ),
                        'X-Media-Type': file.mediaType.replace(/[^\x20-\x7e]/g, ''),
                        'Cache-Control': 'no-store',
                    },
                });
            },
            { op: 'files.read' },
        ),
    );
    app.put(
        '/data/files',
        // Read per request: an admin may change the limit in Settings.
        (c, next) =>
            bodyLimit({
                maxSize: Math.ceil(space.limits.fileMaxBytes / 3) * 4 + 64 * 1024,
                onError: (c) => c.json({ error: 'The file is too large.' }, 413),
            })(c, next),
        handle(
            async (c) => {
                const input = await body(c, fileBody);
                return space.putFile(
                    actorOf(c),
                    input.path,
                    Buffer.from(input.content, input.encoding),
                    input.mediaType ?? 'application/octet-stream',
                );
            },
            { op: 'files.write' },
        ),
    );
    app.delete(
        '/data/files',
        handle(
            async (c) => {
                const actor = actorOf(c);
                const path = c.req.query('path') ?? '';
                if (actor.kind === 'token') {
                    await space.deleteFileAs(actor, path);
                } else {
                    await space.deleteFile(actor.userId, path);
                }
                return { ok: true };
            },
            // The approval is for this exact path: the value deleted.
            { op: 'files.delete', params: (c) => ({ path: c.req.query('path') }) },
        ),
    );
    app.get(
        '/data/grants',
        userOnly,
        handle((c) => space.grants(c.get('user').id)),
    );
    app.put(
        '/data/grants',
        userOnly,
        handle(async (c) => space.setGrant(c.get('user').id, await body(c, grantBody))),
    );
    app.delete(
        '/data/grants/:id',
        userOnly,
        handle(async (c) => {
            await space.revokeGrant(c.get('user').id, param(c, 'id'));
            return { ok: true };
        }),
    );
    app.get(
        '/data/audit',
        userOnly,
        handle((c) =>
            space.auditFor(c.get('user').id, {
                datasetId: c.req.query('dataset') || undefined,
                limit: Number(c.req.query('limit') ?? 200) || 200,
            }),
        ),
    );
    // Admins' data API tokens: listed, made (the value shown once) and
    // revoked in Settings, with a session only.
    const tokensPath = DATA_API_TOKENS_PATH.replace(/^\/api/, '');
    app.get(
        tokensPath,
        userOnly,
        handle((c) => space.apiTokens.list(c.get('user').id)),
    );
    app.post(
        tokensPath,
        userOnly,
        handle(async (c) =>
            c.json(space.apiTokens.create(c.get('user').id, await body(c, dataApiTokenCreateBody)), 201),
        ),
    );
    app.delete(
        `${tokensPath}/:tokenId`,
        userOnly,
        handle((c) => space.apiTokens.revoke(c.get('user').id, param(c, 'tokenId'))),
    );
    // A job that runs until done keeps its items and checkpoint here (CB-122).
    app.route('/data/job', jobRoutes());
    return app;
}
