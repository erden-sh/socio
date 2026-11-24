import { afterEach, expect, it, vi } from 'vitest';

import { REPO, codingWorld, eventually } from './support/coding-fixture.js';

// CB-239: `coding_open_pr` calls coding-git's `openSessionPullRequest`
// (draft only, from the session branch into its base; `openPullRequest`
// over the runtime's gateways, through `CodingGateway`) with the session's
// own grant and the turn's person and socio, and records the PR on the
// session. coding-git's own tests cover the PR against a GitHub fake.

const opened = vi.hoisted(() => ({
    calls: [] as Array<Record<string, unknown>>,
}));
vi.mock('../src/server/gateway/pulls.js', () => ({
    openPullRequest: vi.fn(async (_sources: unknown, input: Record<string, unknown>) => {
        opened.calls.push(input);
        return {
            number: 42,
            url: 'https://github.com/erden-sh/socio/pull/42',
            draft: true,
        };
    }),
}));

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    opened.calls.length = 0;
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup() {
    const world = await codingWorld();
    cleanup.push(() => world.close());
    vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({
        text: '',
    } as never);
    return world;
}

it('refuses a pull request from a read-only session, before calling GitHub', async () => {
    const world = await setup();
    const { session } = await world.started({ push: false });
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    expect(await world.tool('coding_open_pr')({ title: 'Fix', summary: 'Done' })).toMatchObject({ status: 'refused' });
    expect(opened.calls).toEqual([]);
});

it('opens a draft through coding-git with the session’s grant, and keeps its link on the session', async () => {
    const world = await setup();
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    const answer = await world.tool('coding_open_pr')({
        title: 'Make the flaky test wait',
        summary: 'It waits for the server now.',
    });
    expect(answer).toMatchObject({
        status: 'opened',
        pullRequest: {
            number: 42,
            url: 'https://github.com/erden-sh/socio/pull/42',
            draft: true,
        },
    });
    expect(opened.calls).toEqual([
        expect.objectContaining({
            grantId: session!.grantId,
            personId: 'alice',
            socioId: world.socio.id,
            title: 'Make the flaky test wait',
            summary: 'It waits for the server now.',
            sessionLink: `https://socio.example/chats/${encodeURIComponent(session!.threadId)}`,
        }),
    ]);
    expect(world.service.view(world.service.sessions.get(session!.id)!).pullRequest).toEqual({
        number: 42,
        url: 'https://github.com/erden-sh/socio/pull/42',
    });
    // Nothing in the link or the call names the person.
    expect(JSON.stringify(opened.calls)).not.toMatch(/Alice|alice@/);
    expect(REPO).toBe('erden-sh/socio');
});
