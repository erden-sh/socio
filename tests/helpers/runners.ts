/**
 * The runners as the tests and the benches construct them: turns'
 * `LocalAgentRunner` and task `Runner` take what they run with, and these
 * test-only subclasses keep the short constructors, handing in the defaults
 * the server's boot step passes itself (`index.ts`,
 * `composition/lifecycle/turns.ts`):
 *
 * - `LocalAgentRunner`: the process's replay worker (`sharedReplayer()`)
 *   unless a replayer is given (tests replay inline with `InlineReplayer`).
 * - `Runner`: research (`web/research.ts`) over search's `webSearch` with
 *   `config` unless an executor is given.
 */
import type { DatabaseSync } from 'node:sqlite';

import { sharedReplayer } from '../../src/server/replay/pool.js';
import { webSearch } from '../../src/server/search/layer.js';
import { LocalAgentRunner as TurnsLocalAgentRunner } from '../../src/server/turns/local-runner.js';
import { Runner as TurnsRunner, type TaskExecutor } from '../../src/server/turns/runner.js';
import { research, type Config } from '../../src/server/web/research.js';

type LocalRunnerOptions = ConstructorParameters<typeof TurnsLocalAgentRunner>[1];

/** The agent runner, over the process's replay worker unless `options.replayer` is given. */
export class LocalAgentRunner extends TurnsLocalAgentRunner {
    constructor(
        database: string | DatabaseSync,
        options: Omit<LocalRunnerOptions, 'replayer'> & Partial<Pick<LocalRunnerOptions, 'replayer'>> = {},
    ) {
        super(database, { ...options, replayer: options.replayer ?? sharedReplayer() });
    }
}

/** Research with `config`, as the task runner ran it when given no executor. */
export const researchExecutor =
    (config: Config): TaskExecutor =>
    (claim, memories, signal, progress) =>
        research(claim.prompt, memories, config, signal, progress, webSearch);

/** The task runner, running research with `config` unless `execute` is given. */
export class Runner extends TurnsRunner {
    constructor(
        store: ConstructorParameters<typeof TurnsRunner>[0],
        config: Config,
        execute?: TaskExecutor,
        timeLimitMs?: ConstructorParameters<typeof TurnsRunner>[2],
        admitted?: ConstructorParameters<typeof TurnsRunner>[3],
    ) {
        super(store, execute ?? researchExecutor(config), timeLimitMs, admitted);
    }
}
