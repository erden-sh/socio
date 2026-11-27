// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DataKeyStatus, RestoreDrillStatus, State, User, WorkspaceState } from '@socio/shared/types';

import { useSetupLines } from '../src/modules/settings/setup-lines';
import { WorkspaceSettings } from '../src/modules/settings/WorkspaceSettings';

// Service setup's recovery key parts (CB-322): key ids, the legacy-sealed
// count with "Re-seal under the data key", and "Verify a recovery key".

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

/** What a hook returns, from a component rendered once on its own root. */
function hook<T>(use: () => T): T {
    let value: T | undefined;
    function Probe() {
        value = use();
        return null;
    }
    const probe = createRoot(document.createElement('div'));
    act(() => probe.render(<Probe />));
    act(() => probe.unmount());
    return value as T;
}

const admin: User = { id: 'alice', name: 'Alice', role: 'admin' };
const member: User = { id: 'bob', name: 'Bob', role: 'member' };
const drill: RestoreDrillStatus = { intervalDays: 30, running: false };

function page(user: User, dataKey: DataKeyStatus, mutate = vi.fn(async () => true), restoreDrill = drill) {
    vi.stubGlobal('fetch', async () => Response.json({}));
    return act(async () =>
        root.render(
            <WorkspaceSettings
                state={{ settings: { researchAllowed: true, memoryAllowed: true } } as State}
                workspace={
                    {
                        user,
                        setup: {
                            missing: [],
                            telegram: 'not_configured',
                            dataKey,
                            backup: { intervalHours: 24, offsite: false, running: false, restoreDrill },
                        },
                    } as unknown as WorkspaceState
                }
                mutate={mutate}
            />,
        ),
    );
}

const button = (text: RegExp) => [...host.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));
const slot = (name: string) => host.querySelector(`[data-slot="${name}"]`)?.textContent;

it('shows the key ids and the legacy-sealed count, and lets admins re-seal', async () => {
    const mutate = vi.fn(async () => true);
    const dataKey: DataKeyStatus = {
        configured: true,
        legacy: 3,
        previous: 0,
        unknown: 0,
        keyId: '0123456789abcdef',
        previousKeyId: 'fedcba9876543210',
        legacyByPurpose: { 'inference-credentials': 2, 'data-files': 1 },
    };
    await page(admin, dataKey, mutate);
    expect(slot('setup-key-ids')).toBe('Key ids: current 0123456789abcdef, previous fedcba9876543210.');
    expect(slot('setup-legacy-sealed')).toBe(
        'Legacy-sealed: 3 items (inference credentials 2, files 1) still need SESSION_SECRET; keep it in the recovery kit until this is zero.',
    );
    await act(async () => button(/Re-seal under the data key/)!.click());
    expect(mutate).toHaveBeenCalledWith('/data-key/reseal', 'POST');

    // Running: the button waits.
    await page(admin, { ...dataKey, reseal: { running: true } }, mutate);
    expect(button(/Re-sealing/)?.disabled).toBe(true);
    expect(slot('setup-reseal')).toBe('Re-seal: running now.');

    // Done, nothing left: no button, and SESSION_SECRET can leave the kit.
    await page(admin, { ...dataKey, legacy: 0, legacyByPurpose: undefined }, mutate);
    expect(button(/Re-seal/)).toBeUndefined();
    expect(slot('setup-legacy-sealed')).toBe(
        'Legacy-sealed: none; SESSION_SECRET is no longer needed to read stored data.',
    );

    // The server sends members no data key status; read-only, there's no button anyway.
    await page(member, dataKey, mutate);
    expect(button(/Re-seal/)).toBeUndefined();
});

it('offers the re-seal without a data key only as disabled, saying what to set', async () => {
    await page(admin, { configured: false, legacy: 4, previous: 0, unknown: 0 });
    expect(slot('setup-key-ids')).toBe('Key ids: none; no data key is set.');
    expect(button(/Re-seal under the data key/)?.disabled).toBe(true);
    expect(host.textContent).toContain('Set DATA_ENCRYPTION_KEY first.');
});

it('sends a recovery key once and clears the field; shows only its id and the result', async () => {
    const mutate = vi.fn(async () => true);
    const dataKey: DataKeyStatus = { configured: true, legacy: 0, previous: 0, unknown: 0, keyId: '0123456789abcdef' };
    await page(admin, dataKey, mutate);
    const input = host.querySelector<HTMLInputElement>('#recovery-key')!;
    expect(input.type).toBe('password');
    expect(input.autocomplete).toBe('off');
    const key = 'ab'.repeat(32);
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, key);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(/^Verify$/)!.click());
    expect(mutate).toHaveBeenCalledWith('/backups/verify-key', 'POST', { key });
    expect(host.querySelector<HTMLInputElement>('#recovery-key')!.value).toBe('');

    const last = {
        startedAt: Date.UTC(2026, 10, 1, 3, 0),
        durationMs: 2_000,
        ok: false,
        keyId: '0123456789abcdef',
        matches: 'current' as const,
        purposes: [
            {
                purpose: 'settings-secrets' as const,
                sampled: 2,
                opened: 1,
                failed: 1,
                otherKey: 0,
                legacy: 0,
                ok: false,
            },
            { purpose: 'backups' as const, sampled: 0, opened: 0, failed: 0, otherKey: 0, legacy: 0, ok: null },
        ],
    };
    await page(admin, dataKey, mutate, { ...drill, keyCheck: { running: false, last } });
    const result = host.querySelector('[data-slot="setup-recovery-key-result"]')!;
    expect(result.textContent).toMatch(
        /^Recovery key check: key 0123456789abcdef \(the server’s current key\) failed at .+: settings secrets 1 of 2 opened, backups nothing to try\.$/,
    );
    expect(result.className).toContain('text-destructive');
    expect(host.textContent).not.toContain(key);

    // Members don't get the form.
    await page(member, dataKey, mutate);
    expect(host.querySelector('#recovery-key')).toBeNull();
});

it('words each re-seal and key check state', () => {
    const { keyCheckLine, keyIdsLine, legacySealedLine, resealLine } = hook(useSetupLines);
    const base: DataKeyStatus = { configured: true, legacy: 0, previous: 0, unknown: 0 };
    const at = Date.UTC(2026, 10, 1, 3, 0);
    const when = () => 'then';
    expect(keyIdsLine({ ...base, keyId: 'aa' })).toBe('current aa');
    expect(legacySealedLine({ ...base, legacy: 2 })).toBe(
        '2 items still need SESSION_SECRET; keep it in the recovery kit until this is zero',
    );
    expect(resealLine(base)).toBeUndefined();
    expect(
        resealLine(
            {
                ...base,
                reseal: {
                    running: false,
                    last: { startedAt: at, finishedAt: at, resealed: 5, unreadable: 1, left: 2 },
                },
            },
            when,
        ),
    ).toBe(
        'the last one finished at then: 5 re-sealed, 1 under a key this server doesn’t have, 2 left for the next run',
    );
    expect(
        resealLine(
            {
                ...base,
                reseal: {
                    running: false,
                    last: { startedAt: at, finishedAt: at, resealed: 0, unreadable: 0, left: 0, error: 'It failed.' },
                },
            },
            when,
        ),
    ).toBe('the last one failed at then: It failed');
    expect(keyCheckLine({ running: false })).toBe('none yet');
    expect(keyCheckLine({ running: true })).toBe('running now');
    expect(
        keyCheckLine(
            {
                running: false,
                last: {
                    startedAt: at,
                    durationMs: 1,
                    ok: false,
                    keyId: 'bb',
                    matches: 'neither',
                    error: 'litestream restore failed.',
                    purposes: [],
                },
            },
            when,
        ),
    ).toBe('key bb (not a key this server uses) couldn’t be checked at then: litestream restore failed');
});
