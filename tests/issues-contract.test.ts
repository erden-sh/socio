// The issues contract top-up: the tags `Platform` and the composition root
// will provide, and the plain error and constant that moved into the contract.
// The pure helpers moved to `@socio/foundation/issues/*` and
// `@socio/shared/issues/board-inputs`; their old paths are gone.
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';

import { IssueError, IssuesConfig, Leadership, type IssuesLeadership } from '../src/server/issues/contract.js';
import * as errors from '../src/server/issues/errors.js';

it('keeps IssueError a plain Error with its status', () => {
    const error = new IssueError('Issue not found.', 404);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.message).toBe('Issue not found.');
    expect(String(error)).toBe('Error: Issue not found.');
    expect(new IssueError('Bad.').status).toBe(400);
    expect(errors.issueFailure(error)._tag).toBe('IssueNotFound');
});

it('provides Leadership and IssuesConfig as plain values', async () => {
    const calls: string[] = [];
    const leadership: IssuesLeadership = {
        start: async () => void calls.push('start'),
        stop: async () => (calls.push('stop'), { autoTriageStopped: true, deliveriesStopped: false }),
        tick: async () => void calls.push('tick'),
    };
    const layer = Layer.mergeAll(
        Layer.succeed(Leadership, leadership),
        Layer.succeed(IssuesConfig, { appOrigin: 'https://socio.test', autoTriage: { enabled: true, perDay: 3 } }),
    );
    const read = Effect.gen(function* () {
        const lead = yield* Leadership;
        const config = yield* IssuesConfig;
        yield* Effect.promise(() => lead.start());
        return { stopped: yield* Effect.promise(() => lead.stop()), config };
    });
    const { stopped, config } = await Effect.runPromise(read.pipe(Effect.provide(layer)));
    expect(calls).toEqual(['start', 'stop']);
    expect(stopped).toEqual({ autoTriageStopped: true, deliveriesStopped: false });
    expect(config.appOrigin).toBe('https://socio.test');
    expect(config.dotRequestLimits).toBeUndefined();
});
