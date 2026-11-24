/**
 * Issue components (CB-442): the
 * plugins and apps an issue is about. Above all, a reader never sees the
 * name of a plugin or app they may not see: not in the options, the tags,
 * the label map, the history, a filter's answer or a triage suggestion.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IssueComponentOptions } from '@socio/shared/issues/issue-components';
import type { IssueDetail, IssueList } from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

import { agentMcpServer } from '../src/server/agents/mcp-tools.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { issueComponentSources } from '../src/server/composition/issues.js';
import {
    TRIAGE_PUBLIC_REASON,
    parseTriageAnswer,
    triageComment,
    triagePrompt,
} from '../src/server/issues/auto-triage.js';
import type { ComponentApp, ComponentPlugin, IssueComponentSourcesShape } from '../src/server/issues/contract.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/**
 * The workspace's plugins and apps, as the composition would bind them,
 * but in the test's hands: Forms is for members, Payroll for admins only,
 * Legacy is turned off; the CRM is Carol's and shared with nobody, Bob's
 * Tracker is his own.
 */
function workspaceTargets() {
    const state = {
        plugins: [
            { id: 'forms', name: 'Forms', enabled: true, audience: 'members' },
            { id: 'payroll', name: 'Payroll', enabled: true, audience: 'admins' },
            { id: 'legacy', name: 'Legacy', enabled: false, audience: 'members' },
        ] as ComponentPlugin[],
        apps: [
            { id: 'crm', name: 'Secret CRM', ownerUserId: 'carol', createdAt: 100 },
            { id: 'tracker', name: 'Tracker', ownerUserId: 'bob', createdAt: 200 },
        ] as ComponentApp[],
        retired: [] as Array<ComponentApp>,
        /** App ids shared with a Space each person reads. */
        shared: new Map<string, string[]>(),
        grants: [] as Array<{ personId: string; socioId: string; conversationId: string; audiences: string[] }>,
    };
    const admin = (userId: string) => USERS.find((user) => user.id === userId)?.role === 'admin';
    const sources: IssueComponentSourcesShape = {
        plugins: () => state.plugins,
        mayUsePlugin: (id, userId) => {
            const plugin = state.plugins.find((one) => one.id === id);
            return !!plugin?.enabled && (admin(userId) || plugin.audience === 'members');
        },
        apps: () => state.apps,
        mayOpenApp: (id, userId) => {
            const app = state.apps.find((one) => one.id === id);
            return !!app && (app.ownerUserId === userId || !!state.shared.get(userId)?.includes(id));
        },
        retiredApp: (id, generation) => {
            const app = state.retired.find((one) => one.id === id && one.createdAt === generation);
            return app && { name: app.name, ownerUserId: app.ownerUserId };
        },
        isAdmin: admin,
        userName: (userId) => USERS.find((user) => user.id === userId)?.name,
        conversationAudiences: ({ personId, socioId, conversationId }) =>
            state.grants
                .filter(
                    (grant) =>
                        grant.personId === personId &&
                        grant.socioId === socioId &&
                        grant.conversationId === conversationId,
                )
                .flatMap((grant) => grant.audiences),
    };
    const deleteApp = (id: string) => {
        const app = state.apps.find((one) => one.id === id)!;
        state.apps = state.apps.filter((one) => one !== app);
        state.retired.push(app);
    };
    return { state, sources, deleteApp };
}

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store, workspace, platform, app, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'local', model: 'custom-model', runtimeUrl: '' },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: { provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const targets = workspaceTargets();
    platform.board.components.useSources(targets.sources);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return async <T = unknown>(path: string, method = 'GET', body?: unknown) => {
            const response = await app.request(`/api${path}`, {
                method,
                headers: { cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const text = await response.text();
            return { status: response.status, body: JSON.parse(text) as T, text };
        };
    };
    const board = platform.board;
    /** An issue Alice files and tags. */
    const tagged = async (refs: string[], title = 'Exports fail') => {
        const issue = await board.issues.create({ title, body: 'It breaks.' }, 'alice');
        await board.components.set(issue.id, refs, { actorId: 'alice', viewerId: 'alice' });
        return issue;
    };
    return {
        store,
        workspace,
        platform,
        board,
        targets,
        tagged,
        alice: await as('alice'),
        bob: await as('bob'),
        carol: await as('carol'),
    };
}

/** Names Bob must never be shown. */
const HIDDEN_FROM_BOB = ['Payroll', 'Secret CRM', 'Legacy', 'payroll', 'crm', 'legacy'];
const expectNoHiddenNames = (text: string) => {
    for (const name of HIDDEN_FROM_BOB) {
        expect(text).not.toContain(name);
    }
};

describe('options', () => {
    it('offers a member the wildcards, the plugins they may use and the apps they may open', async () => {
        const f = await fixture();
        const bob = await f.bob<IssueComponentOptions>('/issues/components');
        expect(bob.status).toBe(200);
        expect(bob.body.options).toEqual([
            { ref: 'plugins:*', label: 'All plugins', kind: 'plugins' },
            { ref: 'apps:*', label: 'All apps', kind: 'apps' },
            { ref: 'plugin:forms', label: 'Forms', kind: 'plugin' },
            { ref: 'app:tracker', label: 'Tracker', kind: 'app', ownerName: 'Bob' },
        ]);
        expectNoHiddenNames(bob.text);
    });

    it('offers an admin every plugin, off ones marked, and every app with its owner', async () => {
        const f = await fixture();
        const alice = await f.alice<IssueComponentOptions>('/issues/components');
        expect(alice.body.options.map((option) => option.ref)).toEqual([
            'plugins:*',
            'apps:*',
            'plugin:forms',
            'plugin:legacy',
            'plugin:payroll',
            'app:crm',
            'app:tracker',
        ]);
        expect(alice.body.options.find((option) => option.ref === 'plugin:legacy')?.state).toBe('disabled');
        expect(alice.body.options.find((option) => option.ref === 'app:crm')).toMatchObject({
            label: 'Secret CRM',
            ownerName: 'Carol',
        });
    });

    it('offers an app shared with a Space the person reads', async () => {
        const f = await fixture();
        f.targets.state.shared.set('bob', ['crm']);
        const bob = await f.bob<IssueComponentOptions>('/issues/components');
        expect(bob.body.options.map((option) => option.ref)).toContain('app:crm');
    });

    it('has only the wildcards before the plugins and apps are bound', async () => {
        const f = await fixture();
        f.board.components.useSources(undefined as unknown as IssueComponentSourcesShape);
        expect(f.board.components.options('alice').map((option) => option.ref)).toEqual(['plugins:*', 'apps:*']);
    });
});

describe('tags and the label map', () => {
    it('leaves a hidden tag out entirely for a reader, in the list and the detail', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:payroll', 'app:crm', 'plugin:forms', 'apps:*']);

        const bobList = await f.bob<IssueList>('/issues');
        const row = bobList.body.issues.find((one) => one.number === issue.number)!;
        expect(row.components).toEqual(['apps:*', 'plugin:forms']);
        expect(bobList.body.components).toEqual({
            'apps:*': { label: 'All apps', kind: 'apps', state: 'live' },
            'plugin:forms': { label: 'Forms', kind: 'plugin', state: 'live' },
        });
        expectNoHiddenNames(bobList.text);

        const bobDetail = await f.bob<IssueDetail>(`/issues/${issue.number}`);
        expect(bobDetail.body.issue.components).toEqual(['apps:*', 'plugin:forms']);
        expect(Object.keys(bobDetail.body.components!).sort()).toEqual(['apps:*', 'plugin:forms']);
        expectNoHiddenNames(bobDetail.text);

        const aliceDetail = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(aliceDetail.body.issue.components).toEqual(['app:crm', 'apps:*', 'plugin:forms', 'plugin:payroll']);
        expect(aliceDetail.body.components!['app:crm']).toEqual({
            label: 'Secret CRM',
            kind: 'app',
            state: 'live',
            ownerName: 'Carol',
        });
    });

    it('shows the live name after a rename, and the kept name once the plugin is uninstalled', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:forms', 'plugin:payroll']);
        f.targets.state.plugins[0]!.name = 'Forms Pro';
        expect((await f.bob<IssueList>('/issues')).body.components!['plugin:forms']?.label).toBe('Forms Pro');

        // Uninstalled: by the audience it had. Forms was for members, Payroll admins only.
        f.targets.state.plugins = f.targets.state.plugins.filter((one) => one.id === 'legacy');
        const bob = await f.bob<IssueDetail>(`/issues/${issue.number}`);
        expect(bob.body.issue.components).toEqual(['plugin:forms']);
        expect(bob.body.components!['plugin:forms']).toEqual({ label: 'Forms', kind: 'plugin', state: 'uninstalled' });
        expectNoHiddenNames(bob.text);
        const alice = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(alice.body.components!['plugin:payroll']).toEqual({
            label: 'Payroll',
            kind: 'plugin',
            state: 'uninstalled',
        });
    });

    it('shows a turned-off plugin to admins only', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:legacy']);
        expect((await f.bob<IssueDetail>(`/issues/${issue.number}`)).body.issue.components).toEqual([]);
        expect((await f.alice<IssueDetail>(`/issues/${issue.number}`)).body.components!['plugin:legacy']).toMatchObject(
            {
                state: 'disabled',
            },
        );
    });

    it('never moves a tag to a later app that takes a deleted app’s address', async () => {
        const f = await fixture();
        const issue = await f.tagged(['app:crm']);
        f.targets.deleteApp('crm');
        f.targets.state.apps.push({ id: 'crm', name: 'New CRM', ownerUserId: 'bob', createdAt: 300 });

        const alice = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(alice.body.issue.components).toEqual(['app:crm@100']);
        expect(alice.body.components!['app:crm@100']).toEqual({
            label: 'Secret CRM',
            kind: 'app',
            state: 'deleted',
            ownerName: 'Carol',
        });
        // Its last owner sees it; Bob, who owns the new app at that address, doesn't.
        expect((await f.carol<IssueDetail>(`/issues/${issue.number}`)).body.issue.components).toEqual(['app:crm@100']);
        const bob = await f.bob<IssueDetail>(`/issues/${issue.number}`);
        expect(bob.body.issue.components).toEqual([]);
        expect(bob.text).not.toContain('Secret CRM');
        // Filtering on the new app doesn't find the old app's issue.
        const byNew = await f.bob<IssueList>('/issues?component=app:crm');
        expect(byNew.body.issues).toEqual([]);
    });
});

describe('writing', () => {
    it('lets a member set components when filing, from their own options only', async () => {
        const f = await fixture();
        const filed = await f.bob<IssueDetail>('/issues', 'POST', {
            title: 'Forms loses answers',
            components: ['plugin:forms', 'app:tracker'],
        });
        expect(filed.status).toBe(201);
        expect(filed.body.issue.components).toEqual(['app:tracker', 'plugin:forms']);

        // A hidden one is unknown, exactly as one that doesn't exist.
        const hidden = await f.bob<{ error: string }>('/issues', 'POST', {
            title: 'Payroll is late',
            components: ['plugin:payroll'],
        });
        const missing = await f.bob<{ error: string }>('/issues', 'POST', {
            title: 'Nothing here',
            components: ['plugin:nothing'],
        });
        expect(hidden.status).toBe(400);
        expect(missing.status).toBe(400);
        expect(hidden.body.error).toBe('Unknown component: plugin:payroll.');
        expect(missing.body.error).toBe('Unknown component: plugin:nothing.');
        // Nothing was filed by either.
        expect((await f.bob<IssueList>('/issues')).body.issues.map((one) => one.title)).toEqual([
            'Forms loses answers',
        ]);
    });

    it('lets only admins change components after filing', async () => {
        const f = await fixture();
        const filed = await f.bob<IssueDetail>('/issues', 'POST', { title: 'Forms loses answers' });
        const refused = await f.bob(`/issues/${filed.body.issue.number}`, 'PATCH', { components: ['plugin:forms'] });
        expect(refused.status).toBe(403);
        const changed = await f.alice<IssueDetail>(`/issues/${filed.body.issue.number}`, 'PATCH', {
            components: ['plugin:forms', 'plugin:payroll'],
        });
        expect(changed.status).toBe(200);
        expect(changed.body.issue.components).toEqual(['plugin:forms', 'plugin:payroll']);
    });

    it('keeps the tags an editor can’t see when they replace the ones they can', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:payroll', 'plugin:forms']);
        // As Bob would see it: only Forms; he clears it.
        await f.board.components.set(issue.id, [], { actorId: 'bob', viewerId: 'bob' });
        const alice = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(alice.body.issue.components).toEqual(['plugin:payroll']);
    });

    it('keeps a tag whose target is gone when an editor sends it back, and refuses one they never had', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:forms']);
        f.targets.state.plugins = f.targets.state.plugins.filter((one) => one.id !== 'forms');
        const kept = await f.alice<IssueDetail>(`/issues/${issue.number}`, 'PATCH', {
            components: ['plugin:forms', 'apps:*'],
        });
        expect(kept.body.issue.components).toEqual(['apps:*', 'plugin:forms']);
        expect(kept.body.components!['plugin:forms']?.state).toBe('uninstalled');
        const other = await f.tagged([]);
        const refused = await f.alice<{ error: string }>(`/issues/${other.number}`, 'PATCH', {
            components: ['plugin:forms'],
        });
        expect(refused.status).toBe(400);
    });

    it('caps an issue at ten components', async () => {
        const f = await fixture();
        for (let n = 0; n < 9; n++) {
            f.targets.state.plugins.push({ id: `p${n}`, name: `P${n}`, enabled: true, audience: 'members' });
        }
        const refs = ['plugins:*', 'apps:*', 'plugin:forms', ...Array.from({ length: 8 }, (_, n) => `plugin:p${n}`)];
        const issue = await f.board.issues.create({ title: 'Too many' }, 'alice');
        await expect(f.board.components.set(issue.id, refs, { actorId: 'alice', viewerId: 'alice' })).rejects.toThrow(
            'at most 10',
        );
    });

    it('records a history row a reader sees only with the refs they may see', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:forms']);
        await f.board.components.set(issue.id, ['plugin:forms', 'plugin:payroll'], {
            actorId: 'alice',
            viewerId: 'alice',
        });
        const history = (detail: IssueDetail) => detail.events.filter((event) => event.kind === 'components');
        const alice = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(history(alice.body).map((event) => [event.fromValue, event.toValue])).toEqual([
            [null, '["plugin:forms"]'],
            ['["plugin:forms"]', '["plugin:forms","plugin:payroll"]'],
        ]);
        // Bob: the first change only; the second changed nothing he can see.
        const bob = await f.bob<IssueDetail>(`/issues/${issue.number}`);
        expect(history(bob.body).map((event) => [event.fromValue, event.toValue])).toEqual([
            [null, '["plugin:forms"]'],
        ]);
        expectNoHiddenNames(bob.text);
    });

    it('reads history the same after the plugin is uninstalled and the tag removed', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:forms', 'plugin:payroll']);
        f.targets.state.plugins = f.targets.state.plugins.filter((one) => one.id === 'legacy');
        await f.board.components.set(issue.id, [], { actorId: 'alice', viewerId: 'alice' });
        expect((await f.board.components.rowsOf(issue.id)).length).toBe(0);
        const history = (detail: IssueDetail) =>
            detail.events.filter((event) => event.kind === 'components').map((e) => [e.fromValue, e.toValue]);

        // Bob still sees Forms added and removed, by its saved name; never Payroll.
        const bob = await f.bob<IssueDetail>(`/issues/${issue.number}`);
        expect(history(bob.body)).toEqual([
            [null, '["plugin:forms"]'],
            ['["plugin:forms"]', null],
        ]);
        expect(bob.body.components!['plugin:forms']).toEqual({ label: 'Forms', kind: 'plugin', state: 'uninstalled' });
        expectNoHiddenNames(bob.text);

        // Alice sees both, by their saved names rather than their ids.
        const alice = await f.alice<IssueDetail>(`/issues/${issue.number}`);
        expect(history(alice.body)).toEqual([
            [null, '["plugin:forms","plugin:payroll"]'],
            ['["plugin:forms","plugin:payroll"]', null],
        ]);
        expect(alice.body.components!['plugin:forms']?.label).toBe('Forms');
        expect(alice.body.components!['plugin:payroll']?.label).toBe('Payroll');
    });
});

describe('filtering', () => {
    it('matches exactly: “All plugins” is its own value', async () => {
        const f = await fixture();
        const forms = await f.tagged(['plugin:forms'], 'Forms one');
        const all = await f.tagged(['plugins:*'], 'All plugins one');
        const byForms = await f.bob<IssueList>('/issues?component=plugin:forms');
        expect(byForms.body.issues.map((one) => one.number)).toEqual([forms.number]);
        const byAll = await f.bob<IssueList>('/issues?component=plugins:*');
        expect(byAll.body.issues.map((one) => one.number)).toEqual([all.number]);
    });

    it('refuses a filter on a hidden component as unknown, so it can’t probe', async () => {
        const f = await fixture();
        await f.tagged(['plugin:payroll']);
        const hidden = await f.bob<{ error: string }>('/issues?component=plugin:payroll');
        const missing = await f.bob<{ error: string }>('/issues?component=plugin:nothing');
        expect(hidden.status).toBe(400);
        expect(missing.status).toBe(400);
        expect(hidden.body.error.replace('payroll', 'X')).toBe(missing.body.error.replace('nothing', 'X'));
        expect((await f.alice<IssueList>('/issues?component=plugin:payroll')).body.issues).toHaveLength(1);
    });

    it('filters on a deleted app’s tag for those who see it', async () => {
        const f = await fixture();
        const issue = await f.tagged(['app:crm']);
        f.targets.deleteApp('crm');
        const carol = await f.carol<IssueList>('/issues?component=app:crm@100');
        expect(carol.body.issues.map((one) => one.number)).toEqual([issue.number]);
        expect((await f.bob('/issues?component=app:crm@100')).status).toBe(400);
    });
});

describe('automatic triage suggestions', () => {
    const fakeModel = (content: string) => {
        const calls: Array<{ messages: Array<{ content: string }> }> = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: unknown, init?: RequestInit) => {
                calls.push(JSON.parse(String(init?.body ?? '{}')));
                return Response.json({ choices: [{ message: { content } }] });
            }),
        );
        return calls;
    };
    const PROPOSAL = {
        kind: 'bug' as const,
        area: null,
        priority: 'high' as const,
        labels: [],
        reason: 'Saving a submission breaks.',
    };

    it('accepts only refs from the list it was given', () => {
        const answer = (components: string[]) => JSON.stringify({ ...PROPOSAL, components });
        expect(parseTriageAnswer(answer(['plugin:forms']), ['plugin:forms'])?.components).toEqual(['plugin:forms']);
        expect(parseTriageAnswer(answer(['plugin:other']), ['plugin:forms'])).toBeUndefined();
        // Older answers without components still parse.
        expect(parseTriageAnswer(JSON.stringify(PROPOSAL))?.components).toEqual([]);
    });

    it('frames the names as data, and the comment never names them', () => {
        const prompt = triagePrompt({ title: 'T', body: 'B' }, [{ ref: 'plugin:payroll', label: 'Payroll' }]);
        expect(prompt.indexOf('Payroll')).toBeGreaterThan(prompt.indexOf('<<<UNTRUSTED ISSUE CONTENT'));
        const comment = triageComment({ ...PROPOSAL, kind: 'bug', components: ['plugin:payroll', 'app:crm@100'] });
        expect(comment).toContain('Components: 2 suggested');
        expect(comment).not.toContain('payroll');
        expect(comment).not.toContain('crm');
    });

    it('shows admins every suggestion and others only what they may see; applying adds them', async () => {
        const f = await fixture();
        await f.store.updateSettings({ autoTriage: { enabled: true, perDay: 100 } });
        await f.platform.start();
        const calls = fakeModel(
            JSON.stringify({ ...PROPOSAL, components: ['plugin:payroll', 'plugin:forms', 'app:crm'] }),
        );
        const filed = await f.bob<IssueDetail>('/issues', 'POST', { title: 'Saving a submission breaks' });
        await f.platform.autoTriage.idle();

        // The model saw every option, as data.
        const prompt = calls[0]!.messages[1]!.content;
        expect(prompt).toContain('"ref": "plugin:payroll"');
        expect(prompt).toContain('"name": "Secret CRM"');

        const number = filed.body.issue.number;
        const bob = await f.bob<IssueDetail>(`/issues/${number}`);
        expect(bob.body.triage?.components).toEqual(['plugin:forms']);
        expectNoHiddenNames(bob.text);
        const alice = await f.alice<IssueDetail>(`/issues/${number}`);
        expect(alice.body.triage?.components).toEqual(['app:crm', 'plugin:forms', 'plugin:payroll']);
        expect(alice.body.components!['app:crm']?.ownerName).toBe('Carol');

        const applied = await f.alice<IssueDetail>(`/issues/${number}/triage/apply`, 'POST');
        expect(applied.body.issue.components).toEqual(['app:crm', 'plugin:forms', 'plugin:payroll']);
        expect((await f.bob<IssueDetail>(`/issues/${number}`)).body.issue.components).toEqual(['plugin:forms']);
    });

    it('keeps a reason that names hidden components to admins; the comment and others get fixed text', async () => {
        const f = await fixture();
        await f.store.updateSettings({ autoTriage: { enabled: true, perDay: 100 } });
        await f.platform.start();
        const reason = 'Payroll and Secret CRM fail to save submissions.';
        fakeModel(JSON.stringify({ ...PROPOSAL, reason, components: ['plugin:forms'] }));
        const filed = await f.bob<IssueDetail>('/issues', 'POST', { title: 'Saving a submission breaks' });
        await f.platform.autoTriage.idle();

        const number = filed.body.issue.number;
        const bob = await f.bob<IssueDetail>(`/issues/${number}`);
        expect(bob.body.triage?.reason).toBe(TRIAGE_PUBLIC_REASON);
        expect(bob.body.comments.at(-1)?.body).toContain(`Why: ${TRIAGE_PUBLIC_REASON}`);
        expect(bob.body.triage).not.toHaveProperty('reasonAudience');
        expectNoHiddenNames(bob.text);
        const alice = await f.alice<IssueDetail>(`/issues/${number}`);
        expect(alice.body.triage?.reason).toBe(reason);
        // The shared comment is the same for admins: never the model's words.
        expect(alice.body.comments.at(-1)?.body).not.toContain(reason);
    });

    it('posts the model’s reason as is when it was shown no plugin or app by name', async () => {
        const f = await fixture();
        f.targets.state.plugins = [];
        f.targets.state.apps = [];
        await f.store.updateSettings({ autoTriage: { enabled: true, perDay: 100 } });
        await f.platform.start();
        fakeModel(JSON.stringify({ ...PROPOSAL, components: ['plugins:*'] }));
        const filed = await f.bob<IssueDetail>('/issues', 'POST', { title: 'Saving a submission breaks' });
        await f.platform.autoTriage.idle();
        const bob = await f.bob<IssueDetail>(`/issues/${filed.body.issue.number}`);
        expect(bob.body.triage?.reason).toBe(PROPOSAL.reason);
        expect(bob.body.comments.at(-1)?.body).toContain(`Why: ${PROPOSAL.reason}`);
    });

    it('keeps an app’s suggestion on the generation the model was shown, if its address is reused meanwhile', async () => {
        const f = await fixture();
        await f.store.updateSettings({ autoTriage: { enabled: true, perDay: 100 } });
        await f.platform.start();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                // Deleted and made again at the same address while the model thinks.
                f.targets.deleteApp('crm');
                f.targets.state.apps.push({ id: 'crm', name: 'New CRM', ownerUserId: 'alice', createdAt: 200 });
                return Response.json({
                    choices: [{ message: { content: JSON.stringify({ ...PROPOSAL, components: ['app:crm'] }) } }],
                });
            }),
        );
        const filed = await f.bob<IssueDetail>('/issues', 'POST', { title: 'Saving a submission breaks' });
        await f.platform.autoTriage.idle();
        const issue = (await f.board.issues.require(filed.body.issue.number))!;
        expect((await f.board.triage.get(issue.id))?.components).toEqual(['app:crm@100']);
        const alice = await f.alice<IssueDetail>(`/issues/${filed.body.issue.number}`);
        expect(alice.body.triage?.components).not.toContain('app:crm');
        // Applying never tags the new app with the old one's suggestion.
        const applied = await f.alice<IssueDetail>(`/issues/${filed.body.issue.number}/triage/apply`, 'POST');
        expect(applied.body.issue.components).toEqual([]);
    });
});

describe('prefill from a socio’s conversation', () => {
    const turn = { personId: 'bob', socioId: 'dot-1', conversationId: 'thread-1' };

    it('prefills the one plugin or app the conversation works in, if the person sees it', async () => {
        const f = await fixture();
        f.targets.state.grants.push({ ...turn, audiences: ['plugin:forms'] });
        expect(f.board.components.prefill(turn)).toEqual(['plugin:forms']);
    });

    it('prefills nothing for a hidden target, more than one, or another conversation', async () => {
        const f = await fixture();
        f.targets.state.grants.push({ ...turn, audiences: ['app:crm'] });
        expect(f.board.components.prefill(turn)).toEqual([]);
        f.targets.state.grants.push({ ...turn, audiences: ['plugin:forms', 'app:tracker'] });
        expect(f.board.components.prefill(turn)).toEqual([]);
        expect(f.board.components.prefill({ ...turn, conversationId: 'thread-2' })).toEqual([]);
        expect(f.board.components.prefill({ ...turn, conversationId: null })).toEqual([]);
    });
});

describe('connected agents (MCP)', () => {
    async function agent(f: Awaited<ReturnType<typeof fixture>>, userId: string) {
        const server = agentMcpServer({
            workspace: f.workspace,
            board: f.platform.board,
            actor: {
                grantId: `g-${userId}`,
                clientId: 'https://agent.invalid/client',
                clientName: 'Test agent',
                clientDomain: 'agent.invalid',
                label: 'Test agent',
                userId,
                scopes: ['issues:read', 'issues:write'],
            },
            person: USERS.find((user) => user.id === userId)!,
            origin: 'http://localhost',
        });
        const [client, transport] = InMemoryTransport.createLinkedPair();
        const mcp = new Client({ name: 'test', version: '0.1.0' });
        await Promise.all([server.connect(transport), mcp.connect(client)]);
        cleanup.push(() => mcp.close());
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await mcp.callTool({ name, arguments: args });
            const text = (result.content as Array<{ text: string }>)[0]!.text;
            // oxlint-disable-next-line typescript/no-explicit-any -- tool results are free-form JSON
            const data = result.structuredContent as Record<string, any>;
            return { isError: !!result.isError, data, text };
        };
        const tools = (await mcp.listTools()).tools;
        return { call, tools };
    }

    it('names only the person’s choices, in the tools and in list_issue_components', async () => {
        const f = await fixture();
        const { call, tools } = await agent(f, 'bob');
        expectNoHiddenNames(JSON.stringify(tools));
        const file = tools.find((tool) => tool.name === 'file_issue')!;
        expect(JSON.stringify(file.inputSchema)).toContain('plugin:forms');
        const listed = await call('list_issue_components');
        expect(listed.data.components.map((one: { ref: string }) => one.ref)).toEqual([
            'plugins:*',
            'apps:*',
            'plugin:forms',
            'app:tracker',
        ]);
        // No owner names for agents, as with authors.
        expect(listed.text).not.toContain('"Bob"');
    });

    it('files with components, reads and lists them, and never shows a hidden one', async () => {
        const f = await fixture();
        const { call } = await agent(f, 'bob');
        const filed = await call('file_issue', {
            title: 'Forms drops answers',
            kind: 'bug',
            description: 'Submitting loses the last answer.',
            components: ['plugin:forms'],
            force: true,
        });
        expect(filed.data.outcome).toBe('filed');
        const number = Number(String(filed.data.issue).slice(3));
        const issue = (await f.board.issues.require(number))!;
        // An admin adds a hidden one; the agent still sees only its own.
        await f.board.components.set(issue.id, ['plugin:forms', 'plugin:payroll'], {
            actorId: 'alice',
            viewerId: 'alice',
        });
        const read = await call('read_issue', { issue: filed.data.issue });
        expect(read.data.components).toEqual([{ ref: 'plugin:forms', name: 'Forms' }]);
        expectNoHiddenNames(read.text);
        const listed = await call('list_issues', { component: 'plugin:forms' });
        expect(listed.data.items.map((one: { issue: string }) => one.issue)).toEqual([filed.data.issue]);
        expectNoHiddenNames(listed.text);
        const probed = await call('list_issues', { component: 'plugin:payroll' });
        expect(probed.isError).toBe(true);
        expect(probed.text).toContain('Unknown component');
    });

    it('refuses a hidden or stale ref on filing with the current choices, and members can’t update', async () => {
        const f = await fixture();
        const { call } = await agent(f, 'bob');
        // A long list would be a pattern; a stale client may still send any ref.
        const refused = await call('file_issue', {
            title: 'Payroll late',
            kind: 'bug',
            description: 'x',
            force: true,
            components: ['plugin:payroll'],
        });
        expect(refused.isError).toBe(true);
        expectNoHiddenNames(refused.text.replace('plugin:payroll', ''));
        const issue = await f.tagged([]);
        const update = await call('update_issue', { issue: `CB-${issue.number}`, components: ['plugin:forms'] });
        expect(update.data.outcome).toBe('forbidden');
    });

    it('lets an admin’s agent replace the components they see', async () => {
        const f = await fixture();
        const { call } = await agent(f, 'alice');
        const issue = await f.tagged(['plugin:forms']);
        const updated = await call('update_issue', {
            issue: `CB-${issue.number}`,
            components: ['plugin:payroll', 'app:crm'],
        });
        expect(updated.data).toMatchObject({ outcome: 'updated', components: ['app:crm', 'plugin:payroll'] });
        expect(updated.data.changed).toContain('components');
    });
});

describe('socios’ board tools', () => {
    const turn = (userId = 'bob') => ({
        dotId: 'dot-1',
        userId,
        trigger: 'chat' as const,
        causeId: null,
        threadId: 'thread-1',
    });
    const item = (title: string, extra: Record<string, unknown> = {}) => ({
        title,
        kind: 'bug' as const,
        problem: 'Submitting loses the last answer.',
        fileAnyway: true,
        ...extra,
    });

    it('prefills the plugin the conversation works in, and says so', async () => {
        const f = await fixture();
        f.targets.state.grants.push({
            personId: 'bob',
            socioId: 'dot-1',
            conversationId: 'thread-1',
            audiences: ['plugin:forms'],
        });
        const dot = f.workspace.dots()[0]!;
        f.targets.state.grants[0]!.socioId = dot.id;
        const filed = await f.board.filings.file({ ...turn(), dotId: dot.id }, item('Forms drops answers'));
        expect(filed).toMatchObject({ outcome: 'filed', components: ['plugin:forms'] });
        expect(filed.message).toContain('tell the person');
        // An explicit [] means none.
        const none = await f.board.filings.file(
            { ...turn(), dotId: dot.id },
            item('Something else', { components: [] }),
        );
        expect(none.outcome).toBe('filed');
        expect('components' in none && none.components).toBeFalsy();
    });

    it('refuses a component the person can’t see, filing nothing', async () => {
        const f = await fixture();
        const dot = f.workspace.dots()[0]!;
        const refused = await f.board.filings.file(
            { ...turn(), dotId: dot.id },
            item('Payroll late', { components: ['plugin:payroll'] }),
        );
        expect(refused.outcome).toBe('forbidden');
        expectNoHiddenNames(refused.message.replace('plugin:payroll', ''));
        expect(await f.board.issues.list()).toEqual([]);
    });

    it('lists and reads only the components the person may see', async () => {
        const f = await fixture();
        const issue = await f.tagged(['plugin:forms', 'app:crm']);
        const page = await f.board.filings.list({ component: 'plugin:forms' }, { userId: 'bob' });
        expect(page.items.map((one) => one.components)).toEqual([[{ ref: 'plugin:forms', name: 'Forms' }]]);
        const read = await f.board.filings.item(`CB-${issue.number}`, { userId: 'bob' });
        expect(read.outcome === 'found' && read.components).toEqual([{ ref: 'plugin:forms', name: 'Forms' }]);
        expectNoHiddenNames(JSON.stringify(read));
    });
});

describe('the composition’s sources', () => {
    it('reads plugins, apps, people and live grants of one conversation', () => {
        const now = Date.now();
        const sources = issueComponentSources({
            plugins: {
                list: () => [{ id: 'forms', enabled: true, audience: 'members', manifest: { name: 'Forms' } }] as never,
                get: (id: string) =>
                    id === 'forms' ? ({ id, enabled: true, audience: 'members' } as never) : undefined,
                mayUse: (row, person) => !!row && !!person,
            },
            apps: {
                enabled: true,
                all: () => [{ id: 'crm', name: 'CRM', ownerUserId: 'carol', createdAt: 5 }] as never,
                get: (id: string) => (id === 'crm' ? ({ id, ownerUserId: 'carol' } as never) : undefined),
                access: (userId: string) => (userId === 'carol' ? 'owner' : undefined),
                withDeleted: () =>
                    [
                        { id: 'deleted-1', name: 'Old CRM', ownerUserId: 'bob', createdAt: 1, deletedAt: 2 },
                        { id: 'crm', name: 'CRM', ownerUserId: 'carol', createdAt: 5, deletedAt: null },
                    ] as never,
            } as never,
            people: { users: () => USERS },
            grants: {
                unrevoked: () =>
                    [
                        { conversationId: 't1', expiresAt: now + 60_000, audiences: ['plugin:forms'] },
                        { conversationId: 't2', expiresAt: now + 60_000, audiences: ['app:crm'] },
                        { conversationId: 't1', expiresAt: now - 1, audiences: ['app:crm'] },
                    ] as never,
            },
        });
        expect(sources.plugins()).toEqual([{ id: 'forms', name: 'Forms', enabled: true, audience: 'members' }]);
        expect(sources.mayUsePlugin('forms', 'bob')).toBe(true);
        expect(sources.mayUsePlugin('forms', 'nobody')).toBe(false);
        expect(sources.mayOpenApp('crm', 'carol')).toBe(true);
        expect(sources.mayOpenApp('crm', 'bob')).toBe(false);
        // A retired app is found by its generation; the live one at that address isn't retired.
        expect(sources.retiredApp('crm', 1)).toEqual({ name: 'Old CRM', ownerUserId: 'bob' });
        expect(sources.retiredApp('crm', 5)).toBeUndefined();
        expect(sources.isAdmin('alice')).toBe(true);
        expect(sources.isAdmin('bob')).toBe(false);
        expect(sources.userName('carol')).toBe('Carol');
        // Only live, unexpired grants of this conversation.
        expect(sources.conversationAudiences({ personId: 'bob', socioId: 's', conversationId: 't1' })).toEqual([
            'plugin:forms',
        ]);
    });

    it('binds the real plugins and apps when the app is built', async () => {
        const { platform, dispose } = await makeTestRuntime({
            config: { baseUrl: '', apiKey: '', model: '', runtimeUrl: '' },
        });
        cleanup.push(dispose);
        // Nothing installed and apps off: the wildcards only, for anyone.
        expect(platform.board.components.options('nobody').map((option) => option.ref)).toEqual([
            'plugins:*',
            'apps:*',
        ]);
    });
});
