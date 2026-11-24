// The issues pilot's composition root, its Effect API and its HTTP edge.
import { Cause, Context, Exit } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import {
    Board,
    IssueBoard,
    IssueConflict,
    IssueForbidden,
    IssueInvalid,
    IssueNotFound,
    IssueTooLarge,
    IssueUnsupportedType,
    isIssueFailure,
    IssueError,
} from '../src/server/issues/contract.js';
import { issueFailure } from '../src/server/issues/errors.js';
import { SqliteBoardService } from '../src/server/issues/layer.js';
import { issuesModule } from '../src/server/issues/module.js';
import { issueRoutes } from '../src/server/issues/routes.js';
import { startAppRuntime, type AppBoot } from '../src/server/main.js';
import { RunsViews } from '../src/server/runs/contract.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};

function boot(modules: AppBoot['modules'] = [issuesModule]): AppBoot {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return {
        db: workspace.db,
        store,
        workspace,
        config,
        runner: new LocalAgentRunner(testDatabase()),
        auth: testAuth(),
        modules,
    };
}

it('builds the graph once at startup: its services are handed the one Board', async () => {
    const { runtime, platform } = await startWithTestPlatform(boot());
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    expect(Context.get(context, Board)).toBe(platform.board);
    expect(Context.get(context, SqliteBoardService)).toBe(platform.board);
    // Auto-triage reads the same Board: an issue it can see is the platform's.
    const made = await runtime.runPromise(
        IssueBoard.use((board) => board.create({ title: 'Through Effect' }, 'alice')),
    );
    expect((await platform.board.issues.get(made.number))?.title).toBe('Through Effect');
    // The leader work runs through this runtime.
    await platform.start();
    await platform.stop();
});

it('stops the boot when a layer fails to build', async () => {
    await expect(startAppRuntime(boot([issuesModule, issuesModule]))).rejects.toThrow(
        'Module "issues" is registered twice.',
    );
});

it('gives the Effect API typed failures with today’s messages', async () => {
    const { runtime, platform } = await startWithTestPlatform(boot());
    cleanup.push(() => runtime.dispose());
    const missing = await runtime.runPromiseExit(IssueBoard.use((board) => board.get(404)));
    expect(Exit.isFailure(missing) && Cause.squash(missing.cause)).toEqual(
        new IssueNotFound({ message: 'Issue not found.' }),
    );
    const update = await runtime.runPromiseExit(
        IssueBoard.use((board) => board.update(404, { title: 'Nope' }, 'alice')),
    );
    const today = await platform.board.issues.update(404, { title: 'Nope' }, 'alice').catch((error: unknown) => error);
    expect(today).toBeInstanceOf(IssueError);
    const failure = Exit.isFailure(update) ? Cause.squash(update.cause) : undefined;
    expect(isIssueFailure(failure)).toBe(true);
    expect(failure).toMatchObject({ _tag: 'IssueNotFound', message: (today as IssueError).message });
    // An unplanned throw stays a defect, the same object.
    const boom = new TypeError('boom');
    vi.spyOn(platform.board.issues, 'create').mockRejectedValueOnce(boom);
    const defect = await runtime.runPromiseExit(IssueBoard.use((board) => board.create({ title: 'Defect' }, 'alice')));
    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause) && Cause.squash(defect.cause)).toBe(boom);
});

it('maps each IssueError status to its tag, message unchanged', () => {
    const cases = [
        [400, IssueInvalid],
        [403, IssueForbidden],
        [404, IssueNotFound],
        [409, IssueConflict],
        [413, IssueTooLarge],
        [415, IssueUnsupportedType],
    ] as const;
    for (const [status, Tag] of cases) {
        const failure = issueFailure(new IssueError(`status ${status}`, status));
        expect(failure).toBeInstanceOf(Tag);
        expect(failure.message).toBe(`status ${status}`);
    }
});

it('answers each typed failure with its status and message, and anything else as before', async () => {
    const { platform, dispose } = await makeTestRuntime({ config, modules: [issuesModule] });
    cleanup.push(dispose);
    const app = issueRoutes(platform, platform.context.services.get(RunsViews));
    const failures = {
        400: new IssueInvalid({ message: 'Invalid.' }),
        403: new IssueForbidden({ message: 'Forbidden.' }),
        404: new IssueNotFound({ message: 'Issue not found.' }),
        409: new IssueConflict({ message: 'Conflict.' }),
        413: new IssueTooLarge({ message: 'Too large.' }),
        415: new IssueUnsupportedType({ message: 'Unsupported.' }),
    };
    for (const [status, failure] of Object.entries(failures)) {
        app.get(`/test/${status}`, () => {
            throw failure;
        });
    }
    app.get('/test/defect', () => {
        throw new TypeError('secret detail');
    });
    for (const [status, failure] of Object.entries(failures)) {
        const response = await app.request(`/test/${status}`);
        expect(response.status).toBe(Number(status));
        expect(await response.json()).toEqual({ error: failure.message });
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.request('/test/defect');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'The issue tracker could not complete this request.' });
    expect(logged).toHaveBeenCalledWith('Issue request failed:', 'TypeError');
});
