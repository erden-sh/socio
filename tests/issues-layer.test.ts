// The issues feature's layers on the app runtime: auto-triage and
// `IssuesConfig` from the graph, and the issue views behind `IssuesViews`,
// which answer as the plain views (issues/views.ts) do over the platform
// (live/'s copies, since deleted, read the same).
import { Context } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { issuesConfig, LegacyAutoTriage } from '../src/server/composition/issues.js';
import { AutoTriage } from '../src/server/issues/auto-triage.js';
import { IssuesConfig, IssuesViews } from '../src/server/issues/contract.js';
import { AutoTriageInstance } from '../src/server/issues/layer.js';
import { issuesModule } from '../src/server/issues/module.js';
import {
    issueDetailView as liveDetailView,
    issueListVersion as liveListVersion,
    issueListView as liveListView,
    issueSearchView as liveSearchView,
    issueTitlesView as liveTitlesView,
} from '../src/server/issues/views.js';
import { type AppBoot } from '../src/server/main.js';

import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
    autoTriage: { enabled: false, perDay: 3 },
};

function boot(): AppBoot {
    const workspace = new WorkspaceStore(testDatabase());
    const store = new Store(testDatabase());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
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
        modules: [issuesModule],
    };
}

it('builds auto-triage and IssuesConfig in the graph, from the startup configuration', async () => {
    const { runtime, platform } = await startWithTestPlatform(boot());
    cleanup.push(() => runtime.dispose());
    const context = await runtime.context();
    const triage = Context.get(context, AutoTriageInstance);
    expect(triage).toBeInstanceOf(AutoTriage);
    expect(LegacyAutoTriage).toBe(AutoTriageInstance);
    expect(platform.autoTriage).toBe(triage);
    expect(Context.get(context, IssuesConfig)).toEqual(issuesConfig(config));
    expect(Context.get(context, IssuesConfig)).toEqual({
        dotRequestLimits: undefined,
        autoTriage: { enabled: false, perDay: 3 },
        appOrigin: 'https://app.example.invalid',
    });
});

it('serves the issue views through IssuesViews, as the plain views over the platform', async () => {
    const { runtime, platform } = await startWithTestPlatform(boot());
    cleanup.push(() => runtime.dispose());
    const { issues, votes } = platform.board;
    const first = await issues.create({ title: 'Board views', body: 'Read them through the tag.' }, 'alice');
    const second = await issues.create({ title: 'Another item', assigneeId: 'bob' }, 'alice');
    await issues.addComment(first.number, 'Seen.', 'bob');
    await issues.addBlocker(first.number, second.number, 'alice');
    await votes.cast(first.id, 'bob');

    const views = Context.get(await runtime.context(), IssuesViews);
    expect(await views.listView({}, 'bob')).toEqual(await liveListView(platform, {}, 'bob'));
    expect(await views.listView({ assigneeId: 'bob' })).toEqual(await liveListView(platform, { assigneeId: 'bob' }));
    expect(await views.searchView('tag')).toEqual(await liveSearchView(platform.board, 'tag'));
    expect(await views.searchView('tag')).toEqual({ numbers: [first.number] });
    expect(await views.titlesView({ open: true })).toEqual(await liveTitlesView(platform.board, { open: true }));
    const found = (await issues.get(first.number))!;
    const detail = await views.detailView(found, 'bob');
    expect(detail).toEqual(await liveDetailView(platform, found, 'bob'));
    expect(detail.users).toMatchObject({ alice: 'Alice', bob: 'Bob' });
    expect(views.listVersion('bob')).toBe(liveListVersion(platform.workspace.counters, 'bob'));
    expect(views.listVersion('bob')).toMatch(/^bob\|issues=\d+,users=\d+,dots=\d+,apps=\d+,plugins=\d+,spaces=\d+$/);
});
