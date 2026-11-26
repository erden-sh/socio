import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    UPDATE_CHECK_LABEL,
    UPDATE_DISMISS_LABEL,
    UPDATE_KEPT,
    UPDATE_LINKS,
    UPDATE_OPEN_LABEL,
    updateBannerCopy,
    updateGateCopy,
} from '../../src/shell/client-update';
import { UPDATE_BANNER } from '../../src/shell/session';

// Update Socio's words (CB-553, src/shell/client-update.ts) and where the
// screens draw it: the gate in place of the workspace's screens, inside
// ActiveWorkspace (so per workspace), and the banner in StatusBanners.

const read = (file: string) => readFileSync(join(import.meta.dirname, '../../src', file), 'utf8');

describe('Update Socio’s words', () => {
    it('names the workspace, the version it needs and the one this phone has', () => {
        const copy = updateGateCopy({ minimum: '0.2.8', version: '0.2.7' }, 'Acme', 'ios', 'Socio Preview');
        expect(copy).toEqual({
            title: 'Update Socio',
            body: 'Acme needs Socio 0.2.8 or later. This phone has 0.2.7.',
            link: 'itms-beta://',
            where: 'Update Socio Preview in TestFlight, then open it again.',
            kept: UPDATE_KEPT,
        });
        expect(UPDATE_KEPT).toMatch(/kept/);
    });

    it('says where to look on Android, with no button', () => {
        const copy = updateGateCopy({ minimum: '0.2.8', version: '0.2.7' }, 'Acme', 'android', 'Socio Preview');
        expect(copy.link).toBeNull();
        expect(UPDATE_LINKS.android).toBeNull();
        expect(copy.where).toBe(
            'Install the latest Socio Preview from the download page you got it from, then open it again.',
        );
    });

    it('still reads after a 426 with no numbers known', () => {
        const copy = updateGateCopy({ minimum: null, version: null }, 'Acme', 'ios', 'Socio');
        expect(copy.body).toBe('Acme needs a newer version of Socio.');
    });

    it('words the banner and its dismissal, and keeps the server-side banner apart', () => {
        expect(updateBannerCopy('0.2.9')).toBe('Socio 0.2.9 is ready. Update when you can.');
        expect(UPDATE_DISMISS_LABEL).toBe('Not now');
        expect(UPDATE_OPEN_LABEL).toBe('Open TestFlight');
        expect(UPDATE_CHECK_LABEL).toBe('Check again');
        // The reverse case: the server is too old for the app.
        expect(UPDATE_BANNER).toMatch(/needs a server update/);
    });
});

describe('where the screens draw it', () => {
    it('draws the gate in place of the workspace’s screens, under the open scope', () => {
        const app = read('app.tsx');
        const active = app.indexOf('<ActiveWorkspace');
        const gate = app.indexOf('<ClientUpdateGate>');
        const root = app.indexOf('<RootNavigation');
        expect(active).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(active);
        expect(root).toBeGreaterThan(gate);
        expect(app.indexOf('</ClientUpdateGate>')).toBeGreaterThan(root);
        expect(app.indexOf('</ClientUpdateGate>')).toBeLessThan(app.indexOf('</ActiveWorkspace>'));
    });

    it('offers TestFlight, Check again, the switcher and Add a workspace, and never signs out or wipes', () => {
        const screen = read('screens/client-update.tsx');
        expect(screen).toContain('useClientCompat().required');
        expect(screen).toContain('scope.compat.check()');
        expect(screen).toContain('<Switcher openId={scope.workspace.id}');
        expect(screen).toContain('Linking.openURL(link)');
        expect(screen).not.toMatch(/signOut|wipe|clearCache/);
    });

    it('shows the dismissable banner in StatusBanners', () => {
        const parts = read('screens/shell-parts.tsx');
        expect(parts).toContain('useClientCompat()');
        expect(parts).toContain('updateBannerCopy(recommended)');
        expect(parts).toContain('scope.compat.dismiss()');
    });
});
