// The runtime's contract: what it re-exports from @socio/data is the same
// value (ownership moved there), the classes implement the shapes, and the
// tags carry their `socio/runtime/<Name>` keys.
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import * as ownership from '@socio/data/runtime-ownership';

import {
    DRAINING_MESSAGE,
    DRAINING_RETRY_AFTER_S,
    Lifecycle,
    OwnershipError,
    RuntimeConfig,
    RuntimeIdentity,
    WorkControl,
    type RuntimeIdentityShape,
    type RuntimeOwnershipShape,
} from '../src/server/runtime/contract.js';
import * as shutdown from '../src/server/runtime/shutdown.js';

import { testDatabase } from './helpers/test-database.js';

it('re-exports the ownership error, unchanged, and drains with its constants', async () => {
    expect(ownership.OwnershipError).toBe(OwnershipError);
    const error = new OwnershipError();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: Work is already owned by a live runtime.');
    const response = shutdown.drainingResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe(String(DRAINING_RETRY_AFTER_S));
    expect(await response.json()).toMatchObject({ error: DRAINING_MESSAGE });
});

it('the tags carry their keys', () => {
    expect([RuntimeIdentity.key, Lifecycle.key, WorkControl.key, RuntimeConfig.key]).toEqual([
        'socio/runtime/RuntimeIdentity',
        'socio/runtime/Lifecycle',
        'socio/runtime/WorkControl',
        'socio/runtime/RuntimeConfig',
    ]);
});

it('a RuntimeSession serves the RuntimeIdentity tag', async () => {
    const session: RuntimeIdentityShape = new ownership.RuntimeSession({ heartbeat: false });
    const db = testDatabase();
    const attached: RuntimeOwnershipShape = await Effect.runPromise(
        RuntimeIdentity.use((identity) => Effect.sync(() => identity.attach(db))).pipe(
            Effect.provide(Layer.succeed(RuntimeIdentity, session)),
        ),
    );
    expect(attached).toBe(session.attach(db));
    expect(attached.session.id).toBe(session.id);
    await session.detach(db);
    db.close();
});

it('Lifecycle reads the drain when it runs', async () => {
    let draining = false;
    const layer = Layer.succeed(
        Lifecycle,
        Lifecycle.of({
            draining: Effect.sync(() => draining),
            drain: Effect.sync(() => {
                draining = true;
            }),
        }),
    );
    const read = Effect.runPromise(Lifecycle.use((l) => l.draining).pipe(Effect.provide(layer)));
    expect(await read).toBe(false);
    await Effect.runPromise(Lifecycle.use((l) => l.drain).pipe(Effect.provide(layer)));
    expect(await Effect.runPromise(Lifecycle.use((l) => l.draining).pipe(Effect.provide(layer)))).toBe(true);
});
