// The page loader bench. It seeds a
// workspace the size of a 200-person team after a year in a temporary
// directory (tests/fixtures/seed-workspace.ts), opens it as the server
// does, and calls each page loader's services in this process: 20 warm-up
// calls, then 200 timed ones, each on a fresh set of services (one page
// request), as the bench's admin and as its member.
//
//   pnpm run bench:loaders
//   pnpm run bench:loaders --runs 500 --scale 2 --only issues
//   pnpm run bench:loaders --keep   (leaves the seeded database)
//
// Budget per loader: p95 at most 20 ms and 64 kB of data; per document
// (the shell, the gates and the page's loader together; node:sqlite is
// synchronous, so they add up): p95 at most 50 ms. Run it on a quiet
// machine: on a shared host the times are noise. Sizes are the loader
// data as JSON; React Router's turbo-stream encoding is about the same.
//
// It also times client sources that are not page loaders (no budget),
// before and now, with their sizes as JSON and gzipped (as a compressing
// proxy sends them):
// - the ⌘K palette's pages: every Space's full page list, bodies included,
//   then `GET /api/pages/titles`;
// - the palette's issues (as an admin opened it before CB-325): the
//   whole issue list twice, then `GET /api/issues/titles` and
//   `?open=true`;
// - one poll of the sidebar's page tree for the largest Space: its full
//   page list, then `GET /api/spaces/:id/page-tree`.
// `--only palette` or `--only sidebar` runs just those.
//
// Last, the polls: each polled
// API answer through the app (createApp, in this process, gzip asked for
// as browsers do), as admin and member: a full answer (what every poll
// was before step 1) and a 304 to the tag it gave, with the bytes each
// sends (body and headers) and the time to the end of the answer; then
// what an idle tab's shell poll costs per minute both ways.
// `--only polls` runs just these.
import '@socio/foundation/no-vendor-telemetry';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values } = parseArgs({
    options: {
        runs: { type: 'string', default: '200' },
        warmup: { type: 'string', default: '20' },
        scale: { type: 'string', default: '1' },
        only: { type: 'string' },
        keep: { type: 'boolean', default: false },
    },
});
const runs = Number(values.runs);
const warmup = Number(values.warmup);
const scale = Number(values.scale);

const { seedWorkspace, SEED_SIZES } = await import('../tests/fixtures/seed-workspace.ts');
const { pageLoaders, pageUsers, shellLoader } = await import('../tests/fixtures/page-loaders.ts');
const { userServices } = await import('../src/server/web/services.ts');
const { issueTitlesView } = await import('../src/server/issues/views.ts');
const { pageTitlesView, pageTreeView } = await import('../src/server/pages/views.ts');
const { MockAuthProvider } = await import('../src/server/auth/mock.ts');

const LOADER_MS = 20;
const DOCUMENT_MS = 50;
const LOADER_BYTES = 64 * 1024;

const sizes = Object.fromEntries(
    Object.entries(SEED_SIZES).map(([key, value]) => [
        key,
        /Bytes$|^admins$/.test(key) ? value : Math.round(value * scale),
    ]),
);
const started = performance.now();
const seed = await seedWorkspace(sizes);
console.log(`Seeded in ${Math.round(performance.now() - started)} ms: ${seed.database}`);
const sources = {
    store: seed.store,
    config: seed.config,
    platform: seed.platform,
    auth: {
        provider: new MockAuthProvider(seed.users, 'bench-secret'),
        secureCookies: false,
    },
};
const servicesFor = (user) => userServices({ ...sources, views: seed.views }, async () => user);
// What the page views read, as `PagesViews`' layer hands it in.
const pageSources = {
    spaceAccess: seed.workspace.spaceAccess,
    pages: seed.workspace.pages,
    counters: seed.workspace.counters,
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value) => value.toFixed(1).padStart(6);

/** Times `run` on fresh services; returns p50, p95 and the last answer. */
async function measure(user, run) {
    for (let index = 0; index < warmup; index++) {
        await run(servicesFor(user));
    }
    const times = [];
    let data;
    for (let index = 0; index < runs; index++) {
        const services = servicesFor(user);
        const start = performance.now();
        data = await run(services);
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { p50: percentile(times, 50), p95: percentile(times, 95), data };
}

const loaders = [shellLoader, ...(await pageLoaders(seed))].filter(
    (loader) => !values.only || loader.page.includes(values.only) || loader.route.includes(values.only),
);
const rows = [];
for (const loader of loaders) {
    for (const user of pageUsers(seed, loader)) {
        const alone = await measure(user, (services) => loader.load(services, user));
        const document =
            loader === shellLoader
                ? alone
                : await measure(user, async (services) => {
                      await shellLoader.load(services, user);
                      return loader.load(services, user);
                  });
        const bytes = Buffer.byteLength(JSON.stringify(alone.data ?? null));
        const fits =
            (loader === shellLoader || alone.p95 <= LOADER_MS) &&
            document.p95 <= DOCUMENT_MS &&
            (loader === shellLoader || bytes <= LOADER_BYTES);
        rows.push({ loader, user, alone, document, bytes, fits });
        console.log(
            `${loader.page.padEnd(34)} ${user.role.padEnd(6)} p50 ${ms(alone.p50)} p95 ${ms(alone.p95)} ms  ${String(Math.round(bytes / 1024)).padStart(5)} kB  document p95 ${ms(document.p95)} ms  ${fits ? 'fits' : 'MISSES'}`,
        );
    }
}

// Client sources: each answer serialized as its route does.
const { workspace } = seed.platform;
const [largest] = workspace
    .spaces()
    .map((space) => ({ id: space.id, pages: workspace.pages.titles(space.id) }))
    .sort((a, b) => b.pages.length - a.pages.length);
const clientSources = [
    {
        name: 'palette pages, before (Space lists)',
        answers: () => workspace.spaces().map((space) => JSON.stringify(workspace.pages.list(space.id))),
    },
    {
        name: 'palette pages, now (titles only)',
        answers: () => [JSON.stringify(pageTitlesView(pageSources, seed.admin.id))],
    },
    {
        // The list had every issue's body until CB-71.
        name: 'palette issues, before (issue list x2)',
        answers: async () => [
            JSON.stringify(await seed.platform.board.issues.list()),
            JSON.stringify(await seed.platform.board.issues.list()),
        ],
    },
    {
        name: 'palette issues, now (titles only)',
        answers: async () => [
            JSON.stringify(await issueTitlesView(seed.platform.board)),
            JSON.stringify(await issueTitlesView(seed.platform.board, { open: true })),
        ],
    },
    {
        name: `sidebar tree, before (${largest.pages.length} pages)`,
        answers: () => [JSON.stringify(workspace.pages.list(largest.id))],
    },
    {
        name: 'sidebar tree, now (titles only)',
        answers: () => [JSON.stringify(pageTreeView(pageSources, seed.admin.id, largest.id))],
    },
];
for (const source of clientSources.filter((source) => !values.only || source.name.startsWith(values.only))) {
    const { p50, p95, data } = await measure(null, source.answers);
    const kB = (size) => String(Math.round(size / 1024)).padStart(5);
    const total = (size) => data.reduce((sum, answer) => sum + size(answer), 0);
    const bytes = total((answer) => Buffer.byteLength(answer));
    const gzipped = total((answer) => gzipSync(answer).length);
    console.log(
        `${source.name.padEnd(41)} p50 ${ms(p50)} p95 ${ms(p95)} ms  ${kB(bytes)} kB (${kB(gzipped).trim()} kB gzipped) in ${data.length} ${data.length === 1 ? 'request' : 'requests'}`,
    );
}

// Polls through the app: a full answer, then a 304 to its tag.
const { createApp } = await import('../src/server/app.ts');
const { Runner } = await import('../tests/helpers/runners.ts');
const { learningContainers } = await import('../src/server/learning/views.ts');
const app = createApp({
    store: seed.store,
    runner: new Runner(seed.store, seed.config),
    config: seed.config,
    edge: seed.edge,
    auth: sources.auth,
});
const cookies = new Map();
for (const user of [seed.admin, seed.member]) {
    const login = await app.request('/api/auth/mock/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
    });
    cookies.set(user.id, login.headers.get('set-cookie').split(';')[0]);
}
/** One answer read to its end: status, bytes sent (headers too), ms. */
async function poll(user, path, tag) {
    const start = performance.now();
    const response = await app.request(path, {
        headers: {
            cookie: cookies.get(user.id),
            'Accept-Encoding': 'gzip, deflate, br, zstd',
            ...(tag ? { 'If-None-Match': tag } : {}),
        },
    });
    const body = (await response.arrayBuffer()).byteLength;
    const time = performance.now() - start;
    let headers = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`.length;
    for (const [name, value] of response.headers) {
        headers += `${name}: ${value}\r\n`.length;
    }
    return {
        status: response.status,
        tag: response.headers.get('etag'),
        bytes: body + headers + 2,
        time,
    };
}
async function pollTimes(user, path, tag) {
    for (let index = 0; index < warmup; index++) {
        await poll(user, path, tag);
    }
    const times = [];
    let last;
    for (let index = 0; index < runs; index++) {
        last = await poll(user, path, tag);
        times.push(last.time);
    }
    times.sort((a, b) => a - b);
    return { ...last, p50: percentile(times, 50), p95: percentile(times, 95) };
}
const [container] = learningContainers({
    evidence: seed.platform.learning.evidence,
    skills: seed.platform.learning.skills,
    socios: seed.workspace,
});
const polled = [
    { path: '/api/state', every: 3 },
    { path: '/api/workspace', every: 3 },
    { path: '/api/issues', every: 15 },
    { path: `/api/spaces/${largest.id}/pages`, every: 3 },
    { path: `/api/spaces/${largest.id}/page-tree`, every: 3 },
    { path: '/api/runs', every: 10, admins: true },
    ...(container
        ? [
              {
                  path: `/api/learning/containers/${container}?bodies=false`,
                  every: 3,
                  admins: true,
              },
          ]
        : []),
    { path: '/api/schedules', every: 10 },
];
const pollRows = [];
if (!values.only || values.only === 'polls') {
    console.log(
        `\n${'Poll'.padEnd(40)} ${'as'.padEnd(6)} ${'full (200)'.padStart(22)} ${'unchanged (304)'.padStart(22)}`,
    );
    for (const entry of polled) {
        for (const user of entry.admins ? [seed.admin] : [seed.admin, seed.member]) {
            const full = await pollTimes(user, entry.path);
            const unchanged = await pollTimes(user, entry.path, full.tag);
            if (full.status !== 200 || unchanged.status !== 304) {
                throw new Error(`${entry.path}: ${full.status} then ${unchanged.status}, not 200 then 304`);
            }
            pollRows.push({ ...entry, user, full, unchanged });
            const cell = (row) => `${(row.bytes / 1024).toFixed(1).padStart(7)} kB ${ms(row.p50)} ms`;
            const label = entry.path.replace(largest.id, ':id').replace(container, ':id');
            console.log(
                `${label.padEnd(40)} ${user.role.padEnd(6)} ${cell(full).padStart(22)} ${cell(unchanged).padStart(22)}`,
            );
        }
    }
    // An idle tab: the shell's two polls every 3 s, nothing changing.
    for (const user of [seed.admin, seed.member]) {
        const shell = pollRows.filter(
            (row) => row.user === user && row.every === 3 && /state|workspace$/.test(row.path),
        );
        const perMinute = (pick) => shell.reduce((sum, row) => sum + (60 / row.every) * pick(row).bytes, 0);
        const msPerPoll = (pick) => shell.reduce((sum, row) => sum + pick(row).p50, 0);
        console.log(
            `Idle tab, shell polls, ${user.role.padEnd(6)}: before ${(perMinute((row) => row.full) / 1024).toFixed(1)} kB/min, ${msPerPoll((row) => row.full).toFixed(2)} ms per poll; now ${(perMinute((row) => row.unchanged) / 1024).toFixed(1)} kB/min, ${msPerPoll((row) => row.unchanged).toFixed(2)} ms per poll`,
        );
    }
}

console.log(
    `\n${runs} calls after ${warmup} warm-ups, scale ${scale}. Budget: loader p95 ${LOADER_MS} ms and ${LOADER_BYTES / 1024} kB; document p95 ${DOCUMENT_MS} ms.`,
);
await seed.close({ keep: values.keep });
if (values.keep) {
    console.log(`Kept: ${seed.dir}`);
}
process.exitCode = rows.every((row) => row.fits) ? 0 : 1;
