import { expect, it } from 'vitest';

import {
    bucketStart,
    bucketStarts,
    DEFAULT_OPS_QUERY,
    opsSearch,
    opsWindow,
    readOpsQuery,
    zonedTime,
    type OpsQuery,
} from '@socio/shared/operations/operations';

import { afterCursor, decodeCursor, encodeCursor } from '../src/server/operations/domain/cursor.js';
import type { OpsScope } from '../src/server/operations/domain/reader.js';
import { MemoryOpsReader, type MessageFact, type TurnFact } from '../src/server/operations/infra/memory/reader.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 22, 12);
const read = (search: string) => readOpsQuery(new URLSearchParams(search));

it('reads the range and filters from an address and writes them back the same', () => {
    expect(read('')).toEqual({ query: DEFAULT_OPS_QUERY, invalid: [] });
    const shared = '?from=2026-10-01&to=2026-10-07&bucket=day&socio=d1&person=u%3A7&space=s1&source=telegram';
    const { query, invalid } = read(shared);
    expect(invalid).toEqual([]);
    expect(query).toEqual({
        range: '7d',
        from: '2026-10-01',
        to: '2026-10-07',
        bucket: 'day',
        filters: { socio: 'd1', person: 'u:7', space: 's1', source: 'telegram' },
    });
    expect(opsSearch(query)).toBe(shared);
    // Any order in, one order out; the default range is left out.
    expect(opsSearch(read('source=web&range=30d&cursor=abc').query)).toBe('?range=30d&source=web');
    expect(opsSearch(read('range=7d').query)).toBe('');
    // An hour from a chart, as an instant.
    expect(read('from=2026-10-22T09:00:00Z&to=2026-10-22T10:00:00Z').invalid).toEqual([]);
    expect(read('range=1y&bucket=minute&from=2026-13-01&socio=a b&space=').invalid).toEqual([
        'range',
        'from',
        'bucket',
        'socio',
        'space',
    ]);
    expect(read('to=2026-10-01').invalid).toEqual(['from']);
});

it('makes a window of a named range, with the period before it and its buckets', () => {
    const at = (query: Partial<OpsQuery>, timeZone = 'UTC', earliest?: number) =>
        opsWindow({ ...DEFAULT_OPS_QUERY, ...query }, { now: NOW, timeZone, earliest });
    expect(at({ range: '24h' })).toEqual({
        from: NOW - DAY,
        to: NOW,
        bucket: 'hour',
        buckets: ['hour', 'day', 'week', 'month'],
        previous: { from: NOW - 2 * DAY, to: NOW - DAY },
        timeZone: 'UTC',
    });
    expect(at({ range: '7d' }).bucket).toBe('hour');
    expect(at({ range: '30d' })).toMatchObject({
        bucket: 'day',
        buckets: ['hour', 'day', 'week', 'month'],
    });
    expect(at({ range: '30d', bucket: 'hour' }).bucket).toBe('hour');
    expect(at({ range: '90d', bucket: 'hour' })).toMatchObject({
        bucket: 'day',
        buckets: ['day', 'week', 'month'],
    });
    expect(at({ range: '12m', bucket: 'month' }).bucket).toBe('month');
    // All time: from the oldest data, no period before it; weekly by default.
    expect(at({ range: 'all' }, 'UTC', NOW - 1000 * DAY)).toEqual({
        from: NOW - 1000 * DAY,
        to: NOW,
        bucket: 'week',
        buckets: ['week', 'month'],
        previous: null,
        timeZone: 'UTC',
    });
    expect(at({ range: 'all' }).from).toBeNull();
});

it('cuts a custom range’s days in the reporting time zone', () => {
    const window = (from: string, to: string | undefined, timeZone: string) =>
        opsWindow({ ...DEFAULT_OPS_QUERY, from, to }, { now: NOW, timeZone });
    // New York is UTC-4 in October: its 1 October starts at 04:00 UTC, and
    // `to` takes the whole of 7 October (7 days: hourly by default).
    expect(window('2026-10-01', '2026-10-07', 'America/New_York')).toMatchObject({
        from: Date.UTC(2026, 9, 1, 4),
        to: Date.UTC(2026, 9, 8, 4),
        bucket: 'hour',
        previous: { from: Date.UTC(2026, 8, 24, 4), to: Date.UTC(2026, 9, 1, 4) },
    });
    // Backwards reads the right way round; no `to` ends now.
    expect(window('2026-10-08', '2026-10-01', 'UTC')).toMatchObject({
        from: Date.UTC(2026, 9, 1),
        to: Date.UTC(2026, 9, 9),
        bucket: 'day',
    });
    expect(window('2026-10-21', undefined, 'UTC')).toMatchObject({
        from: Date.UTC(2026, 9, 21),
        to: NOW,
        bucket: 'hour',
    });
    // A chart's hour.
    expect(window('2026-10-22T09:00:00Z', '2026-10-22T10:00:00+00:00', 'Asia/Kolkata')).toMatchObject({
        from: Date.UTC(2026, 9, 22, 9),
        to: Date.UTC(2026, 9, 22, 10),
    });
});

it('cuts buckets on the reporting time zone’s clock, across a clock change', () => {
    // Madrid leaves summer time on 25 October 2026: that day has 25 hours.
    const madrid = 'Europe/Madrid';
    const days = bucketStarts(Date.UTC(2026, 9, 24, 12), Date.UTC(2026, 9, 27), 'day', madrid);
    expect(days).toEqual([
        Date.UTC(2026, 9, 23, 22),
        Date.UTC(2026, 9, 24, 22),
        Date.UTC(2026, 9, 25, 23),
        Date.UTC(2026, 9, 26, 23),
    ]);
    expect(days[2]! - days[1]!).toBe(25 * HOUR);
    // Hours on a half-hour zone; weeks from Monday; months from the 1st.
    expect(bucketStart(Date.UTC(2026, 9, 22, 9, 45), 'hour', 'Asia/Kolkata')).toBe(Date.UTC(2026, 9, 22, 9, 30));
    expect(bucketStart(NOW, 'week', 'UTC')).toBe(Date.UTC(2026, 9, 19));
    expect(bucketStart(NOW, 'month', madrid)).toBe(Date.UTC(2026, 8, 30, 22));
    expect(bucketStarts(Date.UTC(2026, 10, 15), Date.UTC(2027, 1, 2), 'month', 'UTC')).toEqual([
        Date.UTC(2026, 10, 1),
        Date.UTC(2026, 11, 1),
        Date.UTC(2027, 0, 1),
        Date.UTC(2027, 1, 1),
    ]);
    expect(zonedTime(2026, 10, 32, 0, 'UTC')).toBe(Date.UTC(2026, 10, 1));
});

it('keeps a list’s place with an opaque keyset cursor', () => {
    const cursor = { key: NOW, id: 'r1' };
    const text = encodeCursor(cursor);
    expect(text).toMatch(/^[\w-]+$/);
    expect(decodeCursor(text)).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ key: 'b', id: 'x' }))).toEqual({
        key: 'b',
        id: 'x',
    });
    for (const bad of ['', '!!', 'e30', Buffer.from('[1]').toString('base64url')]) {
        expect(decodeCursor(bad), bad).toBeUndefined();
    }
    expect(afterCursor({ key: NOW - 1, id: 'z' }, cursor)).toBe(true);
    expect(afterCursor({ key: NOW, id: 'r0' }, cursor)).toBe(true);
    expect(afterCursor({ key: NOW, id: 'r1' }, cursor)).toBe(false);
    expect(afterCursor({ key: NOW + 1, id: 'a' }, cursor)).toBe(false);
});

const scope = (query: Partial<OpsQuery> = {}, timeZone = 'UTC', earliest?: number): OpsScope => {
    const full = { ...DEFAULT_OPS_QUERY, ...query };
    return {
        window: opsWindow(full, { now: NOW, timeZone, earliest }),
        filters: full.filters,
    };
};

const turn = (patch: Partial<TurnFact> & { runId: string }): TurnFact => ({
    threadId: 't1',
    socioId: 'd1',
    spaceId: 's1',
    personId: 'u1',
    source: 'web',
    status: 'finished',
    startedAt: NOW - HOUR,
    inputTokens: 10,
    outputTokens: 5,
    ...patch,
});
const message = (patch: Partial<MessageFact> & { messageId: string }): MessageFact => ({
    threadId: 't1',
    socioId: 'd1',
    spaceId: 's1',
    source: 'web',
    at: NOW - HOUR,
    authorKind: 'person',
    authorId: 'u1',
    ...patch,
});

it('answers the port from facts in memory, filtered and cut in the time zone', async () => {
    const reader = new MemoryOpsReader({
        turns: [
            turn({ runId: 'a' }),
            turn({ runId: 'b', status: 'failed', threadId: 't2', personId: 'u2' }),
            turn({ runId: 'c', socioId: 'd2', spaceId: 's2', source: 'telegram' }),
            turn({
                runId: 'd',
                startedAt: NOW - 30 * HOUR,
                personId: null,
                source: 'scheduled',
            }),
        ],
        messages: [
            message({ messageId: 'm1' }),
            message({ messageId: 'm2', authorId: 'u2', threadId: 't2' }),
            message({ messageId: 'm3', authorKind: 'socio', authorId: 'd1' }),
            message({
                messageId: 'm4',
                socioId: 'd2',
                spaceId: 's2',
                source: 'telegram',
            }),
            // Just after midnight in Kolkata, still the 21st in UTC.
            message({ messageId: 'm5', at: Date.UTC(2026, 9, 21, 19) }),
        ],
    });
    expect(await reader.status()).toEqual({
        state: 'ready',
        asOf: NOW - HOUR,
        earliest: NOW - 30 * HOUR,
    });
    const tiles = async (query: Partial<OpsQuery>) =>
        Object.fromEntries((await reader.overview(scope(query))).map((tile) => [tile.id, [tile.value, tile.previous]]));
    expect(await tiles({ range: '24h' })).toEqual({
        turns: [3, 1],
        failed: [1, 0],
        people: [2, 0],
        messages: [4, 0],
        chats: [2, 1],
        tokens: [45, 15],
    });
    expect(await tiles({ range: '24h', filters: { socio: 'd2' } })).toMatchObject({
        turns: [1, 0],
        messages: [1, 0],
    });
    expect(await tiles({ range: '24h', filters: { space: 's1', source: 'web' } })).toMatchObject({
        turns: [2, 0],
        messages: [3, 0],
    });
    expect(await tiles({ range: '24h', filters: { person: 'u2' } })).toMatchObject({
        turns: [1, 0],
        people: [1, 0],
        messages: [1, 0],
    });
    expect(await tiles({ range: '24h', filters: { socio: 'nobody' } })).toMatchObject({
        turns: [0, 0],
    });
    // All time has no period before it.
    expect((await reader.overview(scope({ range: 'all' })))[0]).toEqual({
        id: 'turns',
        value: 4,
        previous: null,
    });

    // Distinct people per day: in UTC the 21st has u1 (m5); in Kolkata m5
    // falls on the 22nd, with u1 and u2.
    const people = (timeZone: string) => reader.series(scope({ range: '7d', bucket: 'day' }, timeZone), 'people');
    expect((await people('UTC')).slice(-2).map((point) => point.value)).toEqual([1, 2]);
    expect((await people('Asia/Kolkata')).slice(-2).map((point) => point.value)).toEqual([0, 2]);
    const hourly = await reader.series(scope({ range: '24h' }), 'turns');
    expect(hourly).toHaveLength(24);
    expect(hourly.at(-1)).toEqual({ at: NOW - HOUR, value: 3 });
    const tokens = await reader.series(scope({ range: '24h' }), 'tokens');
    expect(tokens.at(-1)!.value).toBe(45);
    // All time starts at the oldest fact.
    const all = await reader.series(scope({ range: 'all', bucket: 'month' }, 'UTC', NOW - 30 * HOUR), 'failed');
    expect(all).toEqual([{ at: Date.UTC(2026, 9, 1), value: 1 }]);
});

it('says it has nothing, with null values, before the store runs', async () => {
    const reader = new MemoryOpsReader();
    expect(await reader.status()).toEqual({
        state: 'unavailable',
        asOf: null,
        earliest: null,
    });
    expect((await reader.overview(scope())).every((tile) => tile.value === null && tile.previous === null)).toBe(true);
    expect(await reader.series(scope(), 'turns')).toEqual([]);
    expect(await reader.turns(scope(), { limit: 50 })).toEqual({
        items: [],
        next: null,
    });
    // A store rebuilding keeps its facts out of the answers too.
    const rebuilding = new MemoryOpsReader({ turns: [turn({ runId: 'a' })] }, { state: 'rebuilding', asOf: NOW - DAY });
    expect(await rebuilding.status()).toMatchObject({
        state: 'rebuilding',
        asOf: NOW - DAY,
    });
    expect((await rebuilding.overview(scope()))[0]!.value).toBeNull();
});
