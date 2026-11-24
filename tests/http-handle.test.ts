import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect';
import { Hono } from 'hono';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { appHandle, bindAppRuntime, makeHandle } from '../src/server/composition/http/handle.js';
import type { AppRuntime } from '../src/server/main.js';

/** A service of "the app" the handlers need. */
class Items extends Context.Service<Items, { readonly get: (id: string) => { id: string } | undefined }>()(
    'socio/test/Items',
) {}
class ItemNotFound extends Data.TaggedError('ItemNotFound')<{ readonly message: string }> {}
class ItemConflict extends Data.TaggedError('ItemConflict')<{ readonly message: string }> {}

const runtime = ManagedRuntime.make(Layer.succeed(Items, Items.of({ get: (id) => (id === 'a' ? { id } : undefined) })));
afterAll(() => runtime.dispose());

const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => errors.mockClear());
afterAll(() => errors.mockRestore());

const STATUS = { ItemNotFound: 404, ItemConflict: 409 } as const;
const isItemFailure = (error: unknown): error is ItemNotFound | ItemConflict =>
    error instanceof ItemNotFound || error instanceof ItemConflict;

/** A router with today's kind of `onError`, plus the tagged-failure branch (spec 2.4). */
function router(mount: (app: Hono<AppEnv>) => void) {
    const app = new Hono<AppEnv>();
    mount(app);
    app.onError((error, c) => {
        if (isItemFailure(error)) {
            return c.json({ error: error.message }, STATUS[error._tag]);
        }
        console.error('Item request failed:', error.name);
        return c.json({ error: 'The server could not complete this request.' }, 500);
    });
    return app;
}

const handle = makeHandle(() => runtime);

it('passes a 201 JSON response through', async () => {
    const app = router((app) =>
        app.post(
            '/items',
            handle((c) =>
                Effect.gen(function* () {
                    const items = yield* Items;
                    return c.json(items.get('a'), 201);
                }),
            ),
        ),
    );
    const response = await app.request('/items', { method: 'POST' });
    expect(response.status).toBe(201);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ id: 'a' });
});

it('passes a 304 with no body through', async () => {
    const app = router((app) =>
        app.get(
            '/items',
            handle((c) => Effect.succeed(c.body(null, 304, { ETag: '"v1"' }))),
        ),
    );
    const response = await app.request('/items', { headers: { 'If-None-Match': '"v1"' } });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"v1"');
    expect(await response.text()).toBe('');
});

it('re-throws a typed failure to onError, which answers with its status and message', async () => {
    const app = router((app) => {
        app.get(
            '/items/:id',
            handle((c) =>
                Effect.gen(function* () {
                    const item = (yield* Items).get(c.req.param('id') ?? '');
                    if (!item) {
                        return yield* new ItemNotFound({ message: 'No such item.' });
                    }
                    return c.json(item);
                }),
            ),
        );
        app.put(
            '/items/:id',
            handle(() => Effect.fail(new ItemConflict({ message: 'The item changed.' }))),
        );
    });
    const missing = await app.request('/items/b');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No such item.' });
    const conflict = await app.request('/items/a', { method: 'PUT' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'The item changed.' });
    expect(errors).not.toHaveBeenCalled();
});

it('re-throws a defect itself, so onError gives the generic, logged 500', async () => {
    const app = router((app) =>
        app.get(
            '/items',
            handle(() => Effect.die(new TypeError('boom'))),
        ),
    );
    const response = await app.request('/items');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The server could not complete this request.' });
    expect(errors).toHaveBeenCalledWith('Item request failed:', 'TypeError');
});

it('runs the handler in a server span named after the method and route', async () => {
    const app = router((app) =>
        app.get(
            '/items/:id',
            handle((c) =>
                Effect.currentSpan.pipe(
                    Effect.map((span) => c.json({ name: span.name, kind: span.kind })),
                    Effect.orDie,
                ),
            ),
        ),
    );
    const response = await app.request('/items/a');
    expect(await response.json()).toEqual({ name: 'GET /items/:id', kind: 'server' });
});

it('interrupts the fiber when the request signal aborts', async () => {
    let interrupted = false;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const app = router((app) =>
        app.get(
            '/items',
            handle(() =>
                Effect.sync(() => started()).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                        Effect.sync(() => {
                            interrupted = true;
                        }),
                    ),
                ),
            ),
        ),
    );
    const client = new AbortController();
    const answer = app.request(new Request('http://localhost/items', { signal: client.signal }));
    await running;
    client.abort();
    const response = await answer;
    expect(interrupted).toBe(true);
    // The client is gone; whatever onError answers goes nowhere.
    expect(response.status).toBe(500);
});

it('uninterruptible runs the fiber to its end when the request signal aborts, and answers as the handler does', async () => {
    let finished = false;
    let started!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = router((app) =>
        app.get(
            '/items',
            handle.uninterruptible((c) =>
                Effect.sync(() => started()).pipe(
                    Effect.andThen(Effect.promise(() => gate)),
                    Effect.andThen(
                        Effect.sync(() => {
                            finished = true;
                            return c.json({ done: true }, 202);
                        }),
                    ),
                ),
            ),
        ),
    );
    const client = new AbortController();
    const answer = app.request(new Request('http://localhost/items', { signal: client.signal }));
    await running;
    client.abort();
    release();
    const response = await answer;
    expect(finished).toBe(true);
    // The handler's own answer, as a plain async handler gives: no
    // interruption failure, so onError logs nothing.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ done: true });
    expect(errors).not.toHaveBeenCalled();
});

it('uninterruptible still re-throws a typed failure to onError', async () => {
    const app = router((app) =>
        app.get(
            '/items',
            handle.uninterruptible(() => Effect.fail(new ItemConflict({ message: 'Taken.' }))),
        ),
    );
    const response = await app.request('/items');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Taken.' });
});

it('appHandle runs with the runtime mountApp bound to the app (an unbound app answers 500, below)', async () => {
    const app = router((app) => {
        bindAppRuntime(app, runtime as unknown as AppRuntime);
        const handle = appHandle(app);
        app.get(
            '/items/:id',
            handle((c) => Effect.succeed(c.json({ id: c.req.param('id') }))),
        );
    });
    const response = await app.request('/items/a');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'a' });
});

it('appHandle on an app with no runtime still mounts, and its routes fail to onError', async () => {
    const app = router((app) => {
        app.get(
            '/items',
            appHandle(app)((c) => Effect.succeed(c.json({}))),
        );
    });
    const response = await app.request('/items');
    expect(response.status).toBe(500);
    expect(errors).toHaveBeenCalledWith('Item request failed:', 'Error');
});
