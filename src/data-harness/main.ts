/**
 * The data API test harness as a process (CB-476): for a plugin in another
 * repository, which can't import Socio's packages. It boots the harness
 * (`harness.ts`) with the plugin's manifest and serves its `/api/data`
 * routes on HOST:PORT, then prints one JSON line on stdout (its log lines
 * go to stderr):
 * `{ "origin", "apiUrl", "dataUrl", "token", "expiresAt", "datasets", "sources", "identity", "proof" }`
 * (`sources`: a write token for each read need's dataset, by need name).
 *
 * Settings, from the environment:
 * - `SOCIO_HARNESS_MANIFEST`: the manifest file (JSON), required;
 * - `HOST` (127.0.0.1) and `PORT` (4390; 0 picks a free one);
 * - `DATA_*`: the data space's limits, read as the server reads them
 *   (`dataSettingsFromEnv`), and `DATA_TOKEN_TTL_MINUTES`.
 *
 * Besides the plugin's routes, a test controls it on `/__harness/`:
 * `GET /__harness/info` (the JSON line again), `POST /__harness/reset`
 * (a fresh data space and token), `POST /__harness/renew` (a new token,
 * `{ datasets? }`) and `PUT /__harness/budget` (`{ statementsPerMinute }`,
 * as an admin sets it). Serve it on loopback or a test network only: it
 * hands out tokens to anyone who asks. `GET /healthz` answers 200 once it
 * listens, for the image's own healthcheck.
 */
import '@socio/foundation/no-vendor-telemetry';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';

import { createAdaptorServer } from '@hono/node-server';

import { dataSettingsFromEnv } from '../server/dataspace/limits.js';

import { startDataHarness } from './harness.js';

// stdout carries the one JSON line: the server's own log lines go to stderr.
const print = (line: string) => process.stdout.write(`${line}\n`);
console.log = (...args: unknown[]) => console.error(...args);

const path = process.env.SOCIO_HARNESS_MANIFEST?.trim();
if (!path) {
    console.error('SOCIO_HARNESS_MANIFEST must name the plugin manifest (JSON).');
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { id: string };
if (typeof manifest.id !== 'string' || !manifest.id) {
    console.error('The manifest has no id.');
    process.exit(2);
}
const host = process.env.HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? 4390);
const settings = dataSettingsFromEnv(process.env, tmpdir());
const harness = await startDataHarness({
    manifest,
    limits: settings.limits,
    analyticsMode: settings.analyticsMode,
    ...(settings.tokenTtlMs ? { tokenTtlMs: settings.tokenTtlMs } : {}),
    log: (line) => console.error(line),
});

let origin = '';
const info = () => ({
    origin,
    apiUrl: `${origin}/api`,
    dataUrl: `${origin}/api/data`,
    pluginId: harness.pluginId,
    token: harness.token,
    expiresAt: harness.expiresAt,
    datasets: harness.datasets,
    sources: harness.sources,
    identity: harness.identity,
    proof: harness.proof,
});

async function control(request: Request): Promise<Response> {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    try {
        const body = (request.method === 'GET' ? {} : await request.json().catch(() => ({}))) as Record<
            string,
            unknown
        >;
        if (route === 'GET /__harness/info') {
            return Response.json(info());
        }
        if (route === 'POST /__harness/reset') {
            await harness.reset();
            return Response.json(info());
        }
        if (route === 'POST /__harness/renew') {
            const datasets = Array.isArray(body.datasets) ? (body.datasets as string[]) : undefined;
            return Response.json(await harness.renew(datasets));
        }
        if (route === 'PUT /__harness/budget') {
            return Response.json(harness.setBudget((body.statementsPerMinute as number | null) ?? null));
        }
    } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
    }
    return Response.json({ error: 'Not a harness route.' }, { status: 404 });
}

const server = createAdaptorServer({
    fetch: (request: Request) => {
        const path = new URL(request.url).pathname;
        // The app image's own healthcheck (`healthcheck.js`) asks for `/healthz` on PORT.
        if (path === '/healthz') {
            return Response.json({ ok: true });
        }
        return path.startsWith('/__harness/') ? control(request) : harness.handle(request);
    },
    hostname: host,
}) as Server;
server.listen(port, host, () => {
    const address = server.address() as AddressInfo;
    origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
    print(JSON.stringify(info()));
});
const stop = () => {
    server.closeAllConnections();
    server.close(() => void harness.close().finally(() => process.exit(0)));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
