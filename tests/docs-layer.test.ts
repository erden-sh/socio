// The docs catalog's layers offer the very catalog the boot step compiles,
// behind the `Docs` tag.
import { Effect } from 'effect';
import { expect, it } from 'vitest';

import { buildDocsCatalog, getDocsCatalog } from '../src/server/docs/catalog.js';
import { Docs } from '../src/server/docs/contract.js';
import { DocsCatalogLive, DocsLive } from '../src/server/docs/layer.js';

const read = Effect.gen(function* () {
    return yield* Docs;
});

const guide = {
    audience: 'user' as const,
    name: 'index.md',
    markdown: '---\ntitle: User guide\ndescription: How to use Socio\n---\n\nTalk to a socio.',
};

it('offers a compiled catalog as it is', async () => {
    const catalog = await buildDocsCatalog([guide]);
    const docs = await Effect.runPromise(read.pipe(Effect.provide(DocsLive(catalog))));
    expect(docs).toBe(catalog);
    expect(docs.list().map((page) => page.url)).toEqual(['/docs']);
});

it("compiles the process's shared catalog when built", async () => {
    const docs = await Effect.runPromise(read.pipe(Effect.provide(DocsCatalogLive)));
    expect(docs).toBe(await getDocsCatalog());
    expect(docs.list().length).toBeGreaterThan(0);
});
