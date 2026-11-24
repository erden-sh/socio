// The page search bench. It seeds a
// workspace the size of a 200-person team after a year in a temporary
// directory (tests/fixtures/seed-workspace.ts, which loads
// no-vendor-telemetry first), opens it as the server does, and measures
// in this process:
// - the index's sizes (dbstat) and how long filling it takes (as the
//   migration's backfill does), and FTS5's 'rebuild' of each index;
// - each query kind through `Pages.search` (the store method the
//   route and the Dots' tool call): 20 warm-up runs, then 200 timed ones,
//   as a member (every Space) and as a Dot (one Space);
// - saves, a 100,000-character page and deletes, with the index;
// - what the app's own daily rollup recorded for the same queries.
//
//   pnpm run bench:search
//   pnpm run bench:search --runs 500 --scale 2 --only typo
//   pnpm run bench:search --keep   (leaves the seeded database)
//
// Budget: p95 at most 20 ms for each query kind. Run it on a quiet
// machine: on a shared host the times are noise. Compare runs from the
// same machine only.
import { parseArgs } from 'node:util';

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
const QUERY_MS = 20;

const { seedWorkspace, SEED_SIZES } = await import('../tests/fixtures/seed-workspace.ts');
const { pageText } = await import('@socio/shared/pages/page-text');

const sizes = Object.fromEntries(
    Object.entries(SEED_SIZES).map(([key, value]) => [
        key,
        /Bytes$|^admins$/.test(key) ? value : Math.round(value * scale),
    ]),
);
const started = performance.now();
const seed = await seedWorkspace(sizes);
console.log(`Seeded in ${Math.round(performance.now() - started)} ms: ${seed.database}`);
const { workspace } = seed.platform;
const { db, pages } = workspace;

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const ms = (value) => value.toFixed(1).padStart(6);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function time(run, count = runs, warm = warmup) {
    for (let index = 0; index < warm; index++) {
        run(index);
    }
    const times = [];
    let last;
    for (let index = 0; index < count; index++) {
        const start = performance.now();
        last = run(index);
        times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return {
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        max: times.at(-1),
        last,
    };
}

// Some freshness from use, as people opening search results would leave.
const spaces = workspace.spaces().map((space) => space.id);
const ids = db.prepare('SELECT id, spaceId FROM pages WHERE deletedAt IS NULL').all();
const people = seed.users.slice(0, 50);
await workspace.data.uow.run(async () => {
    for (let index = 0; index < 600; index++) {
        const page = ids[(index * 7919) % ids.length];
        await pages.noteUse(
            page.spaceId,
            page.id,
            people[index % people.length].id,
            Date.now() - (index % 20) * 86_400_000,
        );
    }
});

// Sizes, and the backfill as the migration does it.
const markdownBytes = Number(db.prepare('SELECT SUM(LENGTH(content)) AS n FROM pages WHERE deletedAt IS NULL').get().n);
const index = pages.searchStats(1).now;
console.log(
    `\nIndex over ${index.pages} pages (${mb(markdownBytes)} of Markdown): words ${mb(index.wordBytes)}, trigram ${mb(index.trigramBytes)}, text copy ${mb(index.textBytes)}; total ${mb(index.wordBytes + index.trigramBytes + index.textBytes)}`,
);
const sizeTime = time(() => pages.searchStats(1), 5, 1);
console.log(`Measuring the sizes (dbstat): p50 ${ms(sizeTime.p50)} ms`);
{
    const rows = db
        .prepare('SELECT id, spaceId, title, content FROM pages WHERE deletedAt IS NULL ORDER BY createdAt, id')
        .all();
    const start = performance.now();
    db.exec('BEGIN');
    db.exec('DELETE FROM page_search');
    const insert = db.prepare('INSERT INTO page_search(pageId, spaceId, title, body) VALUES (?, ?, ?, ?)');
    let extract = 0;
    for (const row of rows) {
        const at = performance.now();
        const body = pageText(row.content);
        extract += performance.now() - at;
        insert.run(row.id, row.spaceId, row.title, body);
    }
    db.exec('COMMIT');
    console.log(
        `Backfill (text, insert, both indexes): ${Math.round(performance.now() - start)} ms, of which text extraction ${Math.round(extract)} ms`,
    );
    for (const table of ['page_search_fts', 'page_search_tri']) {
        const at = performance.now();
        db.exec(`INSERT INTO ${table}(${table}) VALUES ('rebuild')`);
        const rebuild = performance.now() - at;
        const check = performance.now();
        db.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`);
        console.log(
            `  ${table}: rebuild ${Math.round(rebuild)} ms, integrity-check ${Math.round(performance.now() - check)} ms`,
        );
    }
}

// Queries, as typed.
const one = [spaces[1] ?? spaces[0]];
const kinds = [
    ['one word', 'invoice'],
    ['2 letters', 'in'],
    ['4 letters', 'invo'],
    ['two words', 'budget review'],
    ['four words', 'offsite renewal pricing travel'],
    ['inside a word (trigram)', 'nvoic'],
    ['inside two words (trigram)', 'udge evie'],
    ['no match', 'zebra'],
    ['typo, corrected', 'invioce'],
    ['typo, exact', 'invioce', { exact: true }],
    ['second page', 'invoice', { offset: 8 }],
].filter(([name]) => !values.only || name.includes(values.only));
const results = [];
// Fresh rollup for this run's queries only.
db.exec('DELETE FROM page_search_daily');
pages.flushSearchStats();
console.log('\nQueries (8 results with snippets), p50 / p95 / max ms; member: all Spaces, Dot: one');
for (const [name, query, extra = {}] of kinds) {
    const row = { name, query };
    for (const [who, within] of [
        ['member', spaces],
        ['dot', one],
    ]) {
        const measured = time(() => pages.search({ query, spaces: within, ...extra }));
        row[who] = measured;
    }
    const answer = row.member.last;
    const fits = row.member.p95 <= QUERY_MS && row.dot.p95 <= QUERY_MS;
    results.push({ ...row, fits });
    console.log(
        `${name.padEnd(28)} ${JSON.stringify(query).padEnd(34)} member ${ms(row.member.p50)} ${ms(row.member.p95)} ${ms(row.member.max)}   dot ${ms(row.dot.p50)} ${ms(row.dot.p95)} ${ms(row.dot.max)}   ${String(answer.results.length).padStart(2)} hits${answer.corrected ? ` (→ ${answer.corrected})` : ''}${answer.results.some((hit) => hit.matched === 'text') ? ' (trigram)' : ''}  ${fits ? 'fits' : 'MISSES'}`,
    );
}

// Writes with the index, as the store does them.
console.log('\nWrites, p50 / p95 / max ms');
{
    const space = spaces[0];
    const target = pages.create(space, {
        title: 'Bench page',
        content: 'start',
    });
    let revision = target.revision;
    const save = time(
        (index) => {
            revision = pages.update(space, target.id, {
                content: `Edited ${index} ${'budget review invoice '.repeat(180)}`,
                expectedRevision: revision,
            }).revision;
        },
        100,
        5,
    );
    const big = 'The vendor contract renewal and pricing. '.repeat(2500).slice(0, 100_000);
    const created = [];
    const large = time(() => created.push(pages.create(space, { title: 'Large page', content: big }).id), 20, 2);
    const remove = time(
        (index) => pages.delete(space, created[index % created.length]),
        Math.min(20, created.length),
        0,
    );
    for (const [name, measured] of [
        ['page saved (4 KB)', save],
        ['100,000-character page created', large],
        ['100,000-character page deleted', remove],
    ]) {
        console.log(`${name.padEnd(32)} ${ms(measured.p50)} ${ms(measured.p95)} ${ms(measured.max)}`);
    }
}

// What the app's own rollup recorded for the queries above.
pages.flushSearchStats();
const [today] = pages.searchStats(1).days;
if (today) {
    console.log(
        `\nThe app's rollup for these queries: ${today.queries} searches, ${today.empty} with nothing found, ${today.corrected} corrected, ${today.trigram} filled in by trigram; p50 ${today.p50} ms, p95 ${today.p95} ms, p99 ${today.p99} ms, max ${today.maxMs} ms`,
    );
}

console.log(`\n${runs} runs after ${warmup} warm-ups, scale ${scale}. Budget: p95 ${QUERY_MS} ms per query kind.`);
await seed.close({ keep: values.keep });
if (values.keep) {
    console.log(`Kept: ${seed.dir}`);
}
process.exitCode = results.every((row) => row.fits) ? 0 : 1;
