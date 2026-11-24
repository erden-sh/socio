import { rmSync } from 'node:fs';

import { expect } from 'vitest';

import type { MemoryItem, UserProfile } from '@socio/shared/memory';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { AbortedError, NetworkError } from '../../src/net/errors';
import { memoryWriteKinds } from '../../src/sync/memory-writes';
import { type Outbox, openOutbox } from '../../src/sync/outbox';
import type { ConfirmedChange } from '../../src/sync/snapshot-cache';

import { turns, userDb } from './outbox-fakes';

// A fake Socio server for Memories, whose routes answer as
// src/server/memory/routes.ts does: statuses only, never text; and a phone
// on a real outbox (user.db on node:sqlite) with the memory write kinds. memory-writes.test.ts
// and tests/shell/memories.test.ts use them.

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Script =
    /** The server applies the write, then the connection drops before the answer. */
    | 'drop'
    /** The server applies the write and never answers (the app dies with it in flight). */
    | 'hang'
    /** The request never arrives. */
    | 'offline'
    | { readonly status: number; readonly body?: unknown };

const FIELDS = ['name', 'pronouns', 'role', 'timezone', 'language', 'style', 'instructions'];

export function server() {
    let clock = 1_000;
    const items = new Map<string, MemoryItem & { deleted?: boolean }>();
    let profile: UserProfile | null = null;
    let timeZoneMoved: string | null = null;
    const scripts = new Map<string, Script[]>();
    const log: string[] = [];
    let next = 0;

    const memory = (fields: Partial<MemoryItem> = {}): MemoryItem => {
        clock += 10;
        const item: MemoryItem = {
            id: `mem-${++next}`,
            text: 'A memory',
            createdAt: clock,
            updatedAt: clock,
            status: 'active',
            source: 'person',
            shareable: false,
            dotId: null,
            threadId: null,
            confirmedAt: clock,
            ...fields,
        };
        items.set(item.id, item);
        return item;
    };
    const live = (id: string) => {
        const item = items.get(id);
        return item === undefined || item.deleted ? undefined : item;
    };
    const view = () => {
        const all = [...items.values()].filter((item) => !item.deleted).map(({ deleted: _d, ...item }) => item);
        return {
            profile,
            memories: all.filter((item) => item.status === 'active'),
            proposals: all.filter((item) => item.status === 'proposed'),
            ...(timeZoneMoved ? { timeZoneMoved } : {}),
        };
    };
    const answer = async (key: string, path: string, init: AuthedRequestInit, apply: () => Response) => {
        const scripted = scripts.get(key)?.shift();
        if (scripted === 'offline') {
            throw new NetworkError(path);
        }
        if (scripted === 'drop') {
            apply();
            throw new NetworkError(path);
        }
        if (scripted === 'hang') {
            apply();
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new AbortedError(path, init.signal?.reason)), {
                    once: true,
                });
            });
        }
        if (scripted !== undefined) {
            return json(scripted.status, scripted.body ?? {});
        }
        return apply();
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        const path = new URL(input, 'https://brain.example.test').pathname;
        const body = init.json as Record<string, unknown> | undefined;
        if (path === '/api/memories' && method === 'GET') {
            return answer('GET memories', path, init, () => json(200, view()));
        }
        if (path === '/api/memories' && method === 'POST') {
            return answer('POST memories', path, init, () => {
                const text = typeof body?.text === 'string' ? body.text.trim() : '';
                if (!text) {
                    return json(400, { error: 'Memory must be between 1 and 2,000 characters.' });
                }
                return json(201, memory({ text, shareable: body?.shareable === true }));
            });
        }
        if (path === '/api/memories/profile') {
            if (method === 'PUT') {
                return answer('PUT profile', path, init, () => {
                    const fields = body?.fields as Record<string, string>;
                    expect(Object.keys(fields).every((field) => FIELDS.includes(field))).toBe(true);
                    clock += 10;
                    profile = { fields: { ...fields }, shareable: body?.shareable === true, updatedAt: clock };
                    return json(200, profile);
                });
            }
            return answer('DELETE profile', path, init, () => {
                profile = null;
                return json(200, { ok: true });
            });
        }
        if (path === '/api/memories/time-zone-note/seen') {
            return answer('POST seen', path, init, () => {
                if (body?.zone === timeZoneMoved) {
                    timeZoneMoved = null;
                }
                return json(200, { ok: true });
            });
        }
        const match = /^\/api\/memories\/([^/]+)(?:\/(approve|confirm))?$/.exec(path);
        if (match) {
            const id = decodeURIComponent(match[1]!);
            const action = match[2];
            const key = action ? `POST ${action}` : `${method} memory`;
            return answer(key, path, init, () => {
                const item = live(id);
                if (item === undefined) {
                    return json(404, { error: 'Memory not found.' });
                }
                clock += 10;
                if (method === 'DELETE') {
                    item.deleted = true;
                    return json(200, { ok: true });
                }
                if (action === 'approve' && item.status === 'proposed') {
                    Object.assign(item, { status: 'active', confirmedAt: clock, updatedAt: clock });
                } else if (action === 'confirm' && item.status === 'active') {
                    item.confirmedAt = clock;
                } else if (method === 'PUT') {
                    Object.assign(item, {
                        ...(typeof body?.text === 'string' ? { text: body.text.trim() } : {}),
                        ...(typeof body?.shareable === 'boolean' ? { shareable: body.shareable } : {}),
                        updatedAt: clock,
                    });
                }
                const { deleted: _d, ...shown } = item;
                return json(200, shown);
            });
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        items,
        log,
        memory,
        now: () => clock,
        get profile() {
            return profile;
        },
        set profile(value: UserProfile | null) {
            profile = value;
        },
        moveTimeZone(zone: string | null) {
            timeZoneMoved = zone;
        },
        stored: () => [...items.values()].filter((item) => !item.deleted),
        script(key: string, ...answers: Script[]) {
            scripts.set(key, [...(scripts.get(key) ?? []), ...answers]);
        },
        count: (line: string) => log.filter((entry) => entry === line).length,
    };
}

export type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];

/** Closes every phone `open` made (each test's afterEach). */
export async function closePhones(): Promise<void> {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
}

export interface Phone {
    readonly outbox: Outbox;
    readonly confirmed: ConfirmedChange[];
    readonly pulled: string[];
    settle(): Promise<void>;
    until(done: () => boolean): Promise<void>;
    /** The app dies (requests in flight stop) and opens again on the same user.db. */
    relaunch(): Promise<Phone>;
}

export async function open(srv: Server, files?: Awaited<ReturnType<typeof userDb>>): Promise<Phone> {
    const user = files ?? (await userDb());
    if (!files) {
        cleanups.push(() => rmSync(user.directory, { recursive: true, force: true }));
    }
    const file = await user.open();
    const confirmed: ConfirmedChange[] = [];
    const pulled: string[] = [];
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: memoryWriteKinds({
            cache: { confirm: async (change) => void confirmed.push(change) },
            afterWrite: (path) => pulled.push(path),
        }),
        fetch: srv.fetch,
        random: () => 0,
    });
    let closed = false;
    const close = async () => {
        if (!closed) {
            closed = true;
            await outbox.dispose();
            await file.db.close().catch(() => {});
        }
    };
    cleanups.push(close);
    outbox.start();
    const phone: Phone = {
        outbox,
        confirmed,
        pulled,
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await phone.settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await phone.settle();
            }
        },
        async relaunch() {
            await close();
            return open(srv, user);
        },
    };
    return phone;
}
