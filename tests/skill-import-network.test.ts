import { EventEmitter } from 'node:events';
import https from 'node:https';
import { PassThrough } from 'node:stream';

import { afterEach, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup }));
import { readGitHubSkillJson } from '../src/server/skills/github-import.js';

afterEach(() => {
    vi.restoreAllMocks();
    lookup.mockReset();
});
const url = new URL('https://api.github.com/repos/example/skills/commits/main');
function transport({
    status = 200,
    type = 'application/json; charset=utf-8',
    encoding = 'identity',
    body = '{"ok":true}',
} = {}) {
    lookup.mockResolvedValue([{ address: '140.82.112.6', family: 4 }]);
    return vi.spyOn(https, 'get').mockImplementation(((
        requested: URL,
        options: {
            headers: Record<string, string>;
            agent: https.Agent;
            rejectUnauthorized: boolean;
            lookup: (host: string, settings: unknown, callback: (...args: unknown[]) => void) => void;
        },
        callback: (response: unknown) => void,
    ) => {
        expect(requested.hostname).toBe('api.github.com');
        expect(options.headers).not.toHaveProperty('Authorization');
        expect(options.headers['Accept-Encoding']).toBe('identity');
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.agent).toBeInstanceOf(https.Agent);
        expect(options.agent).not.toBe(https.globalAgent);
        expect(options.agent.options.rejectUnauthorized).toBe(true);
        const pinned = vi.fn();
        options.lookup('api.github.com', { all: false }, pinned);
        expect(pinned).toHaveBeenCalledWith(null, '140.82.112.6', 4);
        const request = new EventEmitter();
        queueMicrotask(() => {
            const response = new PassThrough() as PassThrough & {
                statusCode: number;
                headers: Record<string, string>;
            };
            response.statusCode = status;
            response.headers = {
                'content-type': type,
                'content-encoding': encoding,
                location: 'http://127.0.0.1/private',
            };
            callback(response);
            response.end(body);
        });
        return request;
    }) as typeof https.get);
}

it('pins public DNS and performs bounded credential-free identity requests', async () => {
    const get = transport();
    expect(await readGitHubSkillJson(url, 100, new AbortController().signal)).toEqual({
        value: { ok: true },
        bytes: 11,
    });
    expect(get).toHaveBeenCalledTimes(1);
});

it('refuses arbitrary hosts and any private address without connecting', async () => {
    const get = transport();
    for (const value of [
        'http://api.github.com/path',
        'https://api.github.com.evil/path',
        'https://token@api.github.com/path',
        'https://api.github.com:444/path',
    ]) {
        await expect(readGitHubSkillJson(new URL(value), 100, new AbortController().signal)).rejects.toThrow(
            /public GitHub API/,
        );
    }
    lookup.mockResolvedValue([
        { address: '140.82.112.6', family: 4 },
        { address: '127.0.0.1', family: 4 },
    ]);
    await expect(readGitHubSkillJson(url, 100, new AbortController().signal)).rejects.toThrow(/public network/);
    expect(get).not.toHaveBeenCalled();
});

it('does not follow redirects or accept compressed/non-JSON/oversized responses', async () => {
    for (const scenario of [{ status: 302 }, { status: 404 }, { encoding: 'gzip' }, { type: 'text/html' }]) {
        const get = transport(scenario);
        await expect(readGitHubSkillJson(url, 100, new AbortController().signal)).rejects.toThrow(
            /redirects, compressed content and non-JSON/,
        );
        expect(get).toHaveBeenCalledTimes(1);
        get.mockRestore();
    }
    transport({ body: 'x'.repeat(101) });
    await expect(readGitHubSkillJson(url, 100, new AbortController().signal)).rejects.toThrow(/size limit/);
});

it('bounds a stalled DNS lookup by the same abort signal', async () => {
    const get = transport();
    lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const request = readGitHubSkillJson(url, 100, controller.signal);
    controller.abort(Error('Import deadline reached'));
    await expect(request).rejects.toThrow('Import deadline reached');
    expect(get).not.toHaveBeenCalled();
});
