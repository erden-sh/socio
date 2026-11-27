// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import type { State, WorkspaceState } from '@socio/shared/types';

import { WorkspaceSettings } from '../src/modules/settings/WorkspaceSettings';

// The setup card's words load on demand (settings.workspace-setup), so the
// server renders none of it and the browser hydrates the same nothing: its
// timestamps only ever show in the browser's own time zone.
it('renders setup timestamps only in the browser, in New York local time after a UTC server', async () => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async () => Response.json({}));
    const at = Date.parse('2026-10-26T01:00:00Z');
    const state = {
        settings: { researchAllowed: true, memoryAllowed: true },
    } as State;
    const workspace = {
        user: { id: 'alice', name: 'Alice', role: 'admin' },
        setup: {
            missing: [],
            telegram: 'not_configured',
            backup: {
                intervalHours: 24,
                running: false,
                offsite: false,
                lastSuccessAt: at,
                continuous: {
                    behind: false,
                    lastCopiedAt: at,
                    offsite: {
                        intervalSeconds: 60,
                        failures: 0,
                        waiting: 0,
                        behind: false,
                        lastSentAt: at,
                    },
                },
                restoreDrill: {
                    intervalDays: 30,
                    running: false,
                    last: { ok: true, startedAt: at, durationMs: 1000, restores: [] },
                },
            },
        },
    } as unknown as WorkspaceState;
    const host = document.createElement('div');
    document.body.append(host);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const original = Date.prototype.toLocaleString;
    let zone = 'UTC';
    const formatter = vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
        this: Date,
        locales,
        options,
    ) {
        return original.call(this, locales ?? 'en-US', {
            ...options,
            timeZone: zone,
        });
    });
    const commits: string[][] = [];
    const lines = () =>
        [
            ...host.querySelectorAll(
                '[data-slot="setup-backup"], [data-slot="setup-continuous-copy"], [data-slot="setup-continuous-offsite"], [data-slot="setup-restore-drill"]',
            ),
        ].map((node) => node.textContent ?? '');
    function Page() {
        useLayoutEffect(() => {
            commits.push(lines());
        });
        return <WorkspaceSettings state={state} workspace={workspace} mutate={async () => true} />;
    }
    let root: ReturnType<typeof hydrateRoot> | undefined;
    const mismatches: unknown[] = [];
    try {
        host.innerHTML = renderToString(<Page />);
        expect(lines()).toEqual([]);
        expect(host.innerHTML).not.toContain('UTC');
        zone = 'America/New_York';
        await act(async () => {
            root = hydrateRoot(host, <Page />, {
                onRecoverableError: (error) => mismatches.push(error),
            });
        });
        expect(mismatches).toEqual([]);
        expect(commits[0]).toEqual([]);
        const browserLines = lines();
        expect(browserLines).toHaveLength(4);
        for (const line of browserLines) {
            expect(line).toContain('10/25/2026, 9:00:00 PM');
        }
    } finally {
        await act(async () => root?.unmount());
        formatter.mockRestore();
        vi.unstubAllGlobals();
        host.remove();
    }
});
