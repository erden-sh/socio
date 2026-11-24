import { Cause, Effect, Exit, Fiber, Scope, type ManagedRuntime } from 'effect';

import { IssuesBackground, type IssuesLeadership, type LeadStopped } from './contract.js';

/** What leadership needs of a runtime: one that can run `IssuesBackground`'s Effects. */
export type IssuesRuntime = Pick<
    ManagedRuntime.ManagedRuntime<IssuesBackground, unknown>,
    'runFork' | 'runPromiseExit'
>;

const run = async <A, E>(runtime: IssuesRuntime, effect: Effect.Effect<A, E, IssuesBackground>) => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isFailure(exit)) {
        throw Cause.squash(exit.cause);
    }
    return exit.value;
};

type Stopped = { autoTriageStopped: boolean; deliveriesStopped: boolean };

/** One leadership term: its scope and the fiber that runs `lead` in it. */
interface Term {
    stopping: boolean;
    /** What this term's cleanup stopped; it writes here. */
    stopped: LeadStopped;
    /**
     * The scope and fiber, once acquired; undefined if the term was stopped
     * before it acquired them (it waited for the previous term's cleanup).
     */
    acquired: Promise<{ scope: Scope.Closeable; fiber: Fiber.Fiber<void, unknown> } | undefined>;
}

/**
 * The issues module's `start`, `stop` and `tick`.
 * `start` registers its term at once, before its first await, so a `stop`
 * that follows at any moment finds it: the term's scope is made and its
 * `lead` fiber forked synchronously (the runtime builds its layers first, in
 * that fiber), unless a previous term must be cleaned up first. A start that
 * fails or is interrupted closes the scope with its exit, so the cleanup
 * runs for whatever had started, and a failure is rethrown with its original
 * error. `stop` interrupts a start still in flight (a step in progress
 * finishes first), then closes the scope. `runtime` is read at each call:
 * the composition root's runtime exists before it is built.
 */
export function issuesLeadership(runtime: () => IssuesRuntime): IssuesLeadership {
    let current: Term | undefined;
    /** What a failed start's cleanup stopped, for the `stop` that follows. */
    let failed: Stopped | undefined;
    /** That cleanup, while it runs. */
    let settling: Promise<void> | undefined;
    const report = (term: Term): Stopped => ({
        autoTriageStopped: term.stopped.autoTriage,
        deliveriesStopped: term.stopped.deliveries,
    });

    /** Stops a term: no acquisition after this, then interrupt, then the cleanup. */
    const close = async (term: Term) => {
        term.stopping = true;
        const acquired = await term.acquired;
        // Never acquired, or already cleaned up (the runtime was disposed).
        if (!acquired || term.stopped.cleaned) {
            return;
        }
        await run(runtime(), Fiber.interrupt(acquired.fiber));
        await run(runtime(), Scope.close(acquired.scope, Exit.void));
    };

    /** Acquires a term's scope and fiber; synchronous when nothing waits before it. */
    const acquire = (term: Term, previous: Term | undefined): Term['acquired'] => {
        const now = (): Awaited<Term['acquired']> => {
            const scope = Scope.makeUnsafe();
            const fiber = runtime().runFork(
                IssuesBackground.use((background) => Scope.provide(background.lead(term.stopped), scope)),
            );
            return { scope, fiber };
        };
        if (!previous) {
            return Promise.resolve(now());
        }
        // Leads again only after the last term's cleanup.
        return close(previous).then(() => (term.stopping ? undefined : now()));
    };

    return {
        async start() {
            const previous = current;
            const term = { stopping: false, stopped: { autoTriage: false, deliveries: false, cleaned: false } } as Term;
            current = term;
            failed = undefined;
            term.acquired = acquire(term, previous);
            const acquired = await term.acquired;
            if (!acquired) {
                return;
            }
            const exit = await run(runtime(), Fiber.await(acquired.fiber));
            if (Exit.isSuccess(exit)) {
                return;
            }
            // Stopped while starting: `stop` closes the scope and waits for the
            // cleanup; an interrupted start isn't a failure.
            if (term.stopping) {
                if (Cause.hasInterruptsOnly(exit.cause)) {
                    return;
                }
                throw Cause.squash(exit.cause);
            }
            if (current === term) {
                current = undefined;
            }
            const cleanup = (async () => {
                await run(runtime(), Scope.close(acquired.scope, exit));
                failed = report(term);
            })();
            settling = cleanup.catch(() => {});
            await cleanup;
            throw Cause.squash(exit.cause);
        },
        async stop() {
            const term = current;
            current = undefined;
            if (!term) {
                await settling;
                const after = failed ?? { autoTriageStopped: false, deliveriesStopped: false };
                failed = undefined;
                return after;
            }
            await close(term);
            return report(term);
        },
        async tick() {
            const background = await run(
                runtime(),
                IssuesBackground.useSync((service) => service),
            );
            return background.process();
        },
    };
}
