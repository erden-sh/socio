import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, expect, it, vi } from 'vitest';

import { contractViolations } from '@socio/data/contract';
import { schemaDrift } from '@socio/data/drift';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { isGrantableScope } from '@socio/shared/agents/scopes';
import { dayKeyIn, eventTimes, localStampIn, normalizeSourceId, zonedInstant } from '@socio/shared/calendar';
import {
    bridgeOpenAllowed,
    bridgeOpenRule,
    parsePluginScope,
    parsePluginToHost,
    pluginScope,
} from '@socio/shared/plugins/plugins';
import type { User } from '@socio/shared/types';

import { pluginProof } from '../src/apps-runtime/keys.js';
import { escapeText, fold } from '../src/server/plugins/calendar/ics.js';
import { calendarEvents, calendarFeeds } from '../src/server/plugins/calendar/infra/schema.js';
import { calendarSchema } from '../src/server/plugins/calendar/migrations.js';
import { catalogsFromEnv, parseManifest, pluginOAuthScopes } from '../src/server/plugins/catalog.js';
import { PLUGIN_PERSON_HEADER, PLUGIN_TIME_ZONE_HEADER } from '../src/server/plugins/contract.js';
import { pluginsSchema } from '../src/server/plugins/migrations.js';
import { signPluginPerson, verifyPluginPerson } from '../src/server/plugins/person.js';
import { socialStrategyManifest } from '../src/server/plugins/planner/manifest.js';
import { PluginService } from '../src/server/plugins/service.js';

import { staticAuth } from './fixtures/static-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const olga: User = { id: 'olga', name: 'Olga', role: 'admin' };
const ana: User = { id: 'ana', name: 'Ana', role: 'admin' };
const juli: User = { id: 'juli', name: 'Juli', role: 'member' };
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };
const NY = 'America/New_York';

/**
 * A Socio with no apps runtime, no apps host and no Docker: what a small
 * deployment has. The calendar must install and run anyway (bundled mode).
 */
function bare(
    options: {
        users?: () => User[];
        zone?: string;
        personZones?: Record<string, string>;
    } = {},
) {
    const db = testDatabase();
    cleanup.push(() => db.close());
    let people = options.users ?? (() => [olga, ana, juli, bob]);
    const plugins = new PluginService(db, {
        catalogs: catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' }),
        parentOrigin: 'https://socio.example',
        users: () => people(),
        workspaceTimeZone: () => options.zone ?? NY,
        personTimeZone: async (id) => options.personZones?.[id],
    });
    return {
        db,
        plugins,
        setUsers: (next: () => User[]) => {
            people = next;
        },
    };
}

/** A fake MCP server that records and can call registered tools. */
function mcp() {
    const tools = new Map<
        string,
        (args: Record<string, unknown>) => Promise<{
            isError?: boolean;
            structuredContent?: Record<string, unknown>;
            content: { text: string }[];
        }>
    >();
    const server = {
        registerTool: (name: string, _config: unknown, run: never) => tools.set(name, run),
    } as unknown as McpServer;
    return { tools, server };
}

function turn(person: User, name = 'Rulo'): DotTurn {
    return {
        dot: {
            id: 'dot-1',
            spaceId: 's',
            spaceIds: ['s'],
            name,
            instructions: '',
            researchAllowed: true,
            memoryAllowed: true,
            issuesAllowed: true,
            createdAt: 0,
            ownerId: null,
        },
        userId: person.id,
        threadId: 't',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
}

const events = (plugins: PluginService) => {
    const ctx = plugins.context('calendar');
    return import('../src/server/plugins/calendar/events.js').then(({ CalendarEvents }) => new CalendarEvents(ctx));
};

it('reads wall-clock times in a zone across clock changes', () => {
    // New York, 2026-03-08: 2:00 jumps to 3:00. 2:30 does not exist; it is
    // read with the offset before the change, an hour later on the clock.
    const skipped = zonedInstant(2026, 3, 8, 2, 30, NY);
    expect(new Date(skipped).toISOString()).toBe('2026-03-08T07:30:00.000Z');
    expect(localStampIn(skipped, NY)).toBe('2026-03-08T03:30');
    // 2026-11-01: 1:30 happens twice; the first (EDT) is the one.
    const twice = zonedInstant(2026, 11, 1, 1, 30, NY);
    expect(new Date(twice).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // Ordinary times on both sides of the change.
    expect(new Date(zonedInstant(2026, 11, 2, 9, 0, NY)).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(new Date(zonedInstant(2026, 10, 30, 9, 0, NY)).toISOString()).toBe('2026-10-30T13:00:00.000Z');
    // A half-hour zone, and a zone east of UTC across its own change.
    expect(new Date(zonedInstant(2026, 7, 1, 9, 15, 'Asia/Kolkata')).toISOString()).toBe('2026-07-01T03:45:00.000Z');
    expect(new Date(zonedInstant(2026, 3, 29, 12, 0, 'Europe/Madrid')).toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(dayKeyIn(Date.parse('2026-11-01T03:59:00Z'), NY)).toBe('2026-10-31');
});

it('turns event inputs into stored times, all-day and timed', () => {
    // A timed event defaults to an hour; a wall-clock time is the zone's.
    expect(eventTimes({ start: '2026-11-03T19:00', timeZone: NY })).toMatchObject({
        allDay: false,
        startLocal: '2026-11-03T19:00',
        endLocal: '2026-11-03T20:00',
        startAt: Date.parse('2026-11-04T00:00:00Z'),
    });
    // An ISO time with an offset is that instant, shown in the zone.
    expect(
        eventTimes({
            start: '2026-11-03T19:00:00-05:00',
            end: '2026-11-04T01:30:00Z',
            timeZone: 'Europe/Madrid',
        }),
    ).toMatchObject({
        startLocal: '2026-11-04T01:00',
        endLocal: '2026-11-04T02:30',
    });
    // A date is all-day; the end is the last day, stored exclusive.
    const allDay = eventTimes({
        start: '2026-11-07',
        end: '2026-11-08',
        timeZone: NY,
    });
    expect(allDay).toMatchObject({
        allDay: true,
        startLocal: '2026-11-07',
        endLocal: '2026-11-08',
        startAt: Date.parse('2026-11-07T05:00:00Z'),
        endAt: Date.parse('2026-11-09T05:00:00Z'),
    });
    expect(() =>
        eventTimes({
            start: '2026-11-03T19:00',
            end: '2026-11-03T18:00',
            timeZone: NY,
        }),
    ).toThrow(/end after it starts/);
    expect(() => eventTimes({ start: 'next tuesday', timeZone: NY })).toThrow(/YYYY-MM-DDTHH:mm in America\/New_York/);
    expect(() => eventTimes({ start: '2026-02-30T10:00', timeZone: NY })).toThrow();
    expect(() =>
        eventTimes({
            start: '2026-11-08',
            end: '2026-11-07',
            allDay: true,
            timeZone: NY,
        }),
    ).toThrow(/before its first/);
});

it('dedupes a Notion page however its id is written', () => {
    const page = '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6';
    for (const form of [
        page,
        '1A2B3C4D-5E6F-47A8-B9C0-D1E2F3A4B5C6',
        `https://www.notion.so/thelab/Board-Room-Hold-${page}`,
        `https://www.notion.so/thelab/Board-Room-Hold-${page}?pvs=4`,
    ]) {
        expect(normalizeSourceId('notion', form)).toBe(page);
    }
    // Other sources keep their ids as they are.
    expect(normalizeSourceId('crm', 'Abc-123')).toBe('Abc-123');
});

it('installs and runs the calendar with no runtime, apps host or Docker (bundled mode)', async () => {
    const { db, plugins } = bare();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(plugins.catalogEntries().map((entry) => entry.id)).toEqual(['calendar']);
    // Offered, not installed: no tables, no launcher entry, no tools.
    const tables = () =>
        (
            db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
                name: string;
            }[]
        ).map((row) => row.name);
    expect(tables()).not.toContain('calendar_events');
    expect(plugins.launcher(juli)).toEqual([]);
    expect(plugins.dotTools(turn(juli))).toEqual([]);

    await plugins.install('calendar');
    expect(tables()).toEqual(expect.arrayContaining(['calendar_events', 'calendar_feeds']));
    expect(schemaDrift(db, [calendarEvents, calendarFeeds])).toEqual([]);
    const row = plugins.get('calendar')!;
    expect(row).toMatchObject({ mode: 'bundled', audience: 'members' });
    expect(await plugins.status('calendar')).toMatchObject({
        state: 'running',
        running: 1,
    });
    // Members see it; it opens inside Socio, with no origin and no frame.
    expect(plugins.launcher(juli)).toEqual([
        {
            id: 'calendar',
            name: 'Calendar',
            description: expect.any(String),
            display: 'embed',
            mode: 'bundled',
            origin: '',
            entryPath: '/',
            openAllow: [],
            openAnyHttps: false,
            routes: false,
        },
    ]);
    expect(plugins.embedOrigin('/plugins/calendar')).toBeUndefined();
    await expect(plugins.launch('calendar', juli.id)).rejects.toThrow(/opens inside Socio/);
    await expect(plugins.scale('calendar', 2)).rejects.toThrow(/no replicas to scale/);
    // A service call cannot reach it: there is no service.
    expect(plugins.acceptsServiceCall('calendar', 'x', 'y')).toBe(false);
    // Settings, disable and enable need no runtime either.
    await plugins.configure('calendar', { timeZone: 'Europe/Madrid' });
    expect(plugins.get('calendar')?.config).toEqual({
        timeZone: 'Europe/Madrid',
    });
    await plugins.setEnabled('calendar', false);
    expect(plugins.launcher(juli)).toEqual([]);
    expect(await plugins.status('calendar')).toMatchObject({ state: 'stopped' });
    await plugins.setEnabled('calendar', true);
    // An event, then uninstall: the rows stay for a later install.
    const calendar = await events(plugins);
    await calendar.create(juli, { title: 'Hold', start: '2026-11-03T10:00' });
    await plugins.uninstall('calendar');
    expect(plugins.launcher(juli)).toEqual([]);
    expect(tables()).toContain('calendar_events');
    await plugins.install('calendar');
    expect((await calendar.list(juli, { from: '2026-11-01', to: '2026-11-30' })).events).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
});

it.each([
    ['PLUGIN_CATALOGS unset (CB-371: no default offers)', {}],
    ['-bundled:calendar', { PLUGIN_CATALOGS: '-bundled:calendar' }],
    ['off', { PLUGIN_CATALOGS: 'off' }],
])('keeps an installed calendar working, and uninstallable, once it is not offered: %s', async (_name, env) => {
    const { db, plugins } = bare();
    await plugins.install('calendar');
    await plugins.setAudience('calendar', 'members');
    const calendar = await events(plugins);
    await calendar.create(juli, { title: 'Hold', start: '2026-11-03T10:00' });

    // The next boot: same database, no offer of the calendar.
    const catalogs = catalogsFromEnv(env);
    expect(catalogs).toEqual([]);
    const after = new PluginService(db, {
        catalogs,
        parentOrigin: 'https://socio.example',
        users: () => [olga, ana, juli, bob],
        workspaceTimeZone: () => NY,
    });
    expect(after.catalogEntries()).toEqual([]);
    // Nothing was uninstalled or deleted: it runs as before, for its audience.
    expect(after.get('calendar')).toMatchObject({ mode: 'bundled', enabled: true, audience: 'members' });
    expect(after.launcher(juli).map((entry) => entry.id)).toEqual(['calendar']);
    expect(after.dotTools(turn(juli)).length).toBeGreaterThan(0);
    const kept = new (await import('../src/server/plugins/calendar/events.js')).CalendarEvents(
        after.context('calendar'),
    );
    expect((await kept.list(juli, { from: '2026-11-01', to: '2026-11-30' })).events).toHaveLength(1);
    // An admin can still manage it: disable, enable, then uninstall.
    await after.setEnabled('calendar', false);
    expect(after.launcher(juli)).toEqual([]);
    await after.setEnabled('calendar', true);
    await after.uninstall('calendar');
    expect(after.list()).toEqual([]);
    // Uninstall keeps its rows, as always; installing again waits for an offer.
    expect((db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get() as { n: number }).n).toBe(1);
    await expect(after.install('calendar')).rejects.toThrow(/not in this instance’s catalog/);
    // Connected agents can still be granted its scopes, offered or not.
    expect(after.oauthScopes()).toEqual(['plugins:calendar:read', 'plugins:calendar:write']);
    expect(after.scopeLabels(['plugins:calendar:read'])).toEqual({
        'plugins:calendar:read': 'Read data in the Calendar plugin, if you may use it',
    });
});

it('follows the migration contract, the plugins audience column included', () => {
    expect(contractViolations([calendarSchema, pluginsSchema])).toEqual([]);
    const audience = pluginsSchema.migrations!.find((migration) => migration.name === 'plugin audience')!;
    expect(audience.phase).toBe('expand');
    expect(String(audience.up)).not.toMatch(/DROP|RENAME|DELETE FROM|UNIQUE/i);
});

it('applies per-person permissions: who sees, adds, changes and deletes', async () => {
    const { plugins } = bare();
    await plugins.install('calendar');
    const calendar = await events(plugins);
    const shared = (
        await calendar.create(juli, {
            title: 'Main Hall',
            start: '2026-11-05T18:00',
            end: '2026-11-05T22:00',
            location: 'Main Hall',
        })
    ).event;
    const mine = (
        await calendar.create(juli, {
            title: 'Dentist',
            start: '2026-11-05T09:00',
            visibility: 'private',
        })
    ).event;
    expect(shared.createdBy).toEqual({ id: 'juli', name: 'Juli' });
    expect(shared.canEdit).toBe(true);
    const range = { from: '2026-11-01', to: '2026-11-30' };
    const titles = async (person: User) => (await calendar.list(person, range)).events.map((event) => event.title);
    // A private event is its creator's alone, admins included.
    expect(await titles(juli)).toEqual(['Dentist', 'Main Hall']);
    expect(await titles(bob)).toEqual(['Main Hall']);
    expect(await titles(ana)).toEqual(['Main Hall']);
    await expect(calendar.get(ana, { id: mine.id })).rejects.toThrow(/No such event/);
    // Someone else's event: read-only for a member, editable for an admin.
    const asBob = (await calendar.list(bob, range)).events[0]!;
    expect(asBob.canEdit).toBe(false);
    await expect(calendar.update(bob, { id: shared.id }, { title: 'Mine now' })).rejects.toMatchObject({ status: 403 });
    await expect(calendar.remove(bob, { id: shared.id })).rejects.toMatchObject({
        status: 403,
    });
    await expect(calendar.update(bob, { id: mine.id }, { title: 'Peek' })).rejects.toMatchObject({ status: 404 });
    const renamed = await calendar.update(ana, { id: shared.id }, { location: 'Full Venue' });
    expect(renamed.event).toMatchObject({
        location: 'Full Venue',
        updatedBy: { id: 'ana', name: 'Ana' },
    });
    // Only its creator makes a shared event private.
    await expect(calendar.update(ana, { id: shared.id }, { visibility: 'private' })).rejects.toThrow(
        /Only the person who created/,
    );
    // editing=everyone lets anyone who may add events change them.
    await plugins.configure('calendar', { editing: 'everyone' });
    expect((await calendar.update(bob, { id: shared.id }, { status: 'tentative' })).event.status).toBe('tentative');
    // writers=admins: members read, admins write.
    await plugins.configure('calendar', { writers: 'admins' });
    await expect(calendar.create(bob, { title: 'Nope', start: '2026-11-06T10:00' })).rejects.toMatchObject({
        status: 403,
    });
    expect(calendar.canWrite(ana)).toBe(true);
    await calendar.remove(juli, { id: mine.id });
    expect(await titles(juli)).toEqual(['Main Hall']);
    // An admins-only install: members lose it entirely.
    await plugins.setAudience('calendar', 'admins');
    expect(plugins.launcher(bob)).toEqual([]);
    expect(plugins.launcher(ana)).toHaveLength(1);
    await expect(calendar.create(bob, { title: 'Nope', start: '2026-11-06T10:00' })).rejects.toMatchObject({
        status: 403,
    });
});

it('creates once per source id: a second sync updates, races do not duplicate', async () => {
    const { db, plugins } = bare();
    await plugins.install('calendar');
    const calendar = await events(plugins);
    const page = '1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6';
    const sync = (start: string, sourceId: string) =>
        calendar.create(
            juli,
            {
                title: 'Board Room Hold',
                start,
                end: '2026-11-04T12:00',
                location: 'Tony Goldman Board Room',
                status: 'tentative',
                source: 'Notion',
                sourceId,
                sourceUrl: `https://www.notion.so/thelab/Board-Room-Hold-${page}`,
            },
            'Grok Bot for Juli',
        );
    const first = await sync('2026-11-04T10:00', page);
    expect(first.outcome).toBe('created');
    expect(first.event).toMatchObject({
        source: 'notion',
        sourceId: page,
        createdVia: 'Grok Bot for Juli',
    });
    // The same page with dashes and upper case: unchanged, then updated.
    const dashed = '1A2B3C4D-5E6F-47A8-B9C0-D1E2F3A4B5C6';
    expect((await sync('2026-11-04T10:00', dashed)).outcome).toBe('unchanged');
    const moved = await sync('2026-11-04T09:30', dashed);
    expect(moved).toMatchObject({
        outcome: 'updated',
        event: { id: first.event.id, startLocal: '2026-11-04T09:30' },
    });
    // Ten at once still make one event.
    const other = 'ffffffffffffffffffffffffffffffff';
    const results = await Promise.all(Array.from({ length: 10 }, () => sync('2026-11-04T10:00', other)));
    expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM calendar_events').get() as { n: number };
    expect(count.n).toBe(2);
    // Find and change it by source id, as a sync would.
    const found = await calendar.update(
        juli,
        { source: 'notion', sourceId: `https://www.notion.so/x-${page}` },
        { status: 'confirmed' },
    );
    expect(found.event).toMatchObject({
        id: first.event.id,
        status: 'confirmed',
    });
    // Someone who may not change it gets a refusal that names nothing.
    await expect(
        calendar.create(bob, {
            title: 'Overwrite',
            start: '2026-11-04T10:00',
            source: 'notion',
            sourceId: page,
        }),
    ).rejects.toMatchObject({
        status: 409,
        message: 'An event with that source and sourceId already exists, and you can’t change it.',
    });
    // A sourceId needs its source.
    await expect(
        calendar.create(juli, {
            title: 'x',
            start: '2026-11-04T10:00',
            sourceId: 'p',
        }),
    ).rejects.toThrow(/Name the source/);
    // Listing by source id finds the one event.
    const listed = await calendar.list(juli, {
        from: '2026-11-01',
        to: '2026-11-30',
        source: 'notion',
        sourceId: dashed,
    });
    expect(listed.events.map((event) => event.id)).toEqual([first.event.id]);
});

it('uses the calendar’s zone by default and keeps wall clocks on change', async () => {
    const { plugins } = bare({ zone: 'UTC' });
    await plugins.install('calendar');
    const calendar = await events(plugins);
    // No setting: the workspace's zone (Operations).
    expect((await calendar.create(juli, { title: 'A', start: '2026-11-03T10:00' })).event).toMatchObject({
        timeZone: 'UTC',
        start: '2026-11-03T10:00:00.000Z',
    });
    // The install's zone wins over the workspace's.
    await plugins.configure('calendar', { timeZone: NY });
    const lab = (
        await calendar.create(juli, {
            title: 'B',
            start: '2026-11-03T10:00',
            end: '2026-11-03T11:30',
        })
    ).event;
    expect(lab).toMatchObject({
        timeZone: NY,
        start: '2026-11-03T15:00:00.000Z',
    });
    // A new start keeps the length; a new zone keeps the wall clock.
    const later = await calendar.update(juli, { id: lab.id }, { start: '2026-11-03T13:00' });
    expect(later.event).toMatchObject({
        startLocal: '2026-11-03T13:00',
        endLocal: '2026-11-03T14:30',
    });
    const madrid = await calendar.update(juli, { id: lab.id }, { timeZone: 'Europe/Madrid' });
    expect(madrid.event).toMatchObject({
        timeZone: 'Europe/Madrid',
        startLocal: '2026-11-03T13:00',
        start: '2026-11-03T12:00:00.000Z',
    });
    await expect(
        calendar.create(juli, {
            title: 'C',
            start: '2026-11-03T10:00',
            timeZone: 'Mars/Base',
        }),
    ).rejects.toThrow(/not a time zone/);
    // A date range is whole days in the calendar's zone, `to` inclusive.
    await calendar.create(juli, {
        title: 'Late',
        start: '2026-11-30T23:30',
    });
    const november = await calendar.list(juli, {
        from: '2026-11-30',
        to: '2026-11-30',
    });
    expect(november.events.map((event) => event.title)).toEqual(['Late']);
    expect(november).toMatchObject({
        timeZone: NY,
        from: '2026-11-30T05:00:00.000Z',
        to: '2026-12-01T05:00:00.000Z',
    });
    await expect(calendar.list(juli, { from: '2026-01-01', to: '2027-12-31' })).rejects.toThrow(/at most 400 days/);
});

it('gives tools to connected agents by consented scope, and to socios by audience', async () => {
    const { plugins } = bare();
    await plugins.install('calendar');
    const names = (person: User, scopes: string[]) => {
        const { tools, server } = mcp();
        plugins.contributeMcp(server, {
            person,
            origin: 'https://socio.example',
            scopes,
            via: `Grok Bot for ${person.name}`,
        });
        return [...tools.keys()];
    };
    expect(names(juli, [])).toEqual([]);
    expect(names(juli, ['issues:write'])).toEqual([]);
    expect(names(juli, ['plugins:calendar:read'])).toEqual(['list_events']);
    expect(names(juli, ['plugins:calendar:read', 'plugins:calendar:write'])).toEqual([
        'list_events',
        'create_event',
        'update_event',
        'delete_event',
    ]);
    // The legacy scopes cover the planner only, never a plugin added
    // since; another plugin's scope does not either.
    expect(names(juli, ['plugins:read', 'plugins:write'])).toEqual([]);
    expect(names(juli, ['plugins:social-strategy:write'])).toEqual([]);
    expect(plugins.toolScopes().get('create_event')).toEqual(['plugins:calendar:write']);
    // A built-in tool's name is never taken over.
    const { tools: guarded, server } = mcp();
    plugins.contributeMcp(
        server,
        { person: juli, origin: '', scopes: ['plugins:calendar:read'] },
        new Set(['list_events']),
    );
    expect([...guarded.keys()]).toEqual([]);

    // A call acts as the person, recording the agent.
    const { tools, server: live } = mcp();
    plugins.contributeMcp(live, {
        person: juli,
        origin: 'https://socio.example',
        scopes: ['plugins:calendar:write', 'plugins:calendar:read'],
        via: 'Grok Bot for Juli',
    });
    const created = await tools.get('create_event')!({
        title: 'DOCK Flex Space',
        start: '2026-11-02T08:00',
        end: '2026-11-02T17:00',
    });
    expect(created.structuredContent).toMatchObject({
        outcome: 'created',
        event: {
            createdBy: { id: 'juli' },
            createdVia: 'Grok Bot for Juli',
            timeZone: NY,
        },
    });
    const failed = await tools.get('update_event')!({ id: 'missing' });
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content[0]!.text).toBe('No such event.');

    // In-app socios: the person's audience, no OAuth scope.
    const socio = plugins.dotTools(turn(bob, 'Rulo'));
    expect(socio.map((tool) => tool.name)).toEqual(['list_events', 'create_event', 'update_event', 'delete_event']);
    const add = socio.find((tool) => tool.name === 'create_event')!;
    const made = (await add.execute!({
        title: 'Socio added',
        start: '2026-11-02T10:00',
    } as never)) as { event: { createdVia: string; createdBy: { id: string } } };
    expect(made.event).toMatchObject({
        createdVia: 'Rulo',
        createdBy: { id: 'bob' },
    });
    // Narrowing the audience takes the tools away, even from a turn that
    // already has them.
    await plugins.setAudience('calendar', 'admins');
    expect(names(bob, ['plugins:calendar:write'])).toEqual([]);
    expect(plugins.dotTools(turn(bob))).toEqual([]);
    expect(
        await add.execute!({
            title: 'Too late',
            start: '2026-11-02T11:00',
        } as never),
    ).toMatchObject({ code: 'http_403' });
    expect(plugins.dotTools(turn(ana)).length).toBe(4);
    // Not for people who can't sign in.
    expect(plugins.dotTools(turn({ id: 'gone', name: 'Gone', role: 'admin' }))).toEqual([]);
});

it('offers per-plugin scopes the consent screen names', () => {
    const calendarScopes = {
        scopes: ['plugins:calendar:read', 'plugins:calendar:write'],
        labels: {
            'plugins:calendar:read': 'Read data in the Calendar plugin, if you may use it',
            'plugins:calendar:write': 'Add and change data in the Calendar plugin, if you may use it',
        },
    };
    expect(pluginOAuthScopes(catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' }))).toEqual(calendarScopes);
    // The calendar was offered everywhere before CB-371, so an installed copy
    // may run where it is no longer offered: its scopes stay listed.
    expect(pluginOAuthScopes(catalogsFromEnv({}))).toEqual(calendarScopes);
    expect(pluginOAuthScopes([])).toEqual(calendarScopes);
    expect(pluginScope('calendar', 'calendar:read')).toBe('plugins:calendar:read');
    expect(parsePluginScope('plugins:calendar:write')).toEqual({
        id: 'calendar',
        access: 'write',
    });
    expect(parsePluginScope('plugins:a--b:write')).toBeUndefined();
    expect(parsePluginScope('plugins:calendar:admin')).toBeUndefined();
    expect(isGrantableScope('plugins:calendar:write')).toBe(true);
    expect(isGrantableScope('issues:read')).toBe(true);
    expect(isGrantableScope('plugins:Calendar:write')).toBe(false);
    expect(isGrantableScope('admin')).toBe(false);
});

it('serves a private .ics feed per person and stops it when they lose access', async () => {
    const { plugins, setUsers } = bare();
    await plugins.install('calendar');
    const calendar = await events(plugins);
    const now = Date.now();
    const day = new Date(now + 2 * 86_400_000).toISOString().slice(0, 10);
    await calendar.create(juli, {
        title: 'Marina Event Hall; setup, then dinner',
        start: `${day}T18:00`,
        location: 'Marina Event Hall',
        description: 'Line one\nLine two',
    });
    await calendar.create(juli, { title: 'Offsite', start: day, allDay: true });
    await calendar.create(bob, {
        title: 'Bob private',
        start: `${day}T09:00`,
        visibility: 'private',
    });
    expect(await calendar.feedState(juli)).toEqual({ active: false });
    const { url } = await calendar.createFeed(juli);
    expect(url).toMatch(/^https:\/\/socio\.example\/plugin-feeds\/calendar\/cbcal_[\w-]{32}\.ics$/);
    const token = url.split('/').pop()!;
    const response = (await plugins.feed('calendar', token))!;
    expect(response.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR\r\n');
    expect(body).toContain('SUMMARY:Marina Event Hall\\; setup\\, then dinner\r\n');
    expect(body).toContain('DESCRIPTION:Line one\\nLine two\r\n');
    expect(body).toContain(`DTSTART;VALUE=DATE:${day.replace(/-/g, '')}\r\n`);
    expect(body).not.toContain('Bob private');
    expect((await calendar.feedState(juli)).active).toBe(true);
    // A new link replaces the old one.
    const second = await calendar.createFeed(juli);
    expect(await plugins.feed('calendar', token)).toBeUndefined();
    const secondToken = second.url.split('/').pop()!;
    expect(await plugins.feed('calendar', secondToken)).toBeDefined();
    // Out of the audience, deactivated, or the plugin disabled: nothing.
    await plugins.setAudience('calendar', 'admins');
    expect(await plugins.feed('calendar', secondToken)).toBeUndefined();
    await plugins.setAudience('calendar', 'members');
    setUsers(() => [olga, bob]);
    expect(await plugins.feed('calendar', secondToken)).toBeUndefined();
    setUsers(() => [olga, juli, bob]);
    await plugins.setEnabled('calendar', false);
    expect(await plugins.feed('calendar', secondToken)).toBeUndefined();
    await plugins.setEnabled('calendar', true);
    await calendar.deleteFeed(juli);
    expect(await plugins.feed('calendar', secondToken)).toBeUndefined();
    expect(await plugins.feed('calendar', 'not-a-token')).toBeUndefined();
});

it('folds and escapes iCalendar text', () => {
    expect(escapeText('a;b,c\\d\r\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    const long = `SUMMARY:${'é'.repeat(60)}`;
    const folded = fold(long);
    for (const line of folded.split('\r\n')) {
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long);
});

it('signs the person for a service plugin that asked for person:read', async () => {
    const proof = pluginProof('runtime-secret-runtime-secret-32', 'crm');
    const signed = signPluginPerson(proof, {
        id: 'juli',
        name: 'Juli',
        role: 'member',
        timeZone: NY,
        plugin: 'crm',
    });
    expect(verifyPluginPerson(proof, 'crm', signed)).toMatchObject({
        id: 'juli',
        name: 'Juli',
        timeZone: NY,
    });
    // Another plugin, a forged body, a stale signature: refused.
    expect(verifyPluginPerson(proof, 'other', signed)).toBeUndefined();
    const [payload, mac] = signed.split('.');
    const forged = Buffer.from(
        JSON.stringify({
            ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
            role: 'admin',
        }),
    ).toString('base64url');
    expect(verifyPluginPerson(proof, 'crm', `${forged}.${mac}`)).toBeUndefined();
    expect(verifyPluginPerson(proof, 'crm', signed, Date.now() + 6 * 60_000)).toBeUndefined();
    expect(verifyPluginPerson('', 'crm', signed)).toBeUndefined();

    // The planner did not ask: it gets the time zone only.
    const db = testDatabase();
    cleanup.push(() => db.close());
    const planner = new PluginService(db, {
        catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
        settings: appsSettingsFromEnv({ APPS_HOST: 'apps.example' }, 'https://socio.example'),
        runtimeToken: 'runtime-secret-runtime-secret-32',
        serviceToken: 'service-token-service-token-service',
        runtime: {
            provisionService: async () => ({
                id: 'social-strategy',
                service: 's',
                image: 'i',
                replicas: 1,
                running: 1,
                state: 'running',
            }),
            scaleService: async () => {
                throw new Error('unused');
            },
            removeService: async () => {},
            serviceStatus: async () => undefined,
        },
        parentOrigin: 'https://socio.example',
        users: () => [olga, juli],
        workspaceTimeZone: () => 'UTC',
        personTimeZone: async (id) => (id === 'olga' ? NY : undefined),
    });
    await planner.install('social-strategy');
    expect(await planner.personHeaders('social-strategy', 'olga')).toEqual({
        [PLUGIN_TIME_ZONE_HEADER]: NY,
    });
    expect(await planner.personHeaders('social-strategy', 'juli')).toEqual({
        [PLUGIN_TIME_ZONE_HEADER]: 'UTC',
    });
    // With person:read granted (a manifest that asks for it), signed.
    db.prepare(`UPDATE plugin_installs SET permissions='["social:read","social:write","person:read"]'`).run();
    const fresh = new PluginService(db, {
        catalogs: [{ kind: 'bundled', id: 'social-strategy' }],
        runtimeToken: 'runtime-secret-runtime-secret-32',
        parentOrigin: 'https://socio.example',
        users: () => [olga, juli],
    });
    const headers = await fresh.personHeaders('social-strategy', 'olga');
    expect(
        verifyPluginPerson(
            pluginProof('runtime-secret-runtime-secret-32', 'social-strategy'),
            'social-strategy',
            headers[PLUGIN_PERSON_HEADER],
        ),
    ).toMatchObject({ id: 'olga', role: 'admin', timeZone: 'UTC' });
});

it('opens only the links a plugin’s bridge.open lists', () => {
    const open = (url: string, allow: string[]) =>
        parsePluginToHost({ v: 1, source: 'socio-plugin', type: 'open', url }, allow);
    // No list, nothing opens; the planner's list opens X's composer only.
    expect(open('https://x.com/intent/post?text=hi', [])).toBeUndefined();
    const planner = socialStrategyManifest.bridge!.open!;
    expect(open('https://x.com/intent/post?text=hi', planner)?.type).toBe('open');
    expect(open('https://x.com/home', planner)).toBeUndefined();
    // A trailing slash allows the paths below it, on that host only.
    const docs = ['https://docs.example.com/guides/'];
    expect(open('https://docs.example.com/guides/a?b=1', docs)).toBeDefined();
    expect(open('https://docs.example.com/guides', docs)).toBeUndefined();
    expect(open('https://evil.example/guides/a', docs)).toBeUndefined();
    expect(open('http://docs.example.com/guides/a', docs)).toBeUndefined();
    expect(bridgeOpenAllowed(new URL('https://docs.example.com:8443/guides/a'), docs)).toBe(false);
    // Rules themselves are strict.
    expect(bridgeOpenRule('https://x.com/intent/post')).toEqual({
        host: 'x.com',
        path: '/intent/post',
    });
    for (const bad of [
        'http://x.com/a',
        'https://x.com:444/a',
        'https://x.com/a?b=1',
        'https://user@x.com/a',
        'https://localhost/a',
        'javascript:alert(1)',
    ]) {
        expect(bridgeOpenRule(bad), bad).toBeUndefined();
    }
    const manifest = {
        ...socialStrategyManifest,
        id: 'third-party',
        service: {
            ...socialStrategyManifest.service!,
            image: `company-brain-plugin-x@sha256:${'ab'.repeat(32)}`,
        },
    };
    expect(parseManifest({ ...manifest, bridge: { open: ['https://ok.example/a'] } }, 'c').bridge).toEqual({
        open: ['https://ok.example/a'],
    });
    expect(() => parseManifest({ ...manifest, bridge: { open: ['http://bad.example/a'] } }, 'c')).toThrow(
        /bridge.open entry/,
    );
    expect(() => parseManifest({ ...manifest, audience: 'guests' }, 'c')).toThrow(/audience/);
    // A catalog file cannot ship a service-less (bundled) plugin.
    const serviceless: Partial<typeof manifest> = { ...manifest };
    delete serviceless.service;
    expect(() => parseManifest(serviceless, 'c')).toThrow(/needs a service/);
});

it('lets the audience use the calendar over HTTP and keeps management admin-only', async () => {
    let current = juli;
    const auth = staticAuth(juli);
    auth.provider.users = () => [olga, juli, bob];
    auth.provider.resolve = async () => current;
    const { app, workspace, dispose } = await makeTestRuntime({
        config: {
            appOrigin: 'http://localhost',
            plugins: { catalogs: catalogsFromEnv({ PLUGIN_CATALOGS: 'bundled:calendar' }) },
        },
        app: { config: { mode: 'live', baseUrl: '' }, auth },
    });
    cleanup.push(dispose);
    for (const user of [olga, juli, bob]) {
        workspace.recordUser(user);
    }
    const call = (method: string, path: string, body?: object) =>
        app.request(`http://localhost${path}`, {
            method,
            headers: {
                'content-type': 'application/json',
                origin: 'http://localhost',
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    // Not installed: a member cannot install it, and its data is not there.
    expect((await call('POST', '/api/plugins/calendar/install', {})).status).toBe(403);
    expect((await call('GET', '/api/plugins')).status).toBe(403);
    current = olga;
    const listed = (await (await call('GET', '/api/plugins')).json()) as {
        catalog: { id: string; mode: string; audience: string }[];
    };
    expect(listed.catalog).toEqual([
        expect.objectContaining({
            id: 'calendar',
            mode: 'bundled',
            audience: 'members',
        }),
    ]);
    expect((await call('POST', '/api/plugins/calendar/install', {})).status).toBe(200);
    // Juli (a member) uses it.
    current = juli;
    const created = await call('POST', '/api/plugins/calendar/data/events', {
        title: 'Full Venue',
        start: '2026-11-06T18:00',
        timeZone: NY,
    });
    expect(await created.text()).toContain('"outcome":"created"');
    const state = (await (
        await call(
            'GET',
            `/api/plugins/calendar/data/state?from=${Date.parse('2026-11-01T00:00:00Z')}&to=${Date.parse('2026-12-01T00:00:00Z')}`,
        )
    ).json()) as { events: { title: string }[]; canWrite: boolean };
    expect(state).toMatchObject({
        canWrite: true,
        events: [{ title: 'Full Venue' }],
    });
    // ...but cannot manage it.
    for (const [method, path] of [
        ['PUT', '/api/plugins/calendar/audience'],
        ['PUT', '/api/plugins/calendar/config'],
        ['POST', '/api/plugins/calendar/disable'],
        ['DELETE', '/api/plugins/calendar'],
    ] as const) {
        expect(`${method} ${path} ${(await call(method, path, {})).status}`).toBe(`${method} ${path} 403`);
    }
    // The feed answers without a session; its token is the credential.
    const feed = (await (await call('POST', '/api/plugins/calendar/data/feed', {})).json()) as { url: string };
    const path = new URL(feed.url).pathname;
    const ics = await app.request(`http://localhost${path}`);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain('SUMMARY:Full Venue');
    expect((await app.request('http://localhost/plugin-feeds/calendar/cbcal_nope.ics')).status).toBe(404);
    // Admins-only: the member is refused, the admin is not.
    current = olga;
    expect(
        (
            await call('PUT', '/api/plugins/calendar/audience', {
                audience: 'admins',
            })
        ).status,
    ).toBe(200);
    current = juli;
    expect((await call('GET', '/api/plugins/calendar/data/state')).status).toBe(403);
    expect((await app.request(`http://localhost${path}`)).status).toBe(404);
    current = olga;
    expect((await call('GET', '/api/plugins/calendar/data/state')).status).toBe(200);
});
