import { describe, expect, it } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    deleteAllEpisodes,
    deleteEpisode,
    EPISODE_DELETE_FALLBACK,
    episodeDeleteCopy,
    episodesPath,
    readEpisodes,
} from '../../src/sync/memory-episodes';

// Memories' episodes: read online,
// deleted online only, never queued or sent again, against a fake fetch
// that answers as src/server/memory/routes.ts does.

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(answer: (method: string, path: string) => Response | 'drop') {
    const log: string[] = [];
    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        const result = answer(method, input);
        if (result === 'drop') {
            throw new NetworkError(input);
        }
        return result;
    };
    return { fetch, log };
}

const EPISODE = {
    id: 'ep-1',
    kind: 'fact',
    label: 'Decision',
    text: 'We ship on Fridays',
    dotId: 'd1',
    threadId: 'c1',
    occurredAt: 10,
    createdAt: 5,
};

describe('reading episodes', () => {
    it('asks the episodes, or the trimmed search, and checks the body', async () => {
        expect(episodesPath('  ')).toBe('/api/memories/episodes');
        expect(episodesPath(' ship & go ')).toBe('/api/memories/episodes?q=ship%20%26%20go');
        expect(episodesPath('x'.repeat(400))).toBe(`/api/memories/episodes?q=${'x'.repeat(300)}`);
        const server = fake(() => json(200, { episodes: [EPISODE], total: 4, retentionDays: 90 }));
        await expect(readEpisodes(server.fetch, 'ship')).resolves.toEqual({
            episodes: [EPISODE],
            total: 4,
            retentionDays: 90,
        });
        expect(server.log).toEqual(['GET /api/memories/episodes?q=ship']);
    });

    it('rejects a refusal, no answer and another body', async () => {
        await expect(readEpisodes(fake(() => json(400)).fetch, '')).rejects.toThrow(/400/);
        await expect(readEpisodes(fake(() => 'drop').fetch, '')).rejects.toThrow(NetworkError);
        await expect(
            readEpisodes(fake(() => json(200, { episodes: [{ id: 1 }], total: 1, retentionDays: 9 })).fetch, ''),
        ).rejects.toThrow(/something else/);
    });
});

describe('deleting episodes, online only', () => {
    it('offline: refused before any request, with "Needs a connection", one and all alike', async () => {
        const server = fake(() => json(200, { ok: true }));
        const one = await deleteEpisode({ fetch: server.fetch, connected: false }, 'ep-1');
        const all = await deleteAllEpisodes({ fetch: server.fetch, connected: false });
        expect([one, all]).toEqual([{ outcome: 'offline' }, { outcome: 'offline' }]);
        expect(episodeDeleteCopy(one)).toBe('Needs a connection');
        expect(server.log).toEqual([]);
    });

    it('online: one DELETE each; a gone episode is done, a gone "all" is not', async () => {
        const server = fake((method, path) => (path.endsWith('/ep-gone') ? json(404) : json(200, { ok: true })));
        expect(await deleteEpisode({ fetch: server.fetch, connected: true }, 'ep/1')).toEqual({ outcome: 'done' });
        expect(await deleteEpisode({ fetch: server.fetch, connected: null }, 'ep-gone')).toEqual({ outcome: 'done' });
        expect(await deleteAllEpisodes({ fetch: server.fetch, connected: true })).toEqual({ outcome: 'done' });
        expect(server.log).toEqual([
            'DELETE /api/memories/episodes/ep%2F1',
            'DELETE /api/memories/episodes/ep-gone',
            'DELETE /api/memories/episodes',
        ]);
        expect(await deleteAllEpisodes({ fetch: fake(() => json(404)).fetch, connected: true })).toEqual({
            outcome: 'refused',
            reason: 'http-404',
        });
    });

    it('no answer is never sent again by itself; a refusal is worded by status', async () => {
        const dropped = fake(() => 'drop');
        const result = await deleteAllEpisodes({ fetch: dropped.fetch, connected: true });
        expect(result).toEqual({ outcome: 'no-answer' });
        expect(dropped.log).toHaveLength(1);
        expect(episodeDeleteCopy(result)).toMatch(/^No answer/);
        const refused = await deleteEpisode({ fetch: fake(() => json(500)).fetch, connected: true }, 'ep-1');
        expect(episodeDeleteCopy(refused)).toBe(EPISODE_DELETE_FALLBACK);
        expect(episodeDeleteCopy({ outcome: 'done' })).toBeNull();
    });
});
