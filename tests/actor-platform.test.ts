import { afterEach, expect, it, vi } from 'vitest';

import { accountLifecycle } from '../src/server/auth/accounts.js';

import { makeTestRuntime } from './helpers/test-runtime.js';
import { appPolicy, world } from './support/actor-fixture.js';

// CB-232 on the real platform: dark by default, the workspace's
// and accounts' events end grants, and nothing is delegable until the
// phases that own audiences register them.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup(flags: Record<string, boolean> = {}) {
    const { platform, workspace, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'actor-platform-secret-0123456789ab',
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: flags,
        },
    });
    cleanup.push(dispose);
    for (const user of [
        { id: 'alice', name: 'Alice', role: 'member' as const },
        { id: 'olga', name: 'Olga', role: 'admin' as const },
    ]) {
        workspace.recordUser(user);
    }
    const socio = workspace.dots()[0]!;
    const chat = workspace.bindThread('chat-1', socio.id, 'Pipeline', 'alice');
    const grant = () =>
        platform.actors.grants.create({
            personId: 'alice',
            socioId: socio.id,
            audiences: ['app:crm'],
            scopes: ['app:read'],
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Check the chart',
            policyVersion: 'v1',
            approvedBy: 'alice',
            correlationId: 'c',
        });
    return { platform, workspace, socio, chat, grant };
}

it('ships dark: the flags are off and their tools hidden', async () => {
    const f = await setup();
    for (const key of ['socio-actor-access', 'coding-sessions', 'repo-extraction'] as const) {
        expect(f.platform.flags.enabled(key, 'alice')).toBe(false);
    }
    const off = f.platform.flags.toolsOff('alice');
    for (const tool of ['request_app_access', 'app_snapshot', 'coding_start', 'repo_extract']) {
        expect(off.has(tool)).toBe(true);
    }
    const grant = await f.grant();
    expect(await f.platform.actors.authorizer.authorizeGrant(grant.id)).toEqual({
        allowed: false,
        reason: 'feature_off',
    });
});

it('delegates nothing until an audience policy is registered', async () => {
    const f = await setup({ 'socio-actor-access': true });
    const grant = await f.grant();
    expect(await f.platform.actors.authorizer.authorizeGrant(grant.id)).toEqual({
        allowed: false,
        reason: 'audience_unavailable',
    });
    // What the apps module does from AppsService (its `actors` option).
    const remove = f.platform.actors.audiences.register('app', appPolicy(world()));
    cleanup.push(remove);
    expect(
        await f.platform.actors.authorizer.authorizeGrant(grant.id, {
            fresh: true,
        }),
    ).toEqual({ allowed: true });
});

it('ends grants when the socio is archived, the chat archived or the person deactivated', async () => {
    const f = await setup({ 'socio-actor-access': true });
    cleanup.push(f.platform.actors.audiences.register('app', appPolicy(world())));
    const { actors } = f.platform;
    // The socio archived.
    const first = await f.grant();
    f.workspace.archiveDot(f.socio.id, 'olga');
    await vi.waitFor(() =>
        expect(actors.grants.get(first.id)).toMatchObject({
            revokeReason: 'socio_unavailable',
        }),
    );
    f.workspace.unarchiveDot(f.socio.id, 'olga');
    // The chat archived.
    const second = await f.grant();
    f.workspace.setArchived(f.chat.id, true, 'alice');
    await vi.waitFor(() =>
        expect(actors.grants.get(second.id)).toMatchObject({
            revokeReason: 'conversation_gone',
        }),
    );
    f.workspace.setArchived(f.chat.id, false, 'alice');
    // The person deactivated (accounts.ts), recorded in the workspace audit.
    const third = await f.grant();
    // The deactivation preview (CB-360) counts what it would end.
    expect(actors.personGrantCount('alice')).toBe(1);
    await accountLifecycle(f.platform)({
        action: 'deactivate',
        userId: 'alice',
        name: 'Alice',
        by: 'olga',
    });
    expect(actors.grants.get(third.id)).toMatchObject({
        revokeReason: 'person_deactivated',
        revokedBy: 'olga',
    });
    expect(actors.personGrantCount('alice')).toBe(0);
    expect(f.workspace.auditOf('user', 'alice').at(-1)?.detail).toContain('ended 1 socio access grant(s)');
    expect(actors.audit.list({ personId: 'alice' }).filter((row) => row.phase === 'revoke')).toHaveLength(3);
});

it('re-checks a person’s grants when their role changes', async () => {
    const f = await setup({ 'socio-actor-access': true });
    const opens = new Set(['alice']);
    cleanup.push(
        f.platform.actors.audiences.register('app', {
            policyVersion: () => 'v1',
            personMay: (personId) => opens.has(personId),
        }),
    );
    const grant = await f.grant();
    opens.delete('alice');
    f.workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    await vi.waitFor(() =>
        expect(f.platform.actors.grants.get(grant.id)).toMatchObject({
            revokeReason: 'access_changed',
        }),
    );
});
