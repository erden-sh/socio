import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { appLink, type WorkspaceManifest } from '@socio/shared/device-sign-in';

import { createSheetFlow, SHEET_PENDING_KEY, SHEET_PENDING_MS } from '../src/data';
import { createSheetSignIns, type SheetJob } from '../src/data/sheet-sign-ins';
import type { SignInOutcome } from '../src/data/sign-in-flow';
import { createExternalLinks, type LinkAction } from '../src/navigation/links';
import type { SheetConfig, SheetResult } from '../src/net/auth-sheet';

// The sheet sign-in's platform half, under Node with fakes: which of the two ways a
// callback comes takes it, what the SignIn screen is told, cancel against a callback still on its
// way, the ticket SheetSignIn redeems with, and a callback's link at a cold start opening
// SheetSignIn through links.ts once the gate shows it.

const LINK_HOST = 'link-staging.socio.sh';
const ORIGIN = 'https://brain.example.test';
const HOST = 'brain.example.test';
const DEV: SheetConfig = {
    variant: 'development',
    linkHost: LINK_HOST,
    callback: { kind: 'https', url: `https://${LINK_HOST}/dev/cb`, host: LINK_HOST, path: '/dev/cb' },
};
const T0 = Date.UTC(2026, 10, 16, 9);
const LOGO = { kind: 'file', path: '/staging/abc.png', extension: 'png' } as const;
const MANIFEST = { id: 'ws_acme' } as WorkspaceManifest;
const COMMITTED: SignInOutcome = { kind: 'committed', id: 'w1', committed: 'new' };

const callbackUrl = (state: string, host = HOST) =>
    appLink({ kind: 'cb', variant: 'development', host, fields: { code: 'ABCDEFGHJKMN', state } }, LINK_HOST);
const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

/** A keychain in memory, and a phone: the flow on it, the sheet the test answers, the redeems asked. */
function phone(options: { os?: 'ios' | 'android'; keychain?: Map<string, string>; clock?: { now: number } } = {}) {
    const keychain = options.keychain ?? new Map<string, string>();
    const clock = options.clock ?? { now: T0 };
    const flow = createSheetFlow({
        keys: {
            read: async (name) => keychain.get(name) ?? null,
            write: async (name, value) => {
                keychain.set(name, value);
            },
            delete: async (names) => {
                for (const name of names) {
                    keychain.delete(name);
                }
            },
        },
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
        sha256: async (text) => createHash('sha256').update(text).digest('base64'),
        config: DEV,
        platform: options.os ?? 'android',
        now: () => clock.now,
    });
    const sheets: Array<{ url: string; answer: (result: SheetResult) => void }> = [];
    const redeemed: SheetJob[] = [];
    const show = vi.fn();
    const signIns = createSheetSignIns({
        flow: () => flow,
        openSheet: (url) => new Promise<SheetResult>((answer) => sheets.push({ url, answer })),
        os: options.os ?? 'android',
        redeem: async (job) => {
            redeemed.push(job);
            return COMMITTED;
        },
        show,
        report: () => undefined,
    });
    /** Starts a sign-in and waits for its sheet to open; resolves its state and how to answer. */
    const open = async () => {
        const started = signIns.start({ origin: ORIGIN, name: 'Acme', logo: LOGO, manifest: MANIFEST });
        await vi.waitFor(() => expect(sheets).toHaveLength(1));
        const sheet = sheets.shift()!;
        opened.push(sheet.url);
        return { started, state: stateOf(sheet.url), answer: sheet.answer };
    };
    const opened: string[] = [];
    /** The device start page the last sheet opened. */
    const lastUrl = () => opened[opened.length - 1];
    return { keychain, clock, signIns, open, lastUrl, redeemed, show };
}

describe('the sheet sign-in, between the screens and the flow', () => {
    it('the sheet’s own callback is taken, with what the screen held, and redeemed once by its ticket', async () => {
        const device = phone();
        const { started, state, answer } = await device.open();
        answer({ type: 'callback', url: callbackUrl(state) });
        expect(await started).toEqual({ kind: 'callback', taken: true });
        const ready = device.signIns.ready();
        expect(ready).toMatchObject({ origin: ORIGIN, name: 'Acme' });
        expect(device.signIns.ready()?.ticket).toBe(ready!.ticket);

        const [one, two] = [device.signIns.finish(ready!.ticket), device.signIns.finish(ready!.ticket)];
        expect(await one).toBe(COMMITTED);
        expect(await two).toBe(COMMITTED);
        expect(device.redeemed).toHaveLength(1);
        expect(device.redeemed[0]).toMatchObject({ logo: LOGO, manifest: MANIFEST, taken: { state } });
        // Another screen, with another ticket or after the run started, gets nothing: no second other-person question.
        expect(await device.signIns.finish(ready!.ticket + 1)).toBeNull();
        expect(device.signIns.ready()).toBeNull();
        expect(device.keychain.has(SHEET_PENDING_KEY)).toBe(false);
    });

    it('the link takes the callback first: SheetSignIn opens from it, and the sheet’s answer says nothing more', async () => {
        const device = phone();
        const { started, state, answer } = await device.open();
        expect(await device.signIns.onLink(callbackUrl(state))).toBe(true);
        expect(device.show).toHaveBeenCalledOnce();
        answer({ type: 'callback', url: callbackUrl(state) });
        expect(await started).toEqual({ kind: 'callback', taken: false });
        expect(device.signIns.ready()).not.toBeNull();
    });

    it('a callback nothing takes is told to the screen with why, never as silence', async () => {
        const expired = phone();
        const first = await expired.open();
        expired.clock.now += SHEET_PENDING_MS;
        first.answer({ type: 'callback', url: callbackUrl(first.state) });
        expect(await first.started).toEqual({ kind: 'refused', reason: 'expired' });

        const elsewhere = phone();
        const second = await elsewhere.open();
        second.answer({ type: 'callback', url: callbackUrl(second.state, 'evil.example.test') });
        expect(await second.started).toEqual({ kind: 'refused', reason: 'host' });
        // The flow is still there for its own callback.
        expect(await elsewhere.signIns.onLink(callbackUrl(second.state))).toBe(true);
        expect(elsewhere.redeemed).toEqual([]);
    });

    it('Android: Cancel (the Custom Tab’s dismiss) keeps the flow, so the link’s callback after it still signs in', async () => {
        const device = phone({ os: 'android' });
        const { started, state, answer } = await device.open();
        answer({ type: 'cancelled' });
        expect(await started).toEqual({ kind: 'cancelled' });
        expect(device.keychain.has(SHEET_PENDING_KEY)).toBe(true);
        expect(await device.signIns.onLink(callbackUrl(state))).toBe(true);
        const ready = device.signIns.ready()!;
        await device.signIns.finish(ready.ticket);
        expect(device.redeemed[0]).toMatchObject({ logo: LOGO, manifest: MANIFEST });
    });

    it.each(['ios', 'android'] as const)(
        '%s: a retry after Cancel mints a new verifier, challenge and state, and replaces the kept flow',
        async (os) => {
            const device = phone({ os });
            const sheets: string[] = [];
            const first = await device.open();
            sheets.push(device.lastUrl());
            first.answer({ type: 'cancelled' });
            await first.started;
            const kept = device.keychain.get(SHEET_PENDING_KEY);

            const second = await device.open();
            sheets.push(device.lastUrl());
            const [one, two] = sheets.map((url) => new URL(url).searchParams);
            expect(two.get('state')).not.toBe(one.get('state'));
            expect(two.get('challenge')).not.toBe(one.get('challenge'));
            const stored = JSON.parse(device.keychain.get(SHEET_PENDING_KEY)!) as { verifier: string; state: string };
            expect(stored.state).toBe(second.state);
            if (kept !== undefined) {
                expect(stored.verifier).not.toBe((JSON.parse(kept) as { verifier: string }).verifier);
            }
            // The first sheet's callback is refused; the retry's own is taken.
            expect(await device.signIns.onLink(callbackUrl(first.state))).toBe(false);
            second.answer({ type: 'callback', url: callbackUrl(second.state) });
            expect(await second.started).toEqual({ kind: 'callback', taken: true });
        },
    );

    it('iOS: Cancel deletes the flow, and a callback after it does nothing', async () => {
        const device = phone({ os: 'ios' });
        const { started, state, answer } = await device.open();
        answer({ type: 'cancelled' });
        expect(await started).toEqual({ kind: 'cancelled' });
        expect(device.keychain.has(SHEET_PENDING_KEY)).toBe(false);
        expect(await device.signIns.onLink(callbackUrl(state))).toBe(false);
        expect(device.show).not.toHaveBeenCalled();
    });

    it.each(['ios', 'android'] as const)('%s: a sheet that fails deletes the flow', async (os) => {
        const device = phone({ os });
        const { started, answer } = await device.open();
        answer({ type: 'failed', reason: 'config', detail: 'no webcredentials' });
        expect(await started).toEqual({ kind: 'failed', reason: 'config', detail: 'no webcredentials' });
        expect(device.keychain.has(SHEET_PENDING_KEY)).toBe(false);
    });

    it('a cold start: the link after a kill is taken by the next process and opens SheetSignIn once the gate shows it', async () => {
        const before = phone();
        const { state } = await before.open();
        // The kill: the process and all it held in memory are gone; the keychain stays.
        const links = createExternalLinks({ resolve: () => undefined, report: () => undefined });
        const after = phone({ keychain: before.keychain });
        const dispatched: LinkAction[] = [];
        const container = {
            routeNames: ['Tabs'],
            isReady: () => true,
            getRootState: () => ({ key: 'root', routeNames: container.routeNames }),
            dispatch: (action: LinkAction) => {
                dispatched.push(action);
            },
        };
        links.attach(container);
        after.show.mockImplementation(() => links.openRoute('SheetSignIn'));

        expect(await after.signIns.onLink(callbackUrl(state))).toBe(true);
        expect(dispatched).toEqual([]);
        // show() also starts adding a workspace: the gate shows Add workspace's routes.
        container.routeNames = ['AddWorkspace', 'SheetSignIn'];
        links.flush();
        expect(dispatched).toEqual([{ target: 'root', type: 'NAVIGATE', payload: { name: 'SheetSignIn' } }]);
        const ready = after.signIns.ready()!;
        await after.signIns.finish(ready.ticket);
        // Nothing of the old process came with it: the mascot, and the manifest read again before the redeem.
        expect(after.redeemed[0]).toMatchObject({ logo: { kind: 'mascot' }, manifest: null, taken: { state } });
    });
});
