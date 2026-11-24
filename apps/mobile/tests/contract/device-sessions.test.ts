import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { deviceListSchema } from '@socio/shared/device-sign-in';

import { newInstallId } from '../../src/data/keys';
import { createAuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { FetchFunction } from '../../src/net/fetch-function';
import { probeWorkspace, readManifest } from '../../src/net/probe';
import { createPublicFetch } from '../../src/net/public-fetch';
import { readJson } from '../../src/net/read-body';
import type { SessionEnd } from '../../src/net/session';
import { SIGN_IN_PATH } from '../../src/net/sign-in';

// The install id's contract test: the manifest, the install id and the
// server's 401 codes against a real local Socio server. It needs a server
// with devices, 30-day sessions, the manifest and the codes, then
// `pnpm run build` and `node apps/mobile/e2e/servers.mjs`. It runs only when
// SOCIO_CONTRACT_CREDENTIALS names the credentials file servers.mjs wrote and
// SOCIO_CONTRACT_DEVICES is set; CI skips it.

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;
const DEVICES = process.env.SOCIO_CONTRACT_DEVICES;
const USER_AGENT = 'Socio/0.1.0 (contract test)';

interface Credentials {
    password: string;
    accounts: { email: string }[];
    servers: { origin: string }[];
}

const nodeFetch: FetchFunction = (url, init) => fetch(url, init as RequestInit);
const bytes = (length: number) => new Uint8Array(randomBytes(length));

const credentials = () => JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;

/** A signed-in client of `origin`: the app's (with an install id) or the web's (none). */
async function client(origin: string, email: string, password: string, installId: string | null) {
    const jar = await openCookieJar({ origin, store: memoryJarStore() });
    const ends: SessionEnd[] = [];
    const request = createAuthedFetch({
        origin,
        jar,
        fetch: nodeFetch,
        userAgent: USER_AGENT,
        signal: new AbortController().signal,
        installId,
        onUnauthorized: (end) => void ends.push(end),
    });
    const signedIn = await request(SIGN_IN_PATH, { method: 'POST', json: { email, password } });
    expect(signedIn.status).toBe(200);
    return { request, ends, jar };
}

describe.skipIf(!CREDENTIALS || !DEVICES)('device sessions against a local server', () => {
    it('serves a manifest for its own origin, which the probe keeps, and each server has its own id', async () => {
        const { servers } = credentials();
        const publicFetch = createPublicFetch({ fetch: nodeFetch, userAgent: USER_AGENT });
        const ids = new Set<string>();
        for (const { origin } of servers) {
            const read = await readManifest(origin, { publicFetch });
            expect(read).toMatchObject({ kind: 'manifest', manifest: { origin } });
            if (read.kind === 'manifest') {
                ids.add(read.manifest.id);
                expect(read.manifest.policy.leaseDays).toBeGreaterThan(0);
            }
            const probed = await probeWorkspace(origin, {
                variant: 'development',
                publicFetch,
                isKnown: () => false,
            });
            expect(probed).toMatchObject({ kind: 'found', workspace: { manifest: { origin } } });
        }
        // Another workspace at a saved origin would name another id: each server's is its own.
        expect(ids.size).toBe(servers.length);
    });

    it('"Sign out this device" answers session_ended (the copy locks); "Sign out and erase" device_revoked', async () => {
        const { servers, accounts, password } = credentials();
        const origin = servers[0]!.origin;
        const email = accounts[1]!.email;
        const web = await client(origin, email, password, null);

        for (const [erase, end] of [
            [false, 'ended'],
            [true, 'device-revoked'],
        ] as const) {
            const installId = newInstallId(bytes);
            const app = await client(origin, email, password, installId);
            expect((await app.request('/api/state')).status).toBe(200);
            const list = deviceListSchema.parse(await readJson(await web.request('/api/auth/devices')));
            // The app's device: the newest active one (the web made none, having sent no install id).
            const device = list.devices
                .filter((entry) => entry.state === 'active' && !entry.current)
                .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
            expect(device).toBeDefined();
            const revoked = await web.request(`/api/auth/devices/${device!.id}${erase ? '?erase=1' : ''}`, {
                method: 'DELETE',
            });
            expect(revoked.ok).toBe(true);
            const refused = await app.request('/api/state');
            expect(refused.status).toBe(401);
            expect(app.ends).toEqual([end]);
        }
        // The web's own 401 is unchanged.
        expect(web.ends).toEqual([]);
    });
});
