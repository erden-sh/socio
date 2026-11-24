// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PluginBackupStatus } from '@socio/shared/plugins/plugin-backup';
import type { RestoreDrillStatus, SetupStatus, State, User, WorkspaceState } from '@socio/shared/types';

import {
    backupLine,
    continuousLine,
    continuousOffsiteLine,
    dataKeyLine,
    pluginBackupsAlarm,
    pluginBackupsLine,
    restoreDrillLine,
} from '../src/modules/settings/setup-lines';
import { WorkspaceSettings } from '../src/modules/settings/WorkspaceSettings';

// Radix checkboxes measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function settingsPage(user: User, setup: Partial<SetupStatus>) {
    vi.stubGlobal('fetch', async () => Response.json({}));
    await act(async () =>
        root.render(
            <WorkspaceSettings
                state={
                    {
                        settings: { researchAllowed: true, memoryAllowed: true },
                    } as State
                }
                workspace={
                    {
                        user,
                        spaces: [],
                        dots: [],
                        conversations: [],
                        setup: { missing: [], telegram: 'not_configured', ...setup },
                        calls: [],
                    } as unknown as WorkspaceState
                }
                mutate={async () => true}
            />,
        ),
    );
}

it('shows admins the data key and the last backup in Service setup', async () => {
    const lastSuccessAt = Date.UTC(2026, 9, 9, 3, 0);
    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        {
            dataKey: { configured: true, legacy: 3, previous: 0, unknown: 0 },
            backup: {
                intervalHours: 24,
                offsite: true,
                running: false,
                lastSuccessAt,
                lastSizeBytes: 5 * 1024 * 1024,
                offsiteError: 'Object storage PUT failed: HTTP 403.',
            },
        },
    );
    expect(host.querySelector('[data-slot="setup-data-key"]')?.textContent).toBe(
        'Data key: set; re-sealing 3 item(s) sealed under an older key.',
    );
    const backup = host.querySelector('[data-slot="setup-backup"]')?.textContent;
    expect(backup).toContain('Backups: every 24 hour(s); last at ');
    expect(backup).toContain('(5 MB)');
    expect(backup).toContain('the off-site copy failed: Object storage PUT failed: HTTP 403.');
});

it('shows admins each plugin whose own storage isn’t backed up, in red when its entry declares no backup (CB-458)', async () => {
    const since = Date.UTC(2026, 10, 21, 9);
    const when = (ms: number) => new Date(ms).toISOString();
    const notes: PluginBackupStatus = {
        id: 'notes',
        name: 'Notes',
        state: 'not_backed_up',
        declared: false,
        volumes: ['data'],
        since,
    };
    const kept: PluginBackupStatus = {
        id: 'kept',
        name: 'Kept',
        state: 'not_backed_up',
        declared: true,
        volumes: ['db'],
    };
    expect(pluginBackupsLine([notes, kept], when)).toBe(
        'Notes is not backed up: the installed version declares no backup (flagged 2026-11-21T09:00:00.000Z); Kept is not backed up yet: its first backup comes with the next scheduled backup',
    );
    expect(pluginBackupsLine([{ ...notes, since: undefined }])).toBe(
        'Notes is not backed up: the installed version declares no backup',
    );
    expect(pluginBackupsAlarm([notes, kept])).toBe(true);
    expect(pluginBackupsAlarm([kept])).toBe(false);

    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        { backup: { intervalHours: 24, offsite: false, running: false, plugins: [notes, kept] } },
    );
    const line = host.querySelector('[data-slot="setup-plugin-backups"]');
    expect(line?.textContent).toMatch(/^Plugin data: Notes is not backed up: the installed version declares no backup/);
    expect(line?.className).toContain('text-destructive');

    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        { backup: { intervalHours: 24, offsite: false, running: false, plugins: [kept] } },
    );
    expect(host.querySelector('[data-slot="setup-plugin-backups"]')?.className).not.toContain('text-destructive');

    // No plugin with its own storage: no line.
    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        { backup: { intervalHours: 24, offsite: false, running: false } },
    );
    expect(host.querySelector('[data-slot="setup-plugin-backups"]')).toBeNull();
});

it('shows admins a plugin whose backups fail, are out of date or paused, and says when all are backed up (CB-458 step 5)', async () => {
    const when = (ms: number) => new Date(ms).toISOString();
    const at = Date.UTC(2026, 10, 22, 9);
    const base = { declared: true, volumes: ['data'] };
    const ok: PluginBackupStatus = { ...base, id: 'ok', name: 'Acme Notes', state: 'ok', lastSuccessAt: at };
    const failing: PluginBackupStatus = {
        ...base,
        id: 'failing',
        name: 'Acme Tasks',
        state: 'failing',
        since: at,
        lastError: 'The snapshot ran out of time.',
        lastSuccessAt: at - 86_400_000,
    };
    const stale: PluginBackupStatus = { ...base, id: 'stale', name: 'Acme Files', state: 'stale', lastSuccessAt: at };
    const disabled: PluginBackupStatus = { ...base, id: 'off', name: 'Acme Old', state: 'disabled', since: at };
    expect(pluginBackupsLine([ok], when)).toBe('every plugin with its own storage is backed up');
    expect(pluginBackupsLine([ok, failing, stale, disabled], when)).toBe(
        'Acme Tasks’s backup is failing since 2026-11-22T09:00:00.000Z: The snapshot ran out of time. (last backed up 2026-11-21T09:00:00.000Z); Acme Files’s backup is out of date (last backed up 2026-11-22T09:00:00.000Z); Acme Old is disabled since 2026-11-22T09:00:00.000Z, so it isn’t backed up (no good backup yet)',
    );
    expect(pluginBackupsAlarm([ok])).toBe(false);
    expect(pluginBackupsAlarm([ok, disabled])).toBe(false);
    expect(pluginBackupsAlarm([ok, failing])).toBe(true);
    expect(pluginBackupsAlarm([stale])).toBe(true);

    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        { backup: { intervalHours: 24, offsite: false, running: false, plugins: [ok, failing] } },
    );
    const line = host.querySelector('[data-slot="setup-plugin-backups"]');
    expect(line?.textContent).toMatch(/^Plugin data: Acme Tasks’s backup is failing/);
    expect(line?.className).toContain('text-destructive');
});

it('shows members neither', async () => {
    await settingsPage({ id: 'bob', name: 'Bob', role: 'member' }, {});
    expect(host.querySelector('[data-slot="setup-data-key"]')).toBeNull();
    expect(host.querySelector('[data-slot="setup-backup"]')).toBeNull();
    expect(host.textContent).toContain('Voice:');
});

it('lets admins edit the workspace’s branding, and not members (CB-390)', async () => {
    await settingsPage({ id: 'alice', name: 'Alice', role: 'admin' }, {});
    expect(host.querySelector('#branding-name')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await settingsPage({ id: 'bob', name: 'Bob', role: 'member' }, {});
    expect(host.querySelector('#branding-name')).toBeNull();
});

it('says what to do in each data key and backup state', () => {
    expect(dataKeyLine({ configured: false, legacy: 0, previous: 0, unknown: 0 })).toMatch(
        /^not set; .* Set DATA_ENCRYPTION_KEY$/,
    );
    expect(dataKeyLine({ configured: false, legacy: 0, previous: 0, unknown: 3 })).toBe(
        'not set, but 3 item(s) are sealed under a data key; set it again as DATA_ENCRYPTION_KEY',
    );
    expect(dataKeyLine({ configured: true, legacy: 0, previous: 0, unknown: 2 })).toMatch(
        /^2 item\(s\) are sealed under a key this server doesn’t have/,
    );
    expect(dataKeyLine({ configured: true, legacy: 0, previous: 0, unknown: 0 })).toBe('set');
    expect(backupLine({ intervalHours: 0, offsite: false, running: false })).toBe('scheduled backups off; none yet');
    expect(
        backupLine({
            intervalHours: 24,
            offsite: true,
            running: true,
            lastError: 'File system error (ENOSPC).',
        }),
    ).toBe(
        'every 24 hour(s); one is running now; the last one failed: File system error (ENOSPC); not copied off-site yet',
    );
    const at = Date.UTC(2026, 9, 19, 12);
    const time = new Date(at).toLocaleString();
    expect(continuousLine({ behind: false })).toBe('waiting for the first copy');
    expect(continuousLine({ lastCopiedAt: at, behind: false })).toBe(`up to date; newest copy at ${time}`);
    expect(continuousLine({ lastWriteAt: at, behind: true })).toBe('no copy yet; check the litestream service');
    expect(continuousLine({ lastCopiedAt: at, lastWriteAt: at, behind: true })).toBe(
        `behind: the database changed at ${time}, the newest copy is from ${time}; check the litestream service`,
    );
    // CB-315: the write-ahead log's size, and a level other than ok.
    expect(continuousLine({ lastCopiedAt: at, behind: false, walBytes: 300 * 1024 * 1024, level: 'warning' })).toBe(
        `up to date; newest copy at ${time}; write-ahead log 300 MB, warning`,
    );
    expect(continuousLine({ lastCopiedAt: at, behind: false, walBytes: 8192, level: 'ok' })).toBe(
        `up to date; newest copy at ${time}; write-ahead log 8 KB`,
    );
});

it('lets admins set the Dot filing limits, and shows members them', async () => {
    const mutate = vi.fn(async () => true);
    const page = (user: User) =>
        act(async () =>
            root.render(
                <WorkspaceSettings
                    state={
                        {
                            settings: {
                                researchAllowed: true,
                                memoryAllowed: true,
                                dotDailyLimits: { perDot: 50, perUser: 50 },
                            },
                        } as State
                    }
                    workspace={
                        {
                            user,
                            setup: { missing: [], telegram: 'not_configured' },
                        } as unknown as WorkspaceState
                    }
                    mutate={mutate}
                />,
            ),
        );
    await page({ id: 'bob', name: 'Bob', role: 'member' });
    const perDot = () => host.querySelector<HTMLInputElement>('#dot-limit-per-dot')!;
    const perUser = () => host.querySelector<HTMLInputElement>('#dot-limit-per-user')!;
    expect(perDot().value).toBe('50');
    expect(perDot().disabled).toBe(true);
    expect(host.textContent).toContain('Only an admin can change these limits.');

    act(() => root.unmount());
    root = createRoot(host);
    await page({ id: 'alice', name: 'Alice', role: 'admin' });
    const type = (input: HTMLInputElement, value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    const form = host.querySelector<HTMLFormElement>('[data-slot="dot-limits"]')!;
    const submit = () =>
        act(async () => {
            form.requestSubmit();
        });
    type(perDot(), '1.5');
    await submit();
    // The browser refuses it (step 1) before the form's own check does.
    expect(perDot().validity.valid).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    type(perDot(), '200');
    type(perUser(), '0');
    await submit();
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        dotDailyLimits: { perDot: 200, perUser: 0 },
    });
});

it('lets admins set the notification limits beside the filing limits (CB-114)', async () => {
    const mutate = vi.fn(async () => true);
    await act(async () =>
        root.render(
            <WorkspaceSettings
                state={
                    {
                        settings: {
                            researchAllowed: true,
                            memoryAllowed: true,
                            dotDailyLimits: { perDot: 50, perUser: 50 },
                            notificationDailyLimits: { perDot: 20, perUser: 40 },
                        },
                    } as State
                }
                workspace={
                    {
                        user: { id: 'alice', name: 'Alice', role: 'admin' },
                        setup: { missing: [], telegram: 'not_configured' },
                    } as unknown as WorkspaceState
                }
                mutate={mutate}
            />,
        ),
    );
    const form = host.querySelector<HTMLFormElement>('[data-slot="notification-limits"]')!;
    expect(form.querySelector('h3')!.textContent).toBe('Notification limits');
    const perDot = form.querySelector<HTMLInputElement>('#notification-limit-per-dot')!;
    const perUser = form.querySelector<HTMLInputElement>('#notification-limit-per-user')!;
    expect([perDot.value, perUser.value]).toEqual(['20', '40']);
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(perUser, '0');
        perUser.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.requestSubmit());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        notificationDailyLimits: { perDot: 20, perUser: 0 },
    });
});

it('shows admins the continuous copy off-site next to the continuous copy (CB-112)', async () => {
    const at = Date.UTC(2026, 9, 20, 9, 30);
    const time = new Date(at).toLocaleString();
    await settingsPage(
        { id: 'alice', name: 'Alice', role: 'admin' },
        {
            backup: {
                intervalHours: 24,
                offsite: true,
                running: false,
                continuous: {
                    lastCopiedAt: at,
                    lastWriteAt: at,
                    behind: false,
                    offsite: {
                        intervalSeconds: 60,
                        lastSentAt: at - 600_000,
                        lagMs: 600_000,
                        waiting: 0,
                        failures: 3,
                        lastErrorAt: at,
                        lastError: 'Object storage PUT failed: HTTP 503.',
                        behind: true,
                    },
                },
            },
        },
    );
    const line = host.querySelector('[data-slot="setup-continuous-offsite"]')!;
    expect(line.textContent).toBe(
        `Continuous copy off-site: every 60 seconds; the last send failed at ${time} (3 in a row): Object storage PUT failed: HTTP 503; it tries again later; behind: the newest copy has waited 10 min; everything up to ${new Date(at - 600_000).toLocaleString()} is off-site.`,
    );
    expect(line.className).toContain('text-destructive');
    // Right after the continuous copy's own line.
    expect(line.previousElementSibling?.getAttribute('data-slot')).toBe('setup-continuous-copy');
});

it('says how the continuous copy off-site is doing in each state', () => {
    const at = Date.UTC(2026, 9, 20, 9, 30);
    const time = new Date(at).toLocaleString();
    const base = { intervalSeconds: 60, lagMs: 0, waiting: 0, failures: 0 };
    expect(continuousOffsiteLine({ ...base, intervalSeconds: 0, behind: false })).toBe(
        'off; set how often in Backup schedule',
    );
    expect(continuousOffsiteLine({ ...base, behind: false })).toBe('every 60 seconds; nothing sent yet');
    expect(
        continuousOffsiteLine({
            ...base,
            lastSentAt: at,
            lagMs: 20_000,
            behind: false,
        }),
    ).toBe(`every 60 seconds; everything up to ${time} is off-site`);
    expect(
        continuousOffsiteLine({
            ...base,
            lastSentAt: at,
            lagMs: 3 * 3_600_000,
            waiting: 2,
            behind: true,
        }),
    ).toBe(
        `every 60 seconds; behind: the newest copy has waited 3 h; everything up to ${time} is off-site; 2 file(s) waiting; nothing off-site is removed until they go`,
    );
});

it('says how the restore drill went, with each restore’s time (CB-111)', () => {
    const at = Date.UTC(2026, 9, 21, 3, 0);
    const point = Date.UTC(2026, 9, 14, 9, 30, 5);
    const time = (ms: number) => new Date(ms).toLocaleString();
    expect(restoreDrillLine({ intervalDays: 30, running: false })).toBe('every 30 day(s); none yet');
    expect(restoreDrillLine({ intervalDays: 0, running: true })).toBe('only when an admin runs it; one is running now');
    const restores = [
        { source: 'local' as const, ok: true, durationMs: 3_000 },
        { source: 'local' as const, pointAt: point, ok: true, durationMs: 4_000 },
        { source: 'offsite' as const, ok: true, durationMs: 125_000 },
    ];
    expect(
        restoreDrillLine({
            intervalDays: 30,
            running: false,
            last: {
                startedAt: at,
                durationMs: 132_000,
                ok: true,
                restores,
                tables: 40,
                differences: [],
            },
        }),
    ).toBe(
        `every 30 day(s); the last one passed at ${time(at)} in 2 min (latest 3 s, as of ${time(point)} 4 s, off-site 2 min); rows match live`,
    );
    expect(
        restoreDrillLine({
            intervalDays: 30,
            running: false,
            last: {
                startedAt: at,
                durationMs: 7_000,
                ok: true,
                restores: restores.slice(0, 2),
                differences: [{ table: 'runs', live: 12, restored: 11 }],
            },
        }),
    ).toBe(
        `every 30 day(s); the last one passed at ${time(at)} in 7 s (latest 3 s, as of ${time(point)} 4 s); 1 table(s) differ from live by writes since the copy`,
    );
    expect(
        restoreDrillLine({
            intervalDays: 30,
            running: false,
            last: {
                startedAt: at,
                durationMs: 2_000,
                ok: false,
                error: 'The point-in-time restore: litestream restore failed: timestamp does not exist.',
                restores,
            },
        }),
    ).toBe(
        `every 30 day(s); the last one failed at ${time(at)}: The point-in-time restore: litestream restore failed: timestamp does not exist`,
    );
});

it('shows admins the restore drill under the continuous copy, in red when it failed, with Run drill now (CB-111)', async () => {
    const mutate = vi.fn(async () => true);
    const page = (user: User, restoreDrill: RestoreDrillStatus) =>
        act(async () =>
            root.render(
                <WorkspaceSettings
                    state={
                        {
                            settings: { researchAllowed: true, memoryAllowed: true },
                        } as State
                    }
                    workspace={
                        {
                            user,
                            setup: {
                                missing: [],
                                telegram: 'not_configured',
                                backup: {
                                    intervalHours: 24,
                                    offsite: false,
                                    running: false,
                                    continuous: { behind: false, lastCopiedAt: Date.now() },
                                    restoreDrill,
                                },
                            },
                        } as unknown as WorkspaceState
                    }
                    mutate={mutate}
                />,
            ),
        );
    const failed: RestoreDrillStatus = {
        intervalDays: 30,
        running: false,
        last: {
            startedAt: Date.UTC(2026, 9, 21, 3, 0),
            durationMs: 1_000,
            ok: false,
            error: 'The latest restore lacks table(s) issues.',
            restores: [],
        },
    };
    await page({ id: 'alice', name: 'Alice', role: 'admin' }, failed);
    const line = host.querySelector('[data-slot="setup-restore-drill"]')!;
    // Right after the continuous copy's line.
    expect(host.querySelector('[data-slot="setup-continuous-copy"]')!.nextElementSibling).toBe(line.parentElement);
    expect(line.textContent).toMatch(
        /^Restore drill: every 30 day\(s\); the last one failed at .+: The latest restore lacks table\(s\) issues\.$/,
    );
    expect(line.className).toContain('text-destructive');
    const button = () => [...host.querySelectorAll('button')].find((b) => /drill/i.test(b.textContent ?? ''));
    expect(button()?.textContent).toBe('Run drill now');
    await act(async () => button()!.click());
    expect(mutate).toHaveBeenCalledWith('/backups/restore-drill', 'POST');

    // While one runs: not red, and the button waits.
    await page({ id: 'alice', name: 'Alice', role: 'admin' }, { ...failed, running: true });
    expect(host.querySelector('[data-slot="setup-restore-drill"]')!.className).not.toContain('text-destructive');
    expect(button()?.textContent).toBe('Drill running…');
    expect(button()?.disabled).toBe(true);

    // Read-only: no button.
    await page({ id: 'bob', name: 'Bob', role: 'member' }, failed);
    expect(button()).toBeUndefined();
});

it('lets admins set the backup schedule, and shows members it (CB-112)', async () => {
    const mutate = vi.fn(async () => true);
    const page = (user: User) =>
        act(async () =>
            root.render(
                <WorkspaceSettings
                    state={
                        {
                            settings: {
                                researchAllowed: true,
                                memoryAllowed: true,
                                backupSchedule: {
                                    intervalHours: 24,
                                    ltxIntervalSeconds: 60,
                                    drillIntervalDays: 30,
                                    purgeBackupDays: 30,
                                },
                            },
                        } as State
                    }
                    workspace={
                        {
                            user,
                            setup: { missing: [], telegram: 'not_configured' },
                        } as unknown as WorkspaceState
                    }
                    mutate={mutate}
                />,
            ),
        );
    const hours = () => host.querySelector<HTMLInputElement>('#backup-interval-hours')!;
    const seconds = () => host.querySelector<HTMLInputElement>('#backup-ltx-interval')!;
    const days = () => host.querySelector<HTMLInputElement>('#backup-drill-interval')!;
    const purgeDays = () => host.querySelector<HTMLInputElement>('#purge-backup-days')!;
    await page({ id: 'bob', name: 'Bob', role: 'member' });
    expect([hours().value, seconds().value, days().value, purgeDays().value]).toEqual(['24', '60', '30', '30']);
    expect(hours().disabled).toBe(true);
    expect(seconds().disabled).toBe(true);
    expect(days().disabled).toBe(true);
    expect(purgeDays().disabled).toBe(true);
    expect(host.textContent).toContain('Only an admin can change the backup schedule.');

    act(() => root.unmount());
    root = createRoot(host);
    await page({ id: 'alice', name: 'Alice', role: 'admin' });
    const type = (input: HTMLInputElement, value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    const form = host.querySelector<HTMLFormElement>('[data-slot="backup-schedule"]')!;
    type(seconds(), '5');
    await act(async () => form.requestSubmit());
    expect(mutate).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(
        'Use 0 to 720 hours, 0 or 10 to 86400 whole seconds, 0 to 365 whole days for the drill, and 1 to 365 for removal backups.',
    );
    type(hours(), '6');
    type(seconds(), '0');
    type(days(), '366');
    await act(async () => form.requestSubmit());
    expect(mutate).not.toHaveBeenCalled();
    type(days(), '7');
    type(purgeDays(), '0');
    await act(async () => form.requestSubmit());
    expect(mutate).not.toHaveBeenCalled();
    type(purgeDays(), '90');
    await act(async () => form.requestSubmit());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        backupSchedule: {
            intervalHours: 6,
            ltxIntervalSeconds: 0,
            drillIntervalDays: 7,
            purgeBackupDays: 90,
        },
    });
});

it('leaves the backup schedule out when the server runs no backups', async () => {
    await settingsPage({ id: 'alice', name: 'Alice', role: 'admin' }, {});
    expect(host.querySelector('[data-slot="backup-schedule"]')).toBeNull();
});

it('lets admins switch automatic triage on and set its daily cap, read-only for members (CB-30)', async () => {
    const mutate = vi.fn(async () => true);
    const page = (user: User, autoTriage?: { enabled: boolean; perDay: number }) =>
        act(async () =>
            root.render(
                <WorkspaceSettings
                    state={
                        {
                            settings: {
                                researchAllowed: true,
                                memoryAllowed: true,
                                autoTriage,
                            },
                        } as State
                    }
                    workspace={
                        {
                            user,
                            setup: { missing: [], telegram: 'not_configured' },
                        } as unknown as WorkspaceState
                    }
                    mutate={mutate}
                />,
            ),
        );
    const form = () => host.querySelector<HTMLFormElement>('[data-slot="auto-triage"]')!;
    const box = () => form().querySelector<HTMLButtonElement>('button[role="checkbox"]')!;
    const perDay = () => host.querySelector<HTMLInputElement>('#auto-triage-per-day')!;

    await page(
        { id: 'bob', name: 'Bob', role: 'member' },
        {
            enabled: false,
            perDay: 100,
        },
    );
    expect(form().querySelector('h3')!.textContent).toBe('Automatic triage');
    expect(box().getAttribute('aria-checked')).toBe('false');
    expect(box().disabled).toBe(true);
    expect(perDay().disabled).toBe(true);
    expect(form().textContent).toContain('Only an admin can change this setting.');

    act(() => root.unmount());
    root = createRoot(host);
    await page(
        { id: 'alice', name: 'Alice', role: 'admin' },
        {
            enabled: false,
            perDay: 100,
        },
    );
    const type = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(perDay(), value);
            perDay().dispatchEvent(new Event('input', { bubbles: true }));
        });
    type('-3');
    await act(async () => form().requestSubmit());
    expect(mutate).not.toHaveBeenCalled();
    act(() => box().click());
    type('25');
    await act(async () => form().requestSubmit());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        autoTriage: { enabled: true, perDay: 25 },
    });
});
