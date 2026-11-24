/**
 * The issue tracker's layers: they implement `contract.ts` (`Board`,
 * `IssueBoard`, `IssuesViews`, `IssuesBackground`) and auto-triage from other
 * features' tags. Only the composition root (`main.ts`, `platform.ts`,
 * `composition/`) and tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer, Semaphore } from 'effect';

import { nextTurn } from '@socio/data/events';
import type { UnitOfWork } from '@socio/data/uow';
import type { EndpointSource } from '@socio/foundation/inference/endpoints';
import { autoTriageSettings } from '@socio/foundation/issues/settings';

import { Inference, type InferenceShape } from '../inference/contract.js';
import { Counters } from '../live/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../settings/contract.js';
import { People, PeopleSync, Socios } from '../workspace/contract.js';

import { AutoTriage } from './auto-triage.js';
import {
    AutoTriageControl,
    Board,
    Deliveries,
    IssueBoard,
    IssueNotFound,
    IssuesBackground,
    IssuesConfig,
    IssuesViews,
    TelegramDirect,
    type IssueFailure,
    type IssuesConfigShape,
    type LeadStopped,
    type RecordedNotice,
    IssueError,
} from './contract.js';
import { issueFailure } from './errors.js';
import { noticeMessage } from './requests.js';
import { sqliteBoard, type SqliteBoard } from './services.js';
import { AutoTriageInstance, SqliteBoardService } from './tags.js';
import { issuesViews } from './views.js';

/** The Board, whole: in `tags.ts` so the module can read it. */
export { SqliteBoardService };

/**
 * `sqliteBoard(db, people)`, built once (4.4, step 3), on the connection the
 * boot step opened and migrated; under both tags.
 */
export const BoardLive = (db: DatabaseSync) =>
    Layer.effect(
        Board,
        Effect.gen(function* () {
            return yield* SqliteBoardService;
        }),
    ).pipe(
        Layer.provideMerge(
            Layer.effect(
                SqliteBoardService,
                Effect.gen(function* () {
                    const people = yield* PeopleSync;
                    return sqliteBoard(db, people);
                }),
            ),
        ),
    );

/** Auto-triage, whole: in `tags.ts` so the module can read it. */
export { AutoTriageInstance };

/** Everything auto-triage is made of, from the tags or a platform built on its own. */
export interface AutoTriageParts {
    /** The unit of work on the Board's connection, which the issues and proposals share (CB-110). */
    readonly uow: UnitOfWork;
    readonly board: Pick<SqliteBoard, 'issues' | 'triage' | 'components'>;
    /** The default shared backend's completions, looked up per request. */
    readonly endpoint: EndpointSource;
    readonly settings: Pick<WorkspaceSettingsShape, 'settings'>;
    readonly config: Pick<IssuesConfigShape, 'autoTriage'>;
}

/** Background work runs on the default shared backend, or waits. */
export const sharedEndpoint =
    (inference: Pick<InferenceShape, 'shared'>): EndpointSource =>
    async () =>
        (await inference.shared())?.chatCompletions;

/**
 * Asks the model about new issues (CB-30); started by the issues module.
 * The switch and cap are the ones saved in Settings over the server's
 * (`IssuesConfig`), read on every use.
 */
export function makeAutoTriage(parts: AutoTriageParts): AutoTriage {
    const { board, settings, config } = parts;
    return new AutoTriage({
        uow: parts.uow,
        issues: board.issues,
        proposals: board.triage,
        components: board.components,
        endpoint: parts.endpoint,
        settings: () => autoTriageSettings(settings.settings(), config.autoTriage),
        log: (line) => console.log(line),
    });
}

/**
 * Auto-triage over the tags: the Board, the default shared backend
 * (`Inference`), the settings in force (`WorkspaceSettings`) and
 * `IssuesConfig`. `uow` is the Board's connection's unit of work.
 */
export const AutoTriageLive = (uow: UnitOfWork) =>
    Layer.effect(
        AutoTriageInstance,
        Effect.gen(function* () {
            return makeAutoTriage({
                uow,
                board: yield* SqliteBoardService,
                endpoint: sharedEndpoint(yield* Inference),
                settings: yield* WorkspaceSettings,
                config: yield* IssuesConfig,
            });
        }),
    );

/**
 * The issue views (`IssuesViews`) over the Board, the workspace's people
 * and socios, and the change counters.
 */
export const IssuesViewsLive = Layer.effect(
    IssuesViews,
    Effect.gen(function* () {
        const people = yield* People;
        const socios = yield* Socios;
        const views = issuesViews(
            {
                board: yield* Board,
                workspace: { users: () => people.users(), dot: (id) => socios.dot(id) },
            },
            yield* Counters,
        );
        return IssuesViews.of(views);
    }),
);

/**
 * A promise from the promise-based Board as an Effect: an `IssueError` is
 * the typed failure for its status, with its message; anything else is a
 * defect, which the router logs and answers 500 as today.
 */
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, IssueFailure> =>
    Effect.flatMap(
        Effect.promise(() =>
            run().then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) =>
                    error instanceof IssueError ? { ok: false as const, error } : Promise.reject(error),
            ),
        ),
        (result) => (result.ok ? Effect.succeed(result.value) : Effect.fail(issueFailure(result.error))),
    );

/** The Effect API over the Board, for new code (4.4, step 6). */
export const IssueBoardLive = Layer.effect(
    IssueBoard,
    Effect.gen(function* () {
        const board = yield* Board;
        return IssueBoard.of({
            get: Effect.fn('IssueBoard.get')(function* (number: number) {
                const issue = yield* Effect.promise(() => board.issues.get(number));
                if (!issue) {
                    return yield* new IssueNotFound({ message: 'Issue not found.' });
                }
                return issue;
            }),
            list: (filter) => Effect.promise(() => board.issues.list(filter)).pipe(Effect.withSpan('IssueBoard.list')),
            titles: (options) =>
                Effect.promise(() => board.issues.titles(options)).pipe(Effect.withSpan('IssueBoard.titles')),
            create: (input, actorId) =>
                attempt(() => board.issues.create(input, actorId)).pipe(Effect.withSpan('IssueBoard.create')),
            update: (number, patch, actorId) =>
                attempt(() => board.issues.update(number, patch, actorId)).pipe(Effect.withSpan('IssueBoard.update')),
            comment: (number, text, actorId) =>
                attempt(() => board.issues.addComment(number, text, actorId)).pipe(
                    Effect.withSpan('IssueBoard.comment'),
                ),
        });
    }),
);

/** What one leadership term started, recorded the moment each is active. */
interface Active {
    autoTriage?: boolean;
    offNotice?: () => void;
    deliveries?: boolean;
    gate?: boolean;
    offStatus?: () => void;
}

/**
 * The leader work of `issues/module.ts` (4.5): today's start steps in
 * today's order, and one cleanup, registered before any of them, that runs
 * today's stop steps in today's order for what started. `process` is
 * today's single-flight subscription run, owned here instead of in
 * module-level `WeakMap`s.
 */
export const IssuesBackgroundLive = (log: (line: string) => void) =>
    Layer.effect(
        IssuesBackground,
        Effect.gen(function* () {
            const board = yield* Board;
            const triage = yield* AutoTriageControl;
            const deliveries = yield* Deliveries;
            const telegram = yield* TelegramDirect;

            /** The gate: subscription runs start only while it is open. */
            let open = false;
            let work: Promise<void> | undefined;
            /** Terms whose scope is open: disposing the runtime closes them. */
            const terms = new Set<Effect.Effect<void>>();
            yield* Effect.addFinalizer(() => Effect.forEach([...terms], (cleanup) => cleanup, { discard: true }));

            // A call while a run is in flight joins it; each run waits for the
            // next turn first, so it never shares a transaction.
            const process = (): Promise<void> => {
                if (!open) {
                    return Promise.resolve();
                }
                if (work) {
                    return work;
                }
                const current = (async () => {
                    await nextTurn();
                    if (!open) {
                        return;
                    }
                    await board.watches.replay();
                    await board.watches.flush(deliveries);
                })();
                work = current;
                void current
                    .finally(() => {
                        if (work === current) {
                            work = undefined;
                        }
                    })
                    .catch(() => {});
                return current;
            };

            // Dot-request notices to the person's linked Telegram, once.
            const onNotice = async (notice: RecordedNotice) => {
                if (!telegram.online()) {
                    return;
                }
                const linked = await telegram.linkFor(notice.userId);
                if (!linked) {
                    return;
                }
                telegram
                    .sendDirect(
                        linked.telegramUserId,
                        noticeMessage({
                            number: notice.issue.number,
                            capability: notice.capability,
                            status: notice.status,
                            resolution: notice.issue.resolution,
                            dots: notice.dots,
                        }),
                    )
                    .catch(() => log('Dot request notice: the Telegram message failed.'));
            };

            const lead = (stopped: LeadStopped) =>
                Effect.gen(function* () {
                    const active: Active = {};
                    let closing = false;
                    const lock = yield* Semaphore.make(1);
                    const locked = Semaphore.withPermits(lock, 1);

                    // One cleanup, registered first. It sets `closing` at once, so no
                    // step starts from now on, then takes the lock, so it waits for
                    // a step in progress, which is then recorded and released. It
                    // runs once: when the term's scope closes, or when the runtime
                    // is disposed with the scope still open, whichever comes first.
                    const cleanup = yield* Effect.cached(
                        Effect.sync(() => {
                            closing = true;
                        }).pipe(
                            Effect.andThen(
                                locked(
                                    Effect.gen(function* () {
                                        if (active.gate) {
                                            open = false;
                                        }
                                        if (active.autoTriage) {
                                            triage.stop();
                                            stopped.autoTriage = true;
                                        }
                                        active.offNotice?.();
                                        active.offStatus?.();
                                        // A real wait on the run in flight, as today.
                                        const inFlight = work;
                                        if (inFlight) {
                                            yield* Effect.promise(() => inFlight.catch(() => {}));
                                        }
                                        if (active.deliveries) {
                                            stopped.deliveries = true;
                                            yield* Effect.promise(() => deliveries.stop());
                                        }
                                    }),
                                ),
                            ),
                            Effect.ensuring(
                                Effect.sync(() => {
                                    stopped.cleaned = true;
                                    terms.delete(cleanup);
                                }),
                            ),
                        ),
                    );
                    terms.add(cleanup);
                    yield* Effect.addFinalizer(() => cleanup);

                    /** One start step: whole or not at all, never after cleanup began. */
                    const step = <E>(start: Effect.Effect<void, E>) =>
                        locked(Effect.suspend(() => (closing ? Effect.interrupt : start))).pipe(Effect.uninterruptible);

                    yield* step(
                        Effect.tryPromise({
                            try: () => {
                                active.autoTriage = true;
                                return triage.start({ recover: false });
                            },
                            catch: (error) => error,
                        }),
                    );
                    yield* step(
                        Effect.sync(() => {
                            active.offNotice = board.requests.onNotice(onNotice);
                        }),
                    );
                    yield* step(
                        Effect.sync(() => {
                            deliveries.resume();
                            active.deliveries = true;
                        }),
                    );
                    yield* step(
                        Effect.sync(() => {
                            open = true;
                            active.gate = true;
                        }),
                    );
                    // Status writes finish after commit; slow external delivery is tracked background work.
                    yield* step(
                        Effect.sync(() => {
                            active.offStatus = board.issues.onStatusChange(() => {
                                void process().catch(() => log('Issue subscription notification work failed.'));
                            });
                        }),
                    );
                    // The replay: what a stopped process left.
                    yield* step(
                        Effect.sync(() => {
                            void process().catch(() => log('Issue subscription recovery failed.'));
                        }),
                    );
                });

            return IssuesBackground.of({ lead, process });
        }),
    );
