import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    isLegalLink,
    LEGAL_LINKS,
    LEGAL_ROWS,
    LEGAL_SECTION,
    openLegalLink,
    PRIVACY_FOOTER,
} from '../../src/net/legal-links';

// socio.sh's legal pages (Google Play wants the privacy policy reachable in
// the app, signed out too): the one module of their addresses, Settings'
// Legal rows, the Privacy Policy link before sign-in, and the opener.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('legal links', () => {
    it('pins every page to https://socio.sh', () => {
        expect(LEGAL_LINKS).toEqual({
            privacy: 'https://socio.sh/privacy',
            terms: 'https://socio.sh/terms',
            cookies: 'https://socio.sh/cookies',
            deleteAccount: 'https://socio.sh/delete-account',
            support: 'https://socio.sh/support',
        });
    });

    it("lists Settings' Legal rows in order, each with its page", () => {
        expect(LEGAL_ROWS.map((row) => [row.title, row.href, row.testID])).toEqual([
            ['Privacy Policy', 'https://socio.sh/privacy', 'settings-legal-privacy'],
            ['Terms of Service', 'https://socio.sh/terms', 'settings-legal-terms'],
            ['Delete your account', 'https://socio.sh/delete-account', 'settings-legal-delete-account'],
            ['Help & support', 'https://socio.sh/support', 'settings-legal-support'],
        ]);
        expect(LEGAL_SECTION.publisher).toBe('Socio by Ingenio Ventures Inc.');
        expect(PRIVACY_FOOTER.href).toBe('https://socio.sh/privacy');
    });

    it('opens each row and the footer link with its own URL', () => {
        const open = vi.fn(() => Promise.resolve());
        for (const row of LEGAL_ROWS) {
            openLegalLink(row.href, open);
        }
        openLegalLink(PRIVACY_FOOTER.href, open);
        expect(open.mock.calls).toEqual([
            ['https://socio.sh/privacy'],
            ['https://socio.sh/terms'],
            ['https://socio.sh/delete-account'],
            ['https://socio.sh/support'],
            ['https://socio.sh/privacy'],
        ]);
    });

    it('opens nothing but socio.sh over https', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const open = vi.fn(() => Promise.resolve());
        for (const href of [
            'http://socio.sh/privacy',
            'https://socio.sh.example.com/privacy',
            'https://evil@socio.sh/privacy',
            'https://www.socio.sh/privacy',
            'javascript:alert(1)',
            '/privacy',
        ]) {
            expect(isLegalLink(href)).toBe(false);
            openLegalLink(href, open);
        }
        expect(open).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('keeps a browser that fails to open from throwing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        openLegalLink(LEGAL_LINKS.terms, () => Promise.reject(new Error('no browser')));
        await Promise.resolve();
        await Promise.resolve();
        expect(warn).toHaveBeenCalledWith('[legal] browser not opened', expect.any(Error));
        warn.mockRestore();
    });

    it('opens them in the in-app browser, as a workspace page opens', () => {
        const binding = read('platform/legal-links.ts');
        expect(binding).toMatch(/openLegalLink\(href, \(url\) => WebBrowser\.openBrowserAsync\(url\)\)/);
    });

    it('draws the rows in Settings and the Privacy link before sign-in', () => {
        const parts = read('screens/legal-links.tsx');
        expect(parts).toMatch(/LEGAL_ROWS\.map/);
        expect(parts).toMatch(/onPress=\{\(\) => openLegalPage\(row\.href\)\}/);
        expect(parts).toMatch(/onPress=\{\(\) => openLegalPage\(PRIVACY_FOOTER\.href\)\}/);
        // Settings shows Legal with or without a workspace open.
        expect(read('screens/settings.tsx')).toMatch(/\n {12}<LegalSection \/>\n/);
        expect(read('screens/add-workspace.tsx')).toMatch(/<PrivacyLink testID="add-workspace-privacy" \/>/);
        expect(read('screens/sign-in.tsx')).toMatch(/<PrivacyLink testID="sign-in-privacy" \/>/);
    });
});
