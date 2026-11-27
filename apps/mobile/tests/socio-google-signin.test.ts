import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// modules/socio-google-signin (CB-570): both native sides export what the TypeScript side declares,
// with the server's nonce and audience, the person's Cancel told apart, Google's SDK signed out
// after each sign-in on iOS, and only the dependencies its README lists. The wrapper never rejects
// and never hands back an answer that isn't a token as one.

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('expo', () => ({ requireNativeModule: () => ({ signIn: mocks.signIn }) }));

const { googleSignIn } = await import('../modules/socio-google-signin');

const module = join(import.meta.dirname, '../modules/socio-google-signin');
const read = (path: string) => readFileSync(join(module, path), 'utf8');
const swift = read('ios/SocioGoogleSignInModule.swift');
const kotlin = read('android/src/main/java/expo/modules/sociogooglesignin/SocioGoogleSignInModule.kt');

describe('the native sides of socio-google-signin', () => {
    it('both export signIn, as the TypeScript side declares it', () => {
        expect(read('src/native.ts')).toMatch(
            /signIn\(clientId: string \| null, serverClientId: string, nonce: string\): Promise<GoogleSignInResult>;/,
        );
        expect(swift).toContain(
            'AsyncFunction("signIn") { (clientId: String?, serverClientId: String, nonce: String, promise: Promise) in',
        );
        expect(kotlin).toContain(
            'AsyncFunction("signIn") { _: String?, serverClientId: String, nonce: String, promise: Promise ->',
        );
        expect(JSON.parse(read('expo-module.config.json'))).toEqual({
            platforms: ['apple', 'android'],
            apple: { modules: ['SocioGoogleSignInModule'], appDelegateSubscribers: ['SocioGoogleSignInAppDelegate'] },
            android: { modules: ['expo.modules.sociogooglesignin.SocioGoogleSignInModule'] },
        });
    });

    it('iOS: GIDSignIn for the server’s audience with the nonce, then signed out', () => {
        expect(swift).toContain('GIDConfiguration(clientID: clientId, serverClientID: serverClientId)');
        expect(swift).toContain('signIn(withPresenting: presenting, hint: nil, additionalScopes: nil, nonce: nonce)');
        expect(swift.indexOf('signIn.signOut()')).toBeGreaterThan(
            swift.indexOf('let token = result?.user.idToken?.tokenString'),
        );
        expect(swift).toContain('GIDSignInError.canceled.rawValue');
        expect(read('ios/SocioGoogleSignIn.podspec')).toContain("s.dependency 'GoogleSignIn', '~> 9.0'");
    });

    it('Android: Sign in with Google with the nonce, its Cancel and no account told apart', () => {
        expect(kotlin).toContain('GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()');
        expect(kotlin).toContain('is GetCredentialCancellationException -> mapOf("type" to "cancel")');
        expect(kotlin).toContain('is NoCredentialException -> mapOf("type" to "no-account")');
        // A failure says its class, never its message.
        expect(kotlin).not.toMatch(/\.message\b/);
        expect(swift).not.toMatch(/localizedDescription/);
    });

    it('nothing logs, on either side', () => {
        expect(swift).not.toMatch(/\bprint\(|NSLog|os_log|Logger/);
        expect(kotlin).not.toMatch(/\bLog\.|println/);
    });

    it('Android depends on exactly Credential Manager, its Play services provider and googleid', () => {
        const gradle = read('android/build.gradle');
        const deps = [...gradle.matchAll(/^\s*(?:implementation|api|compileOnly)\s+"([^"]+)"/gm)].map(
            (match) => match[1],
        );
        expect(deps).toEqual([
            'androidx.credentials:credentials:1.6.0',
            'androidx.credentials:credentials-play-services-auth:1.6.0',
            'com.google.android.libraries.identity.googleid:googleid:1.1.1',
        ]);
        const readme = read('README.md');
        for (const dep of deps) {
            expect(readme).toContain(dep.split(':')[1]!);
        }
    });
});

describe('googleSignIn', () => {
    beforeEach(() => {
        mocks.signIn.mockReset();
    });

    it('passes the ids and the nonce through, and the token back', async () => {
        mocks.signIn.mockResolvedValue({ type: 'success', idToken: 'aaa.bbb.ccc' });
        expect(await googleSignIn({ clientId: null, serverClientId: 'srv', nonce: 'n' })).toEqual({
            type: 'success',
            idToken: 'aaa.bbb.ccc',
        });
        expect(mocks.signIn).toHaveBeenCalledWith(null, 'srv', 'n');
    });

    it('never rejects, and keeps only a code from a native error', async () => {
        mocks.signIn.mockImplementation(async () => {
            throw Object.assign(new Error('ada@example.test went wrong'), { code: 'ERR_X' });
        });
        expect(await googleSignIn({ clientId: null, serverClientId: 'srv', nonce: 'n' })).toEqual({
            type: 'failed',
            reason: 'ERR_X',
        });
    });

    it('keeps no sentence from a native error', async () => {
        mocks.signIn.mockImplementation(async () => {
            throw Object.assign(new Error('a sentence'), { code: 'not an identifier' });
        });
        expect(await googleSignIn({ clientId: null, serverClientId: 'srv', nonce: 'n' })).toEqual({
            type: 'failed',
            reason: 'native',
        });
    });

    it('takes no answer that isn’t a token as one', async () => {
        mocks.signIn.mockResolvedValue({ type: 'success', idToken: 'not a token' });
        expect(await googleSignIn({ clientId: null, serverClientId: 'srv', nonce: 'n' })).toEqual({
            type: 'failed',
            reason: 'not-a-token',
        });
    });
});
