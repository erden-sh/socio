// Skills' `UnfurlTools` tag: the tag web will reach `/unfurl`'s tool builders
// through, and its bridge serving today's builders unchanged over the page
// tools it was built with.
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { UnfurlTools, type UnfurlToolOptions } from '../src/server/skills/contract.js';
import { unfurlToolsOver } from '../src/server/skills/services.js';
import { unfurlRecursiveTools, type UnfurlApprovals } from '../src/server/skills/unfurl-recursive.js';
import { unfurlTools, type UnfurlPages } from '../src/server/skills/unfurl-tool.js';

it('declares its tag under socio/skills', () => {
    expect(UnfurlTools.key).toBe('socio/skills/UnfurlTools');
});

it('serves the same tools as the builders, through a layer', async () => {
    let checks = 0;
    const options = {
        reads: {} as UnfurlToolOptions['reads'],
        media: {} as UnfurlToolOptions['media'],
        turn: {
            check: () => {
                checks += 1;
            },
        } as unknown as UnfurlToolOptions['turn'],
    } satisfies UnfurlToolOptions;
    const pages = {} as UnfurlPages;
    const approvals = {} as UnfurlApprovals;
    const direct = [...unfurlTools({ ...options, pages }), ...unfurlRecursiveTools({ ...options, pages, approvals })];

    const served = await Effect.runPromise(
        Effect.gen(function* () {
            const tools = yield* UnfurlTools;
            return [...tools.unfurlTools(options), ...tools.unfurlRecursiveTools(options)];
        }).pipe(Effect.provide(Layer.succeed(UnfurlTools, unfurlToolsOver(pages, approvals)))),
    );

    expect(served.map((tool) => tool.name)).toEqual(direct.map((tool) => tool.name));
    expect(served.map((tool) => tool.name)).toEqual(['unfurl_link', 'unfurl_recursive']);

    // The turn's options reach the builder: a bad link is refused after the turn's check.
    const link = served[0];
    const result = await link.execute!((link.parameters as z.ZodType).parse({ url: 'ftp://files.example/a' }) as never);
    expect(result).toEqual({ error: 'Give a public http(s) link.' });
    expect(checks).toBe(1);
});
