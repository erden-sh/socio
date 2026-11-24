import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { SecretReadError, socioApp } from '../packages/app-sdk/src/index.js';

// Socio Secrets in the app SDK (phase 1, and plugins in phase 2):
// `secrets.get`, `require` and `onRotate`, cached in memory until
// `expiresAt`, never on disk or in the environment, and errors that name
// secrets, never values.

const API = 'http://socio.invalid/api';
const VALUE = 'sk_live_sdk_value_0123456789';
const NEXT = 'sk_live_sdk_value_rotated_0123';

const cleanup: Array<() => unknown> = [];
afterEach(() => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

/** A fake Socio: serves secrets by name, counts calls, records headers. */
function fakeSocio(start = 1_800_000_000_000) {
    let now = start;
    const values = new Map<string, { value: string; version: number }>([
        ['STRIPE_API_KEY', { value: VALUE, version: 1 }],
    ]);
    const calls: Array<{ url: string; authorization: string | null }> = [];
    let refuseOnce401 = false;
    const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, authorization: headers.get('authorization') });
        if (refuseOnce401) {
            refuseOnce401 = false;
            return Response.json({ error: 'The data token is invalid or expired.' }, { status: 401 });
        }
        const parsed = new URL(url);
        const one = parsed.pathname.match(/\/workload\/secrets\/([A-Z0-9_]+)$/);
        const serve = (name: string) => {
            const found = values.get(name);
            return found && { ...found, expiresAt: now + 5 * 60_000 };
        };
        if (one) {
            const found = serve(one[1]!);
            return found
                ? Response.json(found)
                : Response.json(
                      { error: `${one[1]} isn’t declared by this app, or isn’t set or granted to it.` },
                      { status: 403 },
                  );
        }
        const names = (parsed.searchParams.get('names') ?? '').split(',');
        const denied = names.filter((name) => !values.has(name));
        if (denied.length) {
            return Response.json({ error: `Not readable by this app: ${denied.join(', ')}.`, denied }, { status: 403 });
        }
        return Response.json({ secrets: Object.fromEntries(names.map((name) => [name, serve(name)])) });
    }) as typeof globalThis.fetch;
    let token = 'cbdt_first';
    const app = socioApp({
        appId: 'bookings',
        apiUrl: API,
        dataToken: () => token,
        fetch,
        now: () => now,
        env: {},
    });
    return {
        app,
        calls,
        values,
        advance: (ms: number) => {
            now += ms;
        },
        setToken: (next: string) => {
            token = next;
        },
        refuse401: () => {
            refuseOnce401 = true;
        },
    };
}

it('caches a value in memory until its expiresAt, then reads it again', async () => {
    const socio = fakeSocio();
    expect(await socio.app.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(socio.calls).toEqual([
        { url: `${API}/workload/secrets/STRIPE_API_KEY`, authorization: 'Bearer cbdt_first' },
    ]);
    socio.advance(4 * 60_000);
    expect(await socio.app.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(socio.calls).toHaveLength(1);
    // Concurrent reads share one request.
    socio.advance(2 * 60_000);
    socio.values.set('STRIPE_API_KEY', { value: NEXT, version: 2 });
    const [a, b] = await Promise.all([
        socio.app.secrets.get('STRIPE_API_KEY'),
        socio.app.secrets.get('STRIPE_API_KEY'),
    ]);
    expect([a, b]).toEqual([NEXT, NEXT]);
    expect(socio.calls).toHaveLength(2);
    socio.app.secrets.clear();
    await socio.app.secrets.get('STRIPE_API_KEY');
    expect(socio.calls).toHaveLength(3);
});

it('reads the token again after a 401, and refuses with names only', async () => {
    const socio = fakeSocio();
    socio.refuse401();
    socio.setToken('cbdt_renewed');
    expect(await socio.app.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(socio.calls.map((call) => call.authorization)).toEqual(['Bearer cbdt_renewed', 'Bearer cbdt_renewed']);

    const refused = await socio.app.secrets.get('SLACK_WEBHOOK').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SecretReadError);
    expect(refused).toMatchObject({ names: ['SLACK_WEBHOOK'], status: 403 });
    await expect(socio.app.secrets.get('lower-case')).rejects.toThrow(/not a secret name/);
});

it('requires several at once, failing fast with every missing name and caching the rest', async () => {
    const socio = fakeSocio();
    socio.values.set('SLACK_WEBHOOK', { value: 'https://hooks.invalid/x', version: 1 });
    const failed = await socio.app.secrets
        .require(['STRIPE_API_KEY', 'MISSING_ONE', 'MISSING_TWO'])
        .catch((error: unknown) => error as SecretReadError);
    expect(failed).toBeInstanceOf(SecretReadError);
    expect((failed as SecretReadError).names).toEqual(['MISSING_ONE', 'MISSING_TWO']);
    expect((failed as SecretReadError).message).not.toContain(VALUE);

    await socio.app.secrets.require(['STRIPE_API_KEY', 'SLACK_WEBHOOK']);
    expect(socio.calls.at(-1)!.url).toBe(`${API}/workload/secrets?names=STRIPE_API_KEY,SLACK_WEBHOOK`);
    const before = socio.calls.length;
    expect(await socio.app.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(await socio.app.secrets.get('SLACK_WEBHOOK')).toBe('https://hooks.invalid/x');
    await socio.app.secrets.require(['STRIPE_API_KEY']);
    expect(socio.calls).toHaveLength(before);
});

it('calls onRotate with a new version when the cached value expires', async () => {
    vi.useFakeTimers();
    const socio = fakeSocio();
    const rotated: Array<[string, number]> = [];
    const stop = socio.app.secrets.onRotate('STRIPE_API_KEY', (value, version) => rotated.push([value, version]));
    cleanup.push(stop);
    await vi.waitFor(() => expect(socio.calls).toHaveLength(1));
    socio.values.set('STRIPE_API_KEY', { value: NEXT, version: 2 });
    socio.advance(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(rotated).toEqual([[NEXT, 2]]);
    expect(await socio.app.secrets.get('STRIPE_API_KEY')).toBe(NEXT);
    // Stopped: no more fetches on its own.
    stop();
    const calls = socio.calls.length;
    socio.advance(10 * 60_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(socio.calls).toHaveLength(calls);
});

it('never writes a value to disk or to the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdk-secrets-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, 'cbdt_from_file');
    const env: Record<string, string | undefined> = {
        CB_APP_ID: 'bookings',
        CB_DATA_URL: `${API}/data`,
        CB_DATA_TOKEN_FILE: tokenFile,
    };
    const envBefore = JSON.stringify(process.env);
    const app = socioApp({
        env,
        fetch: (async () =>
            Response.json({ value: VALUE, version: 1, expiresAt: Date.now() + 60_000 })) as typeof fetch,
    });
    expect(await app.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(readdirSync(dir)).toEqual(['token']);
    expect(JSON.stringify(env)).not.toContain(VALUE);
    expect(JSON.stringify(process.env)).toBe(envBefore);
});

it('lets a service plugin read with its identity file and proof, and picks up a rotated file (phase 2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-sdk-identity-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'socio_identity');
    writeFileSync(file, 'cbpi_first\n');
    const seen: Array<{ url: string; authorization: string | null; proof: string | null }> = [];
    const fetch: typeof globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({
            url: String(input),
            authorization: headers.get('authorization'),
            proof: headers.get('x-cb-plugin-proof'),
        });
        return Response.json({ value: VALUE, version: 1, expiresAt: Date.now() + 1 });
    }) as typeof globalThis.fetch;
    const plugin = socioApp({
        appId: 'plugin:planner',
        fetch,
        env: {
            SOCIO_API_URL: 'http://socio.invalid/',
            SOCIO_IDENTITY_FILE: file,
            // The deprecated shared token loses to the identity file.
            SOCIO_API_TOKEN: 'shared-token',
            CB_PLUGIN_PROOF: 'proof-of-planner',
        },
    });
    expect(await plugin.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    expect(seen[0]).toEqual({
        url: `${API}/workload/secrets/STRIPE_API_KEY`,
        authorization: 'Bearer cbpi_first',
        proof: 'proof-of-planner',
    });
    // A rotation replaces the file; the next read sends the new token.
    writeFileSync(file, 'cbpi_second');
    plugin.secrets.clear();
    await plugin.secrets.get('STRIPE_API_KEY');
    expect(seen[1]?.authorization).toBe('Bearer cbpi_second');

    // Without the identity file, the deprecated shared token is still sent for one release.
    const legacy = socioApp({
        appId: 'plugin:planner',
        fetch,
        env: { SOCIO_API_URL: 'http://socio.invalid', SOCIO_API_TOKEN: 'shared-token', CB_PLUGIN_PROOF: 'p' },
    });
    await legacy.secrets.get('STRIPE_API_KEY');
    expect(seen[2]?.authorization).toBe('Bearer shared-token');

    const noProof = socioApp({
        appId: 'plugin:planner',
        fetch,
        env: { SOCIO_API_URL: 'http://socio.invalid', SOCIO_IDENTITY_FILE: file },
    });
    await expect(noProof.secrets.get('STRIPE_API_KEY')).rejects.toThrow(/SOCIO_IDENTITY_FILE and CB_PLUGIN_PROOF/);
    const unconfigured = socioApp({ appId: 'bookings', env: {} });
    await expect(unconfigured.secrets.get('STRIPE_API_KEY')).rejects.toThrow(/not configured/);
});
