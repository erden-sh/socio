// The compression bench. It
// seeds the loader bench's workspace (tests/fixtures/seed-workspace.ts),
// builds the app as the server does (createApp, the security headers and
// the production page build in dist/web, so run `pnpm run build` first),
// and asks each URL in this process, as the bench's admin: plainly and
// with `Accept-Encoding: gzip`. For each it prints the bytes sent and the
// CPU time per response (p50, the whole process, compression threads
// included), the difference compression makes, the same on the main
// thread alone (CompressionStream deflates on libuv's threads), and the
// CPU of zlib alone on the same body (gzipSync, at the default level
// CompressionStream uses).
//
//   pnpm run bench:compression
//   pnpm run bench:compression --runs 100 --scale 2
//
// Run it on a quiet machine: on a shared host the times are noise.
import '@socio/foundation/no-vendor-telemetry';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values } = parseArgs({
    options: {
        runs: { type: 'string', default: '50' },
        warmup: { type: 'string', default: '10' },
        scale: { type: 'string', default: '1' },
    },
});
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const scale = Number(values.scale);

const { seedWorkspace, SEED_SIZES } = await import('../tests/fixtures/seed-workspace.ts');
const { createApp } = await import('../src/server/app.ts');
const { MockAuthProvider } = await import('../src/server/auth/mock.ts');
const { requestUserResolver } = await import('../src/server/auth/request-user.ts');
const { Runner } = await import('../tests/helpers/runners.ts');
const { securityHeaders } = await import('@socio/foundation/http/security-headers');
const { mountWeb } = await import('../src/server/web/mount.ts');
const { productionWeb } = await import('../src/server/web/prod.ts');
const { webServices } = await import('../src/server/web/services.ts');

const sizes = Object.fromEntries(
    Object.entries(SEED_SIZES).map(([key, value]) => [
        key,
        /Bytes$|^admins$/.test(key) ? value : Math.round(value * scale),
    ]),
);
const seed = await seedWorkspace(sizes);
const auth = {
    provider: new MockAuthProvider(seed.users, 'bench-secret-0123456789abcdef'),
    secureCookies: false,
};
const runner = new Runner(seed.store, seed.config);
const app = createApp({
    store: seed.store,
    runner,
    config: seed.config,
    edge: seed.edge,
    auth,
});
app.use('*', securityHeaders);
mountWeb(app, {
    ...(await productionWeb()),
    services: webServices(
        {
            store: seed.store,
            config: seed.config,
            platform: seed.platform,
            views: seed.views,
            auth,
        },
        requestUserResolver(auth, seed.platform),
    ),
});
const login = await app.request('/api/auth/mock/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: seed.admin.id }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const median = (list) =>
    percentile(
        [...list].sort((a, b) => a - b),
        50,
    );

/**
 * Bytes, CPU (ms, every thread) and main-thread time (ms, the event loop
 * busy) of one response, read to its end.
 */
async function ask(path, gzip) {
    const loop = performance.eventLoopUtilization();
    const cpu = process.cpuUsage();
    const response = await app.request(path, {
        headers: { cookie, ...(gzip ? { 'Accept-Encoding': 'gzip' } : {}) },
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const used = process.cpuUsage(cpu);
    const busy = performance.eventLoopUtilization(loop).active;
    if (response.status !== 200) {
        throw new Error(`${path}: ${response.status} ${response.statusText}`);
    }
    return {
        body,
        bytes: body.byteLength,
        cpu: (used.user + used.system) / 1000,
        busy,
        encoding: response.headers.get('content-encoding'),
    };
}

async function measure(path, gzip) {
    for (let index = 0; index < warmup; index++) {
        await ask(path, gzip);
    }
    const answers = [];
    for (let index = 0; index < runs; index++) {
        answers.push(await ask(path, gzip));
    }
    return {
        body: answers.at(-1).body,
        bytes: answers.at(-1).bytes,
        encoding: answers.at(-1).encoding,
        cpu: median(answers.map((answer) => answer.cpu)),
        busy: median(answers.map((answer) => answer.busy)),
    };
}

/** CPU (ms, p50) of gzipping `body` alone, at zlib's default level. */
function zlibAlone(body) {
    const times = [];
    for (let index = 0; index < runs; index++) {
        const cpu = process.cpuUsage();
        gzipSync(body);
        const used = process.cpuUsage(cpu);
        times.push((used.user + used.system) / 1000);
    }
    return median(times);
}

const kB = (bytes) => `${(bytes / 1024).toFixed(1)} kB`.padStart(10);
const ms = (value) => `${value.toFixed(2)} ms`.padStart(9);
console.log(
    `${'URL'.padEnd(18)} ${'plain'.padStart(10)} ${'gzip'.padStart(10)} ratio   CPU plain    gzip    added  main thread added  zlib alone`,
);
for (const path of ['/api/state', '/api/workspace', '/api/issues', '/', '/issues', '/issues.data']) {
    const plain = await measure(path, false);
    const gzipped = await measure(path, true);
    if (plain.encoding || gzipped.encoding !== 'gzip') {
        throw new Error(`${path}: unexpected encodings`);
    }
    console.log(
        `${path.padEnd(18)} ${kB(plain.bytes)} ${kB(gzipped.bytes)} ${`${((gzipped.bytes / plain.bytes) * 100).toFixed(0)}%`.padStart(5)} ${ms(plain.cpu)} ${ms(gzipped.cpu)} ${ms(gzipped.cpu - plain.cpu)} ${ms(gzipped.busy - plain.busy).padStart(18)} ${ms(zlibAlone(plain.body)).padStart(11)}`,
    );
}
console.log(`\nCPU: p50 of ${runs} responses after ${warmup} warm-ups, scale ${scale}, as ${seed.admin.role}.`);
runner.stop();
await seed.close();
