import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SignInMethods } from '@socio/shared/auth';

import { NEWCOMER_LINE, signInFooter } from '../../src/net/sign-in-copy';

// No sign-up in the app (Google Play's account-deletion
// rule): accounts come only from an admin's invite, so no SignIn view offers to
// create one, not even by a link to the web, whatever the server's `methods.signUp`
// says. "Forgot password?" (an existing account's reset) and the invite flow stay.

/** Words or paths that offer an account: "Create your account", "Sign up", `/sign-up`, `/signup`. */
const OFFERS_SIGN_UP = /create (your |an )?account|make an account|new account|sign[ -]up|\/signup/i;

const methods = (overrides: Partial<SignInMethods>): SignInMethods => ({
    passkey: false,
    password: true,
    signUp: false,
    emailReset: false,
    signInLink: false,
    providers: [],
    ...overrides,
});

describe('the SignIn footer', () => {
    it('offers no sign-up in any view, whatever methods.signUp says', () => {
        for (const signUp of [true, false]) {
            for (const emailReset of [true, false]) {
                for (const password of [true, false]) {
                    for (const given of [methods({ signUp, emailReset }), null, undefined]) {
                        const footer = signInFooter(given, password);
                        expect(footer.newcomer).toBe(NEWCOMER_LINE);
                        expect(footer.newcomer).not.toMatch(OFFERS_SIGN_UP);
                        expect(footer.newcomer).toMatch(/invite link your admin sent you/);
                    }
                }
            }
        }
    });

    it('keeps "Forgot password?" for the password form where the workspace resets by email', () => {
        expect(signInFooter(methods({ emailReset: true, signUp: true }), true).forgot).toBe(true);
        expect(signInFooter(methods({ emailReset: true }), false).forgot).toBe(false);
        expect(signInFooter(methods({ emailReset: false, signUp: true }), true).forgot).toBe(false);
        expect(signInFooter(null, true).forgot).toBe(false);
    });
});

const src = join(import.meta.dirname, '../../src');

/** Every app source file under `src`, with its comments taken out (a `://` in a URL stays). */
function sources(): { path: string; code: string }[] {
    const found: { path: string; code: string }[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const at = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(at);
            } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
                const code = readFileSync(at, 'utf8')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/(^|[^:])\/\/.*$/gm, '$1');
                found.push({ path: relative(src, at), code });
            }
        }
    };
    walk(src);
    return found;
}

describe('the app’s source', () => {
    it('never opens or words a sign-up path', () => {
        const offenders = sources()
            .filter(({ code }) => OFFERS_SIGN_UP.test(code))
            .map(({ path }) => path);
        expect(offenders).toEqual([]);
    });

    it('reads methods.signUp only where the probe parses the server’s answer into the shared type', () => {
        const readers = sources()
            .filter(({ code }) => /\bsignUp\b/.test(code))
            .map(({ path }) => path);
        expect(readers).toEqual(['net/probe.ts']);
    });
});
