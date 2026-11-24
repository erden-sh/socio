import { afterEach, expect, it } from 'vitest';

import type { SecretBox } from '@socio/foundation/keys/secret-box';
import type { Settings } from '@socio/shared/types';
import {
    daysBetween,
    securityRelease,
    updateStaleness,
    type FeedRelease,
    type SavedUpdateSettings,
} from '@socio/shared/updates/updates';

import { githubRelease } from '../src/server/updates/feed.js';
import { UpdateService, type UpdatesStore } from '../src/server/updates/service.js';
import { updatesFromEnv } from '../src/server/updates/settings.js';

import { startFakeReleaseFeed, type FakeGitHubRelease } from './fixtures/fake-release-feed.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const release = (version: string, date?: string, security = false): FeedRelease => ({
    version,
    tag: `v${version}`,
    ...(date ? { date } : {}),
    upgrading: [],
    ...(security ? { security: true as const } : {}),
});

it('counts whole days between release dates, and nothing without both', () => {
    expect(daysBetween('2026-01-01', '2026-04-01')).toBe(90);
    expect(daysBetween('2026-01-01', '2026-04-02')).toBe(91);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-01-01T23:00:00Z', '2026-01-02')).toBe(1);
    expect(daysBetween(undefined, '2026-01-01')).toBeUndefined();
    expect(daysBetween('2026-01-01', undefined)).toBeUndefined();
    expect(daysBetween('soon', '2026-01-01')).toBeUndefined();
});

it('warns when the newest release is more than the window newer than the running one', () => {
    const at = (date: string) => [release('1.2.0', date), release('1.1.0', '2026-01-15')];
    // Exactly the window: not yet. One day more: stale.
    expect(updateStaleness({ available: at('2026-04-01'), runningDate: '2026-01-01', staleDays: 90 })).toBeUndefined();
    expect(updateStaleness({ available: at('2026-04-02'), runningDate: '2026-01-01', staleDays: 90 })).toEqual({
        reason: 'age',
        newest: 'v1.2.0',
        behindDays: 91,
        staleDays: 90,
        security: [],
    });
    // "Behind" is the newest release's date minus the running one's, not today's.
    expect(updateStaleness({ available: at('2026-02-01'), runningDate: '2026-01-01', staleDays: 30 })?.behindDays).toBe(
        31,
    );
    // 0 turns it off; nothing newer, no warning; no dates (a GHCR feed), no age warning.
    expect(updateStaleness({ available: at('2027-01-01'), runningDate: '2026-01-01', staleDays: 0 })).toBeUndefined();
    expect(updateStaleness({ available: [], runningDate: '2026-01-01', staleDays: 1 })).toBeUndefined();
    expect(updateStaleness({ available: [release('1.2.0')], runningDate: '2026-01-01', staleDays: 1 })).toBeUndefined();
    expect(updateStaleness({ available: at('2027-01-01'), staleDays: 1 })).toBeUndefined();
});

it('warns right away about a newer release marked security', () => {
    const available = [release('1.3.0', '2026-01-04'), release('1.2.1', '2026-01-03', true), release('1.2.0')];
    expect(updateStaleness({ available, runningDate: '2026-01-02', staleDays: 90 })).toEqual({
        reason: 'security',
        newest: 'v1.3.0',
        behindDays: 2,
        staleDays: 90,
        security: ['v1.2.1'],
    });
    // Without any dates too.
    expect(updateStaleness({ available: [release('1.0.1', undefined, true)], staleDays: 90 })).toMatchObject({
        reason: 'security',
        security: ['v1.0.1'],
    });
    // 0 turns the security warning off as well.
    expect(updateStaleness({ available, runningDate: '2026-01-02', staleDays: 0 })).toBeUndefined();
});

it('reads the security marker from a release’s summary or title only', () => {
    const notes = (summary: string, more = '') =>
        `${summary}\n\n- A highlight (CB-1)\n\n### Fixed\n\n- **A fix.** It works. (CB-2)${more}`;
    expect(securityRelease(notes('A session fix (security) and small things.'))).toBe(true);
    expect(securityRelease(notes('Small things.').replace('A highlight', 'Sessions expire (SECURITY)'))).toBe(true);
    expect(securityRelease(notes('Small things.'), 'v1.0.1 (security)')).toBe(true);
    expect(securityRelease(notes('Small things.'))).toBe(false);
    // Only the summary: a note further down that mentions it doesn't mark the release.
    expect(securityRelease(notes('Small things.', '\n- **Docs.** Explain "(security)". (CB-3)'))).toBe(false);
    expect(securityRelease(undefined)).toBe(false);
    // The feed carries it on the release.
    const marked = githubRelease({ tag_name: 'v1.0.1', body: notes('Fixes a token leak (security).') });
    expect(marked?.security).toBe(true);
    expect(githubRelease({ tag_name: 'v1.0.2', body: notes('Small things.') })).not.toHaveProperty('security');
});

it('reads UPDATES_STALE_DAYS: 90 by default, 0 for off, whole days only', () => {
    expect(updatesFromEnv({}).defaults.staleDays).toBe(90);
    expect(updatesFromEnv({ UPDATES_STALE_DAYS: '0' }).defaults.staleDays).toBe(0);
    expect(updatesFromEnv({ UPDATES_STALE_DAYS: '120' }).defaults.staleDays).toBe(120);
    for (const bad of ['-1', '1.5', 'soon', '3651']) {
        expect(() => updatesFromEnv({ UPDATES_STALE_DAYS: bad }), bad).toThrow(/UPDATES_STALE_DAYS/);
    }
});

/** The service over an in-memory settings store, a loopback feed and a recorded notifier. */
async function serviceFixture(options: { env?: Record<string, string>; runningDate?: string } = {}) {
    const feed = await startFakeReleaseFeed();
    cleanup.push(() => feed.close());
    let settings: Settings = {} as Settings;
    const store: UpdatesStore = {
        settings: () => settings,
        updateSettings: async (patch) => (settings = { ...settings, ...patch }),
        secretSetting: () => undefined,
        replaceSecretSetting: async () => false,
    };
    const notices: { trigger: string; title: string; message: string; path: string }[] = [];
    const service = new UpdateService({
        config: updatesFromEnv({
            UPDATES_FEED: 'github:acme/socio',
            UPDATES_GITHUB_API_URL: feed.githubApiUrl,
            UPDATES_GHCR_URL: feed.ghcrUrl,
            ...options.env,
        }),
        store,
        box: {} as SecretBox,
        running: () => ({ version: '1.0.0', commit: null }),
        runningDate: () => options.runningDate,
        backups: () => undefined,
        notifyOperators: async (notice) => notices.push(notice),
        log: () => {},
    });
    const publish = (version: string, date: string, summary = 'Small things.') =>
        feed.state.releases.unshift({
            tag_name: `v${version}`,
            body: `${summary}\n\n- A highlight (CB-1)\n\n### Fixed\n\n- **A fix.** (CB-2)`,
            published_at: `${date}T10:00:00Z`,
        } satisfies FakeGitHubRelease);
    const saved = () => (settings.updates ?? {}) as SavedUpdateSettings;
    return { service, feed, notices, publish, saved };
}

it('tells operators once per newer release, and warns instead when the server is stale', async () => {
    const { service, notices, publish, saved } = await serviceFixture({ runningDate: '2026-01-01' });
    // 31 days behind: the usual notice, once.
    publish('1.1.0', '2026-02-01');
    await service.check();
    await service.check();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available']);
    expect((await service.view()).stale).toBeUndefined();

    // 120 days behind: one notice, the warning, not both; and only once.
    publish('1.2.0', '2026-05-01');
    await service.check();
    await service.check();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available', 'update_stale']);
    expect(notices[1]).toEqual({
        trigger: 'update_stale',
        title: 'Socio is 120 days behind v1.2.0',
        message:
            'This server runs 1.0.0, released 120 days before v1.2.0 (the warning comes after 90). Read the notes and Upgrading steps on the Platform page and update.',
        path: '/settings/operator',
    });
    expect(saved()).toMatchObject({ notified: '1.2.0', staleNotified: '1.2.0' });
    expect((await service.view()).stale).toMatchObject({ reason: 'age', newest: 'v1.2.0', behindDays: 120 });

    // The next newer release, still stale: warned once more, for it.
    publish('1.3.0', '2026-06-01');
    await service.check();
    await service.check();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available', 'update_stale', 'update_stale']);
    expect(notices[2]!.title).toBe('Socio is 151 days behind v1.3.0');
});

it('warns once when a window lowered later makes a release already told about stale', async () => {
    const { service, notices, publish } = await serviceFixture({ runningDate: '2026-01-01' });
    publish('1.1.0', '2026-03-01');
    await service.check();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available']);
    // 59 days behind: stale under a 30-day window an operator sets.
    await service.saveSettings({ staleDays: 30 });
    expect(service.settings()).toMatchObject({ staleDays: 30, source: 'settings' });
    await service.check();
    await service.check();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available', 'update_stale']);
    // Off: no warning on the card, and only the usual notice for the next release.
    await service.saveSettings({ staleDays: 0 });
    publish('1.2.0', '2026-09-01');
    await service.check();
    expect((await service.view()).stale).toBeUndefined();
    expect(notices.map((notice) => notice.trigger)).toEqual(['update_available', 'update_stale', 'update_available']);
    await expect(service.saveSettings({ staleDays: -1 })).rejects.toThrow(/0 \(never\) to 3,650 whole days/);
    await expect(service.saveSettings({ staleDays: 4000 })).rejects.toThrow(/whole days/);
});

it('warns right away about a security release, and dates the running one from the feed first', async () => {
    // The release data has no date for the running build; the feed does.
    const { service, feed, notices, publish } = await serviceFixture({ env: { UPDATES_STALE_DAYS: '90' } });
    feed.state.releases.push({ tag_name: 'v1.0.0', body: 'Small things.', published_at: '2026-01-01T10:00:00Z' });
    publish('1.0.1', '2026-01-03', 'Fixes a session leak (security).');
    await service.check();
    await service.check();
    expect(notices).toEqual([
        {
            trigger: 'update_stale',
            title: 'Socio v1.0.1 is a security update',
            message:
                'This server runs 1.0.0, and v1.0.1 is a security release. Read the notes and Upgrading steps on the Platform page and update.',
            path: '/settings/operator',
        },
    ]);
    const view = await service.view();
    expect(view.available[0]!.security).toBe(true);
    expect(view.stale).toEqual({
        reason: 'security',
        newest: 'v1.0.1',
        behindDays: 2,
        staleDays: 90,
        security: ['v1.0.1'],
    });
});

it('starts the notices over with a new feed, and keeps them on a reset to the same feed', async () => {
    const { service, publish, saved } = await serviceFixture({ runningDate: '2026-01-01' });
    publish('1.1.0', '2026-06-01');
    await service.check();
    expect(saved()).toMatchObject({ notified: '1.1.0', staleNotified: '1.1.0' });
    await service.saveSettings({ staleDays: 200 });
    await service.resetSettings();
    expect(saved()).toEqual({ notified: '1.1.0', staleNotified: '1.1.0' });
    await service.saveSettings({ feed: { kind: 'github', repository: 'other/socio' } });
    expect(saved()).not.toHaveProperty('notified');
    expect(saved()).not.toHaveProperty('staleNotified');
});
