import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { appLink, type AppVariant, LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import { openScannedLink, setScannedLinkOpener } from '../src/navigation/scanned-link';
import { type DeviceLinkConfig, readDeviceLink } from '../src/net/add-device';
import { readWorkspaceLink } from '../src/net/first-screen';
import { readInviteLink } from '../src/net/invite';
import {
    type CameraPermission,
    cameraStep,
    classifyScan,
    SCAN_COPY,
    SCAN_MAX_LENGTH,
    scanCode,
    scannedUrl,
    SCANNING,
    type ScanState,
} from '../src/net/qr-scan';

// Add workspace's QR scanner (CB-566): what a scanned code is on each link host the builds use, the
// hand-off to the link handling a tap from outside goes through, and the camera permission's steps.

const HOST = 'brain.example.test';
const CODE = 'ABCDEFGHJKMN';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345';

const DEV: DeviceLinkConfig = { variant: 'development', linkHost: LINK_STAGING_HOST };
const PREVIEW: DeviceLinkConfig = { variant: 'preview', linkHost: LINK_HOST };
const PRODUCTION: DeviceLinkConfig = { variant: 'production', linkHost: LINK_HOST };
/** A development build pointed at a bench's tunnel (SOCIO_LINK_HOST). */
const TUNNEL: DeviceLinkConfig = { variant: 'development', linkHost: 'bench-tunnel.example.test' };

const device = (config: DeviceLinkConfig, variant: AppVariant = config.variant) =>
    appLink({ kind: 'd', variant, host: HOST, fields: { c: CODE } }, config.linkHost);
const workspace = (config: DeviceLinkConfig, variant: AppVariant = config.variant) =>
    appLink({ kind: 'w', variant, host: HOST, fields: {} }, config.linkHost);
const invite = (config: DeviceLinkConfig, variant: AppVariant = config.variant) =>
    appLink({ kind: 'i', variant, host: HOST, fields: { t: TOKEN } }, config.linkHost);

const handOff = () => ({ close: vi.fn(), open: vi.fn() });

describe('what a scanned code is', () => {
    it.each([
        ['production', PRODUCTION],
        ['preview', PREVIEW],
        ['development', DEV],
        ['development on a tunnel', TUNNEL],
    ] as const)('%s: opens its own Add a device, Get the app and invite links', (_, config) => {
        expect(classifyScan(device(config), config)).toEqual({ kind: 'open', link: 'device', url: device(config) });
        expect(classifyScan(workspace(config), config)).toEqual({
            kind: 'open',
            link: 'workspace',
            url: workspace(config),
        });
        expect(classifyScan(invite(config), config)).toEqual({ kind: 'open', link: 'invite', url: invite(config) });
    });

    it('hands over exactly what the link handlers read when the link opens the app from outside', () => {
        for (const config of [PRODUCTION, PREVIEW, DEV, TUNNEL]) {
            const d = classifyScan(device(config), config);
            const w = classifyScan(workspace(config), config);
            const i = classifyScan(invite(config), config);
            expect(d.kind === 'open' && readDeviceLink(d.url, config)).toEqual({ code: CODE, host: HOST });
            expect(w.kind === 'open' && readWorkspaceLink(w.url, config)).toEqual({ host: HOST });
            expect(i.kind === 'open' && readInviteLink(i.url, config)).toEqual({ host: HOST, token: TOKEN });
        }
    });

    it('reads a code with spaces around it, or a link host in capitals; the token keeps its case', () => {
        expect(classifyScan(`  ${device(PRODUCTION)}\n`, PRODUCTION)).toEqual({
            kind: 'open',
            link: 'device',
            url: device(PRODUCTION),
        });
        const shouted = invite(PRODUCTION).replace('https://link.socio.sh', 'HTTPS://LINK.SOCIO.SH');
        expect(scannedUrl(shouted)).toBe(invite(PRODUCTION));
        expect(classifyScan(shouted, PRODUCTION)).toMatchObject({ kind: 'open', link: 'invite' });
        expect(scannedUrl('just words')).toBe('just words');
    });

    it.each([
        ['preview’s link in production', device(PREVIEW), PRODUCTION],
        ['production’s link in preview', workspace(PRODUCTION), PREVIEW],
        ['development’s link in production', invite(DEV), PRODUCTION],
        ['production’s link in development', device(PRODUCTION), DEV],
        ['the staging host’s link in a tunnel build', workspace(DEV), TUNNEL],
    ] as const)('says %s is for another version of the app, and opens nothing', (_, url, config) => {
        expect(classifyScan(url, config)).toEqual({ kind: 'other-build' });
    });

    it.each([
        ['plain text', 'hello there'],
        ['an empty code', ''],
        ['another site', 'https://example.com/app/w/brain.example.test'],
        ['a look-alike link host', device(PRODUCTION).replace('link.socio.sh', 'link.socio.sh.evil.test')],
        ['a subdomain of the link host', device(PRODUCTION).replace('link.socio.sh', 'x.link.socio.sh')],
        ['plain http', device(PRODUCTION).replace('https://', 'http://')],
        ['a custom scheme', 'socio://chats/abc'],
        ['a query', `${workspace(PRODUCTION)}?next=/x`],
        ['a bad pairing code', device(PRODUCTION).replace(CODE, 'NOT-A-CODE-0')],
        ['a bad token', invite(PRODUCTION).replace(TOKEN, 'x')],
        ['the sign-in sheet’s callback', `https://link.socio.sh/app/cb#code=${CODE}&state=abcdefghijklmnop&ws=${HOST}`],
        ['a sign-in code’s link', `https://link.socio.sh/app/c#code=ABCDEFGH&ws=${HOST}`],
        ['a Wi-Fi code', 'WIFI:S:office;T:WPA;P:secret;;'],
        ['a very long code', `${workspace(PRODUCTION)}${'a'.repeat(SCAN_MAX_LENGTH)}`],
    ])('says %s isn’t a Socio code', (_, data) => {
        expect(classifyScan(data, PRODUCTION)).toEqual({ kind: 'not-socio' });
    });

    it('a bench tunnel’s link is no host this build knows: not a Socio code', () => {
        expect(classifyScan(device(TUNNEL), DEV)).toEqual({ kind: 'not-socio' });
    });

    it('opens nothing in a build with no link host', () => {
        expect(classifyScan(device(PRODUCTION), null)).toEqual({ kind: 'other-build' });
        expect(classifyScan('https://example.com', null)).toEqual({ kind: 'not-socio' });
    });
});

describe('the scanner’s hand-off', () => {
    it('closes the scanner, then opens the link as one from outside, once', () => {
        const calls: string[] = [];
        const off = { close: () => calls.push('close'), open: (url: string) => calls.push(`open ${url}`) };
        const state = scanCode(SCANNING, device(PRODUCTION), PRODUCTION, off);
        expect(state).toEqual({ step: 'opening' });
        expect(calls).toEqual(['close', `open ${device(PRODUCTION)}`]);
        // The camera reads the code again before the scanner is gone: nothing more happens.
        expect(scanCode(state, device(PRODUCTION), PRODUCTION, off)).toBe(state);
        expect(scanCode(state, workspace(PRODUCTION), PRODUCTION, off)).toBe(state);
        expect(calls).toHaveLength(2);
    });

    it('refuses another code with its line and keeps reading: the same code is passed over, another is read', () => {
        const off = handOff();
        const refused = scanCode(SCANNING, 'https://example.com', PRODUCTION, off);
        expect(refused).toEqual({ step: 'refused', data: 'https://example.com', line: 'This isn’t a Socio code.' });
        expect(scanCode(refused, 'https://example.com', PRODUCTION, off)).toBe(refused);
        expect(scanCode(refused, device(PREVIEW), PRODUCTION, off)).toEqual({
            step: 'refused',
            data: device(PREVIEW),
            line: 'This code is for another version of the Socio app.',
        });
        expect(off.close).not.toHaveBeenCalled();
        expect(off.open).not.toHaveBeenCalled();
        // A Socio code while a refusal shows opens at once.
        expect(scanCode(refused, workspace(PRODUCTION), PRODUCTION, off)).toEqual({ step: 'opening' });
        expect(off.open).toHaveBeenCalledWith(workspace(PRODUCTION));
    });

    it('after Try again (back to scanning) the same refused code shows its line again', () => {
        const off = handOff();
        const refused = scanCode(SCANNING, 'hello', PRODUCTION, off) as Extract<ScanState, { step: 'refused' }>;
        expect(scanCode(SCANNING, 'hello', PRODUCTION, off)).toEqual(refused);
    });

    it('the opener the navigation sets is what a scan reaches; with none set, nothing opens', () => {
        setScannedLinkOpener(null);
        expect(openScannedLink(device(PRODUCTION))).toBe(false);
        const opener = vi.fn();
        setScannedLinkOpener(opener);
        expect(openScannedLink(device(PRODUCTION))).toBe(true);
        expect(opener).toHaveBeenCalledWith(device(PRODUCTION));
        setScannedLinkOpener(null);
    });

    it('is wired to the app’s link handling, with the link handlers’ own config', () => {
        const src = (file: string) => readFileSync(join(import.meta.dirname, '../src', file), 'utf8');
        expect(src('navigation/root-navigation.tsx')).toContain('setScannedLinkOpener((url) => openExternalUrl(url));');
        expect(src('platform/qr-scan.ts')).toContain('deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT)');
        expect(src('platform/add-device.ts')).toContain('deviceLinkConfig(Constants.expoConfig?.extra, BUILD_VARIANT)');
        const screen = src('screens/scan-qr.tsx');
        expect(screen).toContain('scanCode(latest.current, data, SCAN_LINKS, handOff)');
        expect(screen).toContain('open: (url) => void openScannedLink(url)');
        // QR codes only, through QrCamera on both platforms (tests/qr-camera.test.ts).
        expect(screen).toContain('onCode={onCode}');
        // The development field that stands in for the camera never renders outside __DEV__.
        expect(screen.match(/<DevScan\b/g)).toHaveLength(1);
        expect(screen).toContain('{__DEV__ ? <DevScan ');
    });
});

describe('the camera permission', () => {
    const p = (status: CameraPermission['status'], canAskAgain: boolean): CameraPermission => ({
        status,
        granted: status === 'granted',
        canAskAgain,
    });

    it('waits while the permission is read', () => {
        expect(cameraStep(null, false)).toEqual({ step: 'checking' });
    });

    it('asks once when never asked (the tap on Scan opened the scanner), then runs once granted', () => {
        expect(cameraStep(p('undetermined', true), false)).toEqual({ step: 'asking' });
        expect(cameraStep(p('granted', true), true)).toEqual({ step: 'ready' });
        expect(cameraStep(p('granted', false), false)).toEqual({ step: 'ready' });
    });

    it('Android’s first “Don’t allow”: asks on the next opening, and offers Allow beside Open Settings', () => {
        expect(cameraStep(p('denied', true), false)).toEqual({ step: 'asking' });
        expect(cameraStep(p('denied', true), true)).toEqual({ step: 'denied', canAsk: true });
    });

    it('refused for good (iOS, or Android’s second): Open Settings only, and never asks', () => {
        expect(cameraStep(p('denied', false), false)).toEqual({ step: 'denied', canAsk: false });
        expect(cameraStep(p('denied', false), true)).toEqual({ step: 'denied', canAsk: false });
    });

    it('says why and what to do, in short words: “device”, never “phone”', () => {
        for (const words of Object.values(SCAN_COPY)) {
            expect(words).not.toMatch(/phone/i);
            expect(words.length).toBeLessThanOrEqual(90);
        }
        expect(SCAN_COPY.notSocio).toBe('This isn’t a Socio code.');
        expect(SCAN_COPY.tryAgain).toBe('Try again');
        expect(SCAN_COPY.openSettings).toBe('Open Settings');
    });
});
