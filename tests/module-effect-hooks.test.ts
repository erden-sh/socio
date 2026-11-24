import { Context, Data, Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, afterEach, expect, it } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import type { ModuleContext, ServerModule } from '../src/server/modules/contract.js';
import {
    moduleEffectRunner,
    moduleNews,
    modulePageContext,
    moduleTurnNote,
    releaseModules,
    runTick,
    settleHook,
    startModules,
    stopModules,
    succeedModules,
} from '../src/server/modules/lifecycle.js';

/** A service of "the app" the Effect hooks need. */
class Journal extends Context.Service<Journal, { readonly write: (line: string) => void }>()('socio/test/Journal') {}
class HookFailed extends Data.TaggedError('HookFailed')<{ readonly message: string }> {}

const lines: string[] = [];
const runtime = ManagedRuntime.make(Layer.succeed(Journal, Journal.of({ write: (line) => lines.push(line) })));
const run = moduleEffectRunner(() => runtime);
const ctx = {} as ModuleContext;
const turn = {} as DotTurn;

afterEach(() => {
    lines.length = 0;
});
afterAll(() => runtime.dispose());

const write = (line: string) =>
    Effect.gen(function* () {
        const journal = yield* Journal;
        journal.write(line);
    });
const later = (line: string) =>
    new Promise<void>((resolve) =>
        setTimeout(() => {
            lines.push(line);
            resolve();
        }, 5),
    );

/** One module of each kind: a sync hook, a promise hook, an Effect hook. */
const modules: readonly ServerModule<Journal>[] = [
    {
        id: 'plain',
        start: () => void lines.push('plain start'),
        succeed: () => void lines.push('plain succeed'),
        release: () => void lines.push('plain release'),
        stop: () => void lines.push('plain stop'),
        dotNews: () => 'a',
        dotTurnNote: () => '1',
    },
    {
        id: 'promised',
        start: () => later('promised start'),
        succeed: () => later('promised succeed'),
        release: () => later('promised release'),
        stop: () => later('promised stop'),
        dotNews: async () => 'b',
        dotTurnNote: async () => '2',
        dotPageContext: async () => undefined,
    },
    {
        id: 'effect',
        // Sleeps first, so a runner that didn't wait would let the next one in.
        start: () => Effect.sleep('5 millis').pipe(Effect.andThen(write('effect start'))),
        succeed: () => write('effect succeed'),
        release: () => Effect.sleep('5 millis').pipe(Effect.andThen(write('effect release'))),
        stop: () => write('effect stop'),
        dotNews: () => Effect.succeed('c'),
        dotTurnNote: () => Effect.succeed('3'),
        dotPageContext: () => Effect.succeed({ page: 'effect' }),
    },
    {
        id: 'last',
        start: () => write('last start'),
        dotNews: () => Effect.succeed('d'),
        dotPageContext: () => ({ page: 'last' }),
    },
];

it('runs Effect hooks with the runtime, each to its end, in registry order', async () => {
    await startModules(modules, ctx, run);
    await succeedModules(modules, ctx, run);
    expect(lines).toEqual([
        'plain start',
        'promised start',
        'effect start',
        'last start',
        'plain succeed',
        'promised succeed',
        'effect succeed',
    ]);
});

it('releases and stops in reverse registry order', async () => {
    await releaseModules(modules, ctx, run);
    await stopModules(modules, ctx, run);
    expect(lines).toEqual([
        'effect release',
        'promised release',
        'plain release',
        'effect stop',
        'promised stop',
        'plain stop',
    ]);
});

it('joins the prompt hooks in registry order; the first page wins', async () => {
    expect(await moduleNews(modules, ctx, turn, run)).toBe('abcd');
    expect(await moduleTurnNote(modules, ctx, turn, run)).toBe('123');
    expect(await modulePageContext(modules, ctx, turn, run)).toEqual({ page: 'effect' });
});

it('rethrows an Effect hook failure itself, and stops the start there', async () => {
    const failure = new HookFailed({ message: 'no start' });
    const failing: readonly ServerModule<Journal>[] = [
        { id: 'one', start: () => write('one start') },
        { id: 'two', start: () => Effect.fail(failure) },
        { id: 'three', start: () => write('three start') },
    ];
    const error = await startModules(failing, ctx, run).catch((error: unknown) => error);
    expect(error).toBe(failure);
    expect(lines).toEqual(['one start']);
});

it('rethrows a defect itself, as a thrown error would be', async () => {
    const defect = new Error('boom');
    const error = await succeedModules([{ id: 'one', succeed: () => Effect.die(defect) }], ctx, run).catch(
        (error: unknown) => error,
    );
    expect(error).toBe(defect);
});

it('stops every module even when an Effect stop fails, then rethrows the first failure', async () => {
    const first = new HookFailed({ message: 'first' });
    const stopping: readonly ServerModule<Journal>[] = [
        { id: 'one', stop: () => write('one stop') },
        {
            id: 'two',
            stop: () => {
                throw new Error('second');
            },
        },
        { id: 'three', stop: () => Effect.fail(first) },
        { id: 'four', stop: () => write('four stop') },
    ];
    const error = await stopModules(stopping, ctx, run).catch((error: unknown) => error);
    expect(error).toBe(first);
    expect(lines).toEqual(['four stop', 'one stop']);
});

it('releases every module even when an Effect release fails', async () => {
    const failure = new HookFailed({ message: 'release' });
    const releasing: readonly ServerModule<Journal>[] = [
        { id: 'one', release: () => write('one release') },
        { id: 'two', release: () => Effect.fail(failure) },
    ];
    await expect(releaseModules(releasing, ctx, run)).rejects.toBe(failure);
    expect(lines).toEqual(['one release']);
});

it('turns an Effect tick into a promise and leaves other runs as they are', async () => {
    const effectRun = runTick({ everyMs: 1000, run: () => write('tick') }, ctx, run);
    expect(effectRun).toBeInstanceOf(Promise);
    await effectRun;
    expect(lines).toEqual(['tick']);

    expect(runTick({ everyMs: 1000, run: () => 7 }, ctx, run)).toBe(7);
    const promised = Promise.resolve();
    expect(runTick({ everyMs: 1000, run: () => promised }, ctx, run)).toBe(promised);

    const failure = new HookFailed({ message: 'tick' });
    await expect(runTick({ everyMs: 1000, run: () => Effect.fail(failure) }, ctx, run)).rejects.toBe(failure);
});

it('leaves values and promises untouched and runs nothing for them', () => {
    let ran = 0;
    const counting = () => {
        ran += 1;
        return Promise.resolve(undefined as never);
    };
    const promise = Promise.resolve('x');
    expect(settleHook('x', counting)).toBe('x');
    expect(settleHook(promise, counting)).toBe(promise);
    expect(settleHook(undefined, counting)).toBeUndefined();
    expect(ran).toBe(0);
});

it('reads the runtime only when an Effect hook runs', async () => {
    let reads = 0;
    const lazy = moduleEffectRunner(() => {
        reads += 1;
        return runtime;
    });
    await startModules([{ id: 'plain', start: () => undefined }], ctx, lazy);
    expect(reads).toBe(0);
    await startModules([{ id: 'effect', start: () => write('effect') }], ctx, lazy);
    expect(reads).toBe(1);
});
