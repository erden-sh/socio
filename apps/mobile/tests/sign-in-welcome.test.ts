import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WELCOME_HEADLINE, welcomeLine } from '../src/net/sign-in-copy';

// From the 2026-11-18 parity audit (the owner, 2026-11-18): SignIn's header is the
// web's, a large Local over "Welcome back." and "Sign in to <workspace>.", while the
// ways in under it stay the app's own. Read as source: the screen
// draws on React Native, which the Node tests can't load.

const read = (file: string) => readFileSync(join(import.meta.dirname, '../src', file), 'utf8');
const web = (file: string) => readFileSync(join(import.meta.dirname, '../../../packages/client/src', file), 'utf8');

describe('the sign-in header', () => {
    const screen = read('screens/sign-in.tsx');

    it('says the web’s headline and line', () => {
        const signIn = web('shell/SignIn.tsx');
        expect(signIn).toContain('<h1>Welcome back.</h1>');
        expect(signIn).toContain('<p>Sign in to {brand.name}.</p>');
        expect(WELCOME_HEADLINE).toBe('Welcome back.');
        expect(welcomeLine('Workspace A')).toBe('Sign in to Workspace A.');
        expect(screen).toContain('{WELCOME_HEADLINE}');
        expect(screen).toContain('{welcomeLine(name)}');
        expect(screen).not.toContain('`Sign in to ${name}`');
    });

    it('sets the headline as an iOS onboarding heading (Title 1 bold) and the line a muted Subheadline', () => {
        expect(screen).not.toContain('WELCOME_TITLE');
        expect(screen).toMatch(/<Text accessibilityRole="header" variant="heading" className="text-center">/);
        expect(screen).toMatch(/<Text variant="subheadline" tone="muted"[^>]*testID="sign-in-welcome-line">/);
    });

    it('draws the web’s default Local at the largest size its art is sharp, as the empty state does', () => {
        expect(screen).toContain(
            '<LocalAvatar character={characterFor()} size={LOCAL_ART_MAX} testID="sign-in-local" />',
        );
    });

    it('hides the Local while the keyboard is up, so the form fits a small phone', () => {
        expect(screen).toContain('const keyboard = useKeyboardState((state) => state.isVisible);');
        expect(screen).toMatch(/\{keyboard \? null : \(\s*<LocalAvatar/);
    });

    it('keeps the app’s own ways in under it, in order', () => {
        const ids = [
            'sign-in-welcome',
            'sign-in-host',
            'sign-in-continue',
            'sign-in-code',
            'sign-in-email',
            'sign-in-password',
            'sign-in-submit',
            'sign-in-forgot',
            'sign-in-invite',
            'sign-in-privacy',
        ];
        const at = ids.map((id) => screen.indexOf(`testID="${id}"`));
        for (const [index, position] of at.entries()) {
            expect(position, ids[index]).toBeGreaterThan(0);
        }
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    });
});
