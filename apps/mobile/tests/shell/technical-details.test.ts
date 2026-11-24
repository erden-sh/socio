import { afterEach, describe, expect, it } from 'vitest';

import {
    ago,
    CODING_PATH,
    COMPUTERS_PATH,
    type DetailGroup,
    laneGroups,
    NEVER,
    NONE,
    pulledLine,
    pushRows,
    refreshLine,
    syncGroups,
    versionRows,
    webLinks,
} from '../../src/shell/technical-details';
import type { UnsentWrite } from '../../src/sync/outbox';
import type { PendingWrite } from '../../src/sync/pending';
import { SHELL_SNAPSHOTS } from '../../src/sync/shell';
import { NO_SERVER_VERSIONS } from '../../src/sync/versions';
import { conversation, syncSetup } from '../sync/helpers';

// Technical details: Advanced
// mode's versions, each snapshot source's pull, cursor and ETag from a cache
// pulled from the fake server, each outbox lane's rows, attempts and last
// error, and the web links only where the web lists them.

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Setup[] = [];
afterEach(async () => {
    for (const s of open.splice(0)) {
        await s.close().catch(() => {});
    }
});

/** A group's rows as label → value. */
const values = (group: DetailGroup) => Object.fromEntries(group.rows.map((row) => [row.label, row.value]));

const write = (over: Partial<PendingWrite> & Pick<PendingWrite, 'id' | 'lane'>): PendingWrite => ({
    kind: 'chat-message',
    payload: '{}',
    payloadVersion: 1,
    dependsOn: null,
    state: 'queued',
    attempts: 0,
    createdAt: 1,
    lastError: null,
    ...over,
});

const refused = (id: string, lane: string, reason: string): UnsentWrite => ({
    id,
    kind: 'chat-message',
    lane,
    dependsOn: null,
    payload: '{}',
    payloadVersion: 1,
    reason,
    createdAt: 1,
});

describe('how long ago', () => {
    it('reads in whole units on the device clock', () => {
        expect(ago(1000, 1500)).toBe('Just now');
        expect(ago(0, 12_000)).toBe('12 s ago');
        expect(ago(0, 3 * 60_000 + 59_000)).toBe('3 min ago');
        expect(ago(0, 2 * 3_600_000)).toBe('2 h ago');
        expect(ago(0, 4 * 86_400_000)).toBe('4 d ago');
        // A clock stepped back is never "in" the future.
        expect(ago(5000, 0)).toBe('Just now');
    });

    it('says Never before the first answer, else how long ago and the exact time', () => {
        expect(pulledLine(null, 0)).toBe(NEVER);
        expect(pulledLine(Date.UTC(2026, 10, 8, 12), Date.UTC(2026, 10, 8, 12, 0, 12))).toBe(
            '12 s ago · 2026-11-08T12:00:00.000Z',
        );
    });
});

describe('the sync groups', () => {
    it('show each shell source as Never, with no cursor, before its first answer', async () => {
        const s = await syncSetup();
        open.push(s);
        const groups = syncGroups(s.cache, SHELL_SNAPSHOTS, s.clock.device());
        expect(groups.map((group) => group.title)).toEqual(['/api/state', '/api/workspace']);
        expect(values(groups[0]!)).toMatchObject({ 'Last pull': NEVER, Cursor: NONE, ETag: NONE });
    });

    it("show each source's last pull, cursor, ETag, server version and the rows it feeds after a pull", async () => {
        const s = await syncSetup();
        open.push(s);
        s.server.change('workspace', (data) => {
            data.conversations = [conversation('c1', 'Kickoff', 30), conversation('c2', 'Plan', 40)];
            data.archived = [];
        });
        await s.state.pull('', null);
        await s.workspace.pull('', null);
        const pulledAt = s.clock.device();
        s.clock.server += 12_000;
        const [state, workspace] = syncGroups(s.cache, SHELL_SNAPSHOTS, s.clock.device());
        const stateMeta = s.cache.meta(SHELL_SNAPSHOTS[0]!)!;
        expect(stateMeta.etag).not.toBeNull();
        expect(values(state!)).toMatchObject({
            'Last pull': `12 s ago · ${new Date(pulledAt).toISOString()}`,
            Cursor: stateMeta.etag,
            ETag: stateMeta.etag,
            Format: String(SHELL_SNAPSHOTS[0]!.format),
        });
        expect(values(workspace!)).toMatchObject({ 'conversations rows': '2' });
        // Cursors and ETags are copyable; a missing value never is.
        expect(state!.rows.find((row) => row.label === 'ETag')?.copy).toBe(true);
        expect(state!.rows.find((row) => row.label === 'Last pull')?.copy).toBe(false);
    });

    it('show a stored format other than the build’s, whose cursor the cache then withholds', () => {
        const definition = SHELL_SNAPSHOTS[0]!;
        const cache = {
            meta: () => ({
                cursor: 'W/"a"',
                etag: 'W/"a"',
                serverVersion: '0.40.0',
                schemaVersion: definition.format + 1,
                syncedAt: 0,
            }),
            cursor: () => null,
            rows: () => new Map(),
        };
        const [group] = syncGroups(cache, [definition], 0);
        expect(values(group!)).toMatchObject({
            Cursor: NONE,
            ETag: 'W/"a"',
            'Pulled under': '0.40.0',
            Format: `${definition.format + 1} (this build ${definition.format})`,
        });
    });
});

describe('the outbox lanes', () => {
    it('list each lane by name with its rows by state, its head, attempts and the head’s last error', () => {
        const groups = laneGroups(
            [
                write({ id: 'b', lane: 'chat:c1', state: 'queued', createdAt: 3 }),
                write({
                    id: 'a',
                    lane: 'chat:c1',
                    state: 'inflight',
                    attempts: 3,
                    createdAt: 2,
                    lastError: 'http-503',
                }),
                write({ id: 'r', lane: 'conversation:c1', kind: 'chat-update', attempts: 1, lastError: 'network' }),
            ],
            [],
        );
        expect(groups.map((group) => group.title)).toEqual(['chat:c1', 'conversation:c1']);
        expect(values(groups[0]!)).toEqual({
            Rows: '2 (1 inflight, 1 queued)',
            Head: 'chat-message · 3 attempts',
            Attempts: '3',
            'Last error': 'http-503',
            Unsent: '0',
        });
        expect(values(groups[1]!)).toMatchObject({ Head: 'chat-update · 1 attempts', 'Last error': 'network' });
    });

    it('take the newest error behind a head that has none', () => {
        const [group] = laneGroups(
            [
                write({ id: 'a', lane: 'l', createdAt: 1 }),
                write({ id: 'b', lane: 'l', createdAt: 2, lastError: 'old' }),
                write({ id: 'c', lane: 'l', createdAt: 3, lastError: 'new' }),
            ],
            [],
        );
        expect(values(group!)['Last error']).toBe('new');
    });

    it('show what the server refused in a lane, by its codes, a lane with nothing queued included', () => {
        const groups = laneGroups(
            [write({ id: 'a', lane: 'chat:c1' })],
            [refused('x', 'chat:c1', 'http-413'), refused('y', 'chat:c2', 'gone'), refused('z', 'chat:c2', 'gone')],
        );
        expect(values(groups[0]!).Unsent).toBe('1 (http-413)');
        expect(values(groups[1]!)).toMatchObject({ Rows: '0', Head: NONE, 'Last error': NONE, Unsent: '2 (gone)' });
    });

    it('are none with nothing queued and nothing refused', () => {
        expect(laneGroups([], [])).toEqual([]);
    });
});

describe('the versions', () => {
    const build = { appVersion: '0.1.0', variant: 'preview', platform: 'Android', osVersion: '16' };

    it("show this build's, the server's, the gate and user.db's", () => {
        const rows = versionRows(
            build,
            { ...NO_SERVER_VERSIONS, serverVersion: '0.41.0', lastVersion: '0.41.0', versionGate: 'open' },
            '0.32.0',
            { version: 4, writable: true },
        );
        expect(Object.fromEntries(rows.map((row) => [row.label, row.value]))).toEqual({
            App: '0.1.0 (preview)',
            Phone: 'Android 16',
            Server: '0.41.0',
            'Last reported': '0.41.0',
            'Minimum server': '0.32.0',
            'Version gate': 'open',
            'user.db': 'v4',
        });
    });

    it('show a rollback candidate, an undecided gate and a read-only user.db', () => {
        const rows = versionRows(
            build,
            { ...NO_SERVER_VERSIONS, serverVersion: '0.41.0', lowerVersion: '0.40.0', lowerSince: 0 },
            '0.32.0',
            { version: 9, writable: false },
        );
        const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
        expect(byLabel['Lower since']).toBe('0.40.0 · 1970-01-01T00:00:00.000Z');
        expect(byLabel['Version gate']).toBe('undecided');
        expect(byLabel['user.db']).toBe('v9 (read-only)');
    });
});

describe('the web links', () => {
    const user = (role: 'member' | 'admin' | 'operator') => ({ id: 'u', name: 'Ada', role }) as never;

    it('are none for a member, or before the workspace row comes', () => {
        expect(webLinks(null)).toEqual([]);
        expect(webLinks({ user: user('member'), flags: { on: ['coding-sessions'] } })).toEqual([]);
    });

    it("give an admin the computers, and coding sessions only while the web's flag is on", () => {
        expect(webLinks({ user: user('admin'), flags: { on: [] } }).map((link) => link.path)).toEqual([COMPUTERS_PATH]);
        expect(
            webLinks({ user: user('operator'), flags: { on: ['coding-sessions'] } }).map((link) => link.path),
        ).toEqual([CODING_PATH, COMPUTERS_PATH]);
    });
});

describe('the Push section', () => {
    const NOW = 1_800_000_000_000;
    it('shows the status, the registration, the last keepalive and the push key’s first characters', () => {
        const rows = pushRows(
            { kind: 'subscribed', subscriptionId: 'sub-1' },
            { registrationId: 'reg-1', pushKey: 'BPushKeyAbcdefghijklmnop' },
            { at: NOW - 3 * 60_000, answer: 'done' },
            NOW,
        );
        expect(rows.map((row) => [row.label, row.value])).toEqual([
            ['Push', 'Subscribed'],
            ['Subscription', 'sub-1'],
            ['Relay registration', 'Registered'],
            ['Last keepalive', '3 min ago · OK'],
            ['Push key', 'BPushKeyAbcd…'],
        ]);
        expect(rows.find((row) => row.label === 'Push key')!.copy).toBe(false);
    });

    it('says when nothing is there yet', () => {
        expect(pushRows({ kind: 'unknown' }).map((row) => [row.label, row.value])).toEqual([
            ['Push', 'Not checked yet'],
            ['Relay registration', 'Not registered'],
            ['Last keepalive', 'None since the app started'],
            ['Push key', NONE],
        ]);
    });

    it('words each keepalive answer, codes raw', () => {
        expect(refreshLine({ at: NOW, answer: 'gone' }, NOW)).toBe('Just now · Gone (410)');
        expect(refreshLine({ at: NOW, answer: 'forbidden' }, NOW)).toBe('Just now · Not ours (403)');
        expect(refreshLine({ at: NOW, answer: 'offline' }, NOW)).toBe('Just now · No answer');
        expect(refreshLine({ at: NOW, answer: 502 }, NOW)).toBe('Just now · Refused (502)');
    });
});
