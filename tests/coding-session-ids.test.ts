import { afterEach, expect, it, vi } from 'vitest';

// CB-239: a session's short id is unique per repository. The short ids the server draws are
// fixed here, so a row that already holds the next one is met for sure.
const queued: string[] = [];
vi.mock('node:crypto', async (original) => {
    const crypto = await original<typeof import('node:crypto')>();
    return {
        ...crypto,
        randomBytes: ((size: number, ...rest: unknown[]) =>
            size === 4 && queued.length && !rest.length
                ? Buffer.from(queued.shift()!, 'hex')
                : (crypto.randomBytes as (...args: unknown[]) => unknown)(size, ...rest)) as typeof crypto.randomBytes,
    };
});

const { codingWorld, eventually, REPO } = await import('./support/coding-fixture.js');

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    queued.length = 0;
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('draws another short id when a row already holds the next one, and never makes a duplicate', async () => {
    const world = await codingWorld();
    cleanup.push(() => world.close());
    vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({
        text: 'Noted.',
    } as never);
    // A row from before (a restored database, the other runtime) holds
    // `abcdef01` in this repository, ended long ago.
    world.connection
        .prepare(
            `INSERT INTO coding_sessions(id, personId, socioId, threadId, conversationKind, repository, repositoryKey, base, branch, shortId, model, push, volumeKey, opencodeSession, state, createdAt, endsAt, lastPromptAt)
       VALUES ('old-session', 'bob', ?, 't', 'private', ?, ?, 'main', 'socio/other/abcdef01', 'abcdef01', 'orion', 1, ?, 'ses_old', 'ended', 1, 2, 1)`,
        )
        .run(world.socio.id, REPO, REPO.toLowerCase(), 'c'.repeat(64));
    queued.push('abcdef01', 'abcdef01', '12345678');
    const { decided, session } = await world.started();
    expect(decided.status).toBe('approved');
    expect(session).toMatchObject({
        shortId: '12345678',
        branch: 'socio/rulo/12345678',
    });
    expect(queued).toEqual([]);
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    expect(
        world.connection
            .prepare(
                'SELECT shortId, count(*) AS n FROM coding_sessions WHERE repositoryKey=? GROUP BY shortId ORDER BY shortId',
            )
            .all(REPO.toLowerCase()),
    ).toEqual([
        { shortId: '12345678', n: 1 },
        { shortId: 'abcdef01', n: 1 },
    ]);
    // Every draw taken: the start fails clearly, with nothing made.
    await world.tool('coding_stop')({});
    queued.push(...Array(5).fill('12345678'));
    const again = await world.started();
    expect(again.decided.status).toBe('failed');
    expect(again.decided.outcome).toContain('No free session branch name');
    expect(again.session).toBeUndefined();
});
