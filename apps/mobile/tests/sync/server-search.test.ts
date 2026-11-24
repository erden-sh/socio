import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { createServerSearch, searchesServer, SEARCH_DELAY_MS, SEARCH_KEEP } from '../../src/sync/server-search';

// Search's server half, under Node with a fake fetch and hand-run timers.

interface Asked {
    readonly url: string;
    readonly signal: AbortSignal;
    answer(status: number, body: unknown): void;
    fail(error: unknown): void;
}

function harness(space?: string) {
    const asked: Asked[] = [];
    const fetch: AuthedFetch = (url, init) =>
        new Promise((resolve, reject) => {
            const signal = init!.signal!;
            signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            asked.push({
                url,
                signal,
                answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
                fail: reject,
            });
        });
    const timers = new Map<number, { run: () => void; ms: number }>();
    let next = 0;
    const search = createServerSearch({
        fetch,
        ...(space === undefined ? {} : { space }),
        setTimer: (run, ms) => {
            timers.set(++next, { run, ms });
            return next;
        },
        clearTimer: (id) => timers.delete(id as number),
    });
    const fire = () => {
        const due = [...timers.values()];
        timers.clear();
        for (const timer of due) {
            timer.run();
        }
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const answerAll = async (pages: unknown, numbers: number[]) => {
        for (const a of asked.splice(0)) {
            a.answer(200, a.url.startsWith('/api/spaces/search') ? pages : { numbers });
        }
        await settle();
    };
    return { asked, timers, search, fire, settle, answerAll };
}

const PAGES = { query: 'x', corrected: null, results: [], more: false };

describe('a Space library’s search (the PWA comparison’s 4.2)', () => {
    it('asks only for the Space’s pages, as the web’s library does, never the issues', async () => {
        const { search, asked, fire, answerAll } = harness('sp 1');
        search.search('roadmap', false);
        fire();
        expect(asked.map((a) => a.url)).toEqual(['/api/spaces/search?q=roadmap&space=sp%201&limit=20']);
        await answerAll(PAGES, []);
        expect(search.state()).toEqual({
            status: 'done',
            answer: { query: 'roadmap', pages: PAGES, issues: null },
        });
    });

    it('is offline when the page search gets no answer', async () => {
        const { search, asked, fire, settle } = harness('sp1');
        search.search('roadmap', false);
        fire();
        asked.splice(0)[0]!.fail(new NetworkError('gone'));
        await settle();
        expect(search.state()).toEqual({ status: 'offline', query: 'roadmap' });
    });
});

describe('Search’s server half', () => {
    it('asks only from two characters, spaces and case not counted', () => {
        expect(searchesServer('a')).toBe(false);
        expect(searchesServer(' a ')).toBe(false);
        expect(searchesServer('a b')).toBe(true);
        expect(searchesServer('ab')).toBe(true);
        const { search, timers } = harness();
        search.search('a', false);
        expect(search.state()).toEqual({ status: 'idle' });
        expect(timers.size).toBe(0);
        search.search('ab', false);
        expect(search.state()).toEqual({ status: 'waiting', query: 'ab' });
        expect([...timers.values()][0]?.ms).toBe(SEARCH_DELAY_MS);
        search.search('a', false);
        expect(search.state()).toEqual({ status: 'idle' });
        expect(timers.size).toBe(0);
    });

    it('asks for pages and issues together after the wait, and answers with both', async () => {
        const { search, asked, fire, answerAll } = harness();
        search.search('Déploy  plan', false);
        expect(asked).toHaveLength(0);
        fire();
        expect(asked.map((a) => a.url).sort()).toEqual([
            '/api/issues/search?q=D%C3%A9ploy%20%20plan',
            '/api/spaces/search?q=D%C3%A9ploy%20%20plan',
        ]);
        await answerAll(PAGES, [4, 2]);
        expect(search.state()).toEqual({
            status: 'done',
            answer: { query: 'deploy plan', pages: PAGES, issues: [4, 2] },
        });
    });

    it('aborts the request in flight on each keystroke, so an older answer never shows', async () => {
        const { search, asked, fire, settle, answerAll } = harness();
        const changes: string[] = [];
        search.subscribe(() => changes.push(search.state().status));
        search.search('dep', false);
        fire();
        const first = asked.splice(0);
        search.search('depl', false);
        expect(first.every((a) => a.signal.aborted)).toBe(true);
        first[0]!.answer(200, PAGES);
        await settle();
        expect(search.state()).toEqual({ status: 'waiting', query: 'depl' });
        fire();
        await answerAll(PAGES, [1]);
        expect(search.state()).toMatchObject({ status: 'done', answer: { query: 'depl' } });
        expect(changes).toEqual(['waiting', 'waiting', 'done']);
    });

    it('keeps the last answers, so going back asks nothing', async () => {
        const { search, asked, fire, answerAll } = harness();
        for (let i = 0; i <= SEARCH_KEEP; i++) {
            search.search(`q${i}`, false);
            fire();
            await answerAll(PAGES, [i]);
        }
        search.search('q20', false);
        expect(search.state()).toMatchObject({ status: 'done', answer: { issues: [20] } });
        search.search('q0', false);
        expect(search.state()).toEqual({ status: 'waiting', query: 'q0' });
        fire();
        expect(asked).toHaveLength(2);
    });

    it('forgets the kept answers when the field empties or Search loses focus, so they never go stale', async () => {
        const { search, asked, fire, answerAll } = harness();
        search.search('deploy', false);
        fire();
        await answerAll(PAGES, [1]);
        // Emptied: the same text asks again.
        search.search('', false);
        expect(search.state()).toEqual({ status: 'idle' });
        search.search('deploy', false);
        expect(search.state()).toEqual({ status: 'waiting', query: 'deploy' });
        fire();
        expect(asked).toHaveLength(2);
        await answerAll(PAGES, [2]);
        // Blurred: the same text asks again on the next visit, and what was in flight stops.
        search.forget();
        search.search('deploy', false);
        expect(search.state()).toEqual({ status: 'waiting', query: 'deploy' });
        search.forget();
        fire();
        expect(asked).toHaveLength(0);
        // Short text (one character) keeps them: backspacing to it isn't emptying the field.
        search.search('deploy', false);
        fire();
        await answerAll(PAGES, [3]);
        search.search('d', false);
        search.search('deploy', false);
        expect(search.state()).toMatchObject({ status: 'done', answer: { issues: [3] } });
        const screen = readFileSync(new URL('../../src/screens/search.tsx', import.meta.url), 'utf8');
        expect(screen).toContain('useFocusEffect(useCallback(() => () => server.forget(), [server]));');
    });

    it('asks nothing offline, and says offline when no answer comes', async () => {
        const { search, asked, timers, fire, settle } = harness();
        search.search('deploy', true);
        expect(search.state()).toEqual({ status: 'offline', query: 'deploy' });
        expect(timers.size).toBe(0);
        search.search('deploy', false);
        fire();
        for (const a of asked.splice(0)) {
            a.fail(new NetworkError(a.url));
        }
        await settle();
        expect(search.state()).toEqual({ status: 'offline', query: 'deploy' });
    });

    it('keeps the half that answered when the other is refused, and nothing on two refusals', async () => {
        const { search, asked, fire, settle } = harness();
        search.search('deploy', false);
        fire();
        for (const a of asked.splice(0)) {
            if (a.url.startsWith('/api/spaces')) {
                a.answer(500, { error: 'boom' });
            } else {
                a.answer(200, { numbers: [3] });
            }
        }
        await settle();
        expect(search.state()).toEqual({ status: 'done', answer: { query: 'deploy', pages: null, issues: [3] } });
        search.search('other', false);
        fire();
        for (const a of asked.splice(0)) {
            a.answer(403, {});
        }
        await settle();
        expect(search.state()).toEqual({ status: 'done', answer: { query: 'other', pages: null, issues: null } });
    });

    it('stops everything on dispose', () => {
        const { search, asked, timers, fire } = harness();
        search.search('deploy', false);
        fire();
        search.search('deploys', false);
        search.dispose();
        expect(timers.size).toBe(0);
        expect(asked.every((a) => a.signal.aborted)).toBe(true);
        search.search('again', false);
        expect(timers.size).toBe(0);
    });
});
