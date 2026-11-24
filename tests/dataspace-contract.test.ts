// The data space's contract: `DataError` keeps its name, text and JSON, the
// classes implement the shapes, and the tags carry their keys. The old paths'
// re-exports are gone.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { DataError } from '@socio/foundation/dataspace/data-error';
import { normalizePath } from '@socio/foundation/dataspace/paths';

import { sqliteApprovals } from '../src/server/approvals/services.js';
import { Data, DataConfig, type DataSpaceShape } from '../src/server/dataspace/contract.js';
import { DataSpace } from '../src/server/dataspace/space.js';
import { DataTokens } from '../src/server/dataspace/tokens.js';

import { dataSpaceStorage } from './helpers/data-space-storage.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

it('DataError is still a plain Error with a status', () => {
    const error = new DataError('No such dataset.', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('Error');
    expect(String(error)).toBe('Error: No such dataset.');
    expect(JSON.stringify(error)).toBe('{"status":404}');
    expect(new DataError('Bad.').status).toBe(400);
    expect(() => normalizePath('../x')).toThrow(DataError);
});

it('the tags carry their keys', () => {
    expect([Data.key, DataConfig.key]).toEqual(['socio/dataspace/Data', 'socio/dataspace/DataConfig']);
});

it('a DataSpace serves the Data tag', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    const dir = mkdtempSync(join(tmpdir(), 'cb-dataspace-contract-'));
    const space = new DataSpace(workspace.db, {
        dir,
        ...dataSpaceStorage(dir),
        secret: 'secret-0123456789abcdef-xyz',
        approvals: sqliteApprovals(workspace.db),
        workspace,
    });
    try {
        const shape: DataSpaceShape = space;
        const tokens = shape.tokens;
        expect(tokens).toBeInstanceOf(DataTokens);
        const usage = await Effect.runPromise(
            Data.use((data) => Effect.sync(() => data.usageAll())).pipe(Effect.provide(Layer.succeed(Data, shape))),
        );
        expect(usage).toEqual([]);
    } finally {
        space.close();
        workspace.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
