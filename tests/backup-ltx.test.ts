import { randomBytes } from 'node:crypto';
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { ObjectStore } from '@socio/data/object-store';
import { SecretBox } from '@socio/foundation/keys/secret-box';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import {
    LTX_BACKOFF_MAX_MS,
    fetchContinuousCopy,
    ltxTimestamp,
    ltxWaitMs,
    readLtxState,
    shipContinuousCopy,
} from '../src/server/backup/backup-ltx.js';
import { BACKUP_CONTEXT } from '../src/server/backup/backup-offsite.js';
import { BackupService, backupFailure, backupSettingsFromEnv } from '../src/server/backup/backup-service.js';
import { S3ObjectStore } from '../src/server/storage/s3-store.js';

import { startFakeS3 } from './fixtures/fake-s3.js';
import { memoryTmpdir } from './helpers/memory-tmpdir.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// The continuous copy off-site (CB-112): Litestream's LTX files, sealed,
// to a loopback fake S3; never a real endpoint.

const SECRET = 'backup-ltx-test-secret-0123456789';
const KEY = randomBytes(32);
const MARK = 'PLAINTEXT-PAGE-OF-THE-DATABASE';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
const scratch = (name: string) => {
    const dir = mkdtempSync(join(memoryTmpdir(), name));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

const hex = (n: number) => n.toString(16).padStart(16, '0');
const ltxName = (min: number, max: number) => `${hex(min)}-${hex(max)}.ltx`;
/** An LTX file as Litestream 0.5 frames one: `LTX1`, the header, pages, the trailer. */
function ltx(min: number, max: number, at: number, extra = '') {
    const body = Buffer.alloc(100 + 64 + 16);
    body.write('LTX1', 0, 'ascii');
    body.writeUInt32BE(4096, 8);
    body.writeBigUInt64BE(BigInt(min), 16);
    body.writeBigUInt64BE(BigInt(max), 24);
    body.writeBigInt64BE(BigInt(at), 32);
    body.write(`${MARK}${extra}`, 100, 'ascii');
    return body;
}
const AT = Date.UTC(2026, 9, 20, 9, 0, 0);

/**
 * The transaction a restore from these `<level>/<name>` files gets to, as
 * Litestream 0.5 plans one (CalcRestorePlan): the newest snapshot, then
 * levels 8 down to 0, each from its oldest file, skipping files it already
 * holds. A file that starts past the next transaction is a gap, and the
 * restore fails: that is what this returns then.
 */
function restorePoint(files: string[]) {
    const spans = files.map((file) => {
        const [, level, min, max] = file.match(/^(\d+)\/([0-9a-f]{16})-([0-9a-f]{16})\.ltx/)!;
        return {
            file,
            level: Number(level),
            min: BigInt(`0x${min}`),
            max: BigInt(`0x${max}`),
        };
    });
    let txid = 0n;
    for (const { level, max } of spans) {
        if (level === 9 && max > txid) {
            txid = max;
        }
    }
    for (let level = 8; level >= 0; level--) {
        for (const { file, min, max } of spans
            .filter((span) => span.level === level)
            .sort((a, b) => (a.min < b.min ? -1 : 1))) {
            if (max <= txid) {
                continue;
            }
            if (min > txid + 1n) {
                return `a gap before ${file}`;
            }
            txid = max;
        }
    }
    return Number(txid);
}

async function fixture() {
    const dir = scratch('cb-ltx-');
    const replica = join(dir, 'litestream', 'company-brain');
    const fake = await startFakeS3();
    cleanup.push(() => fake.close());
    const target = new S3ObjectStore(fake.settings({ bucket: 'offsite' }), {
        backoffMs: 1,
        retries: 0,
    });
    const box = new SecretBox({ current: KEY, legacy: SECRET }, 'backups');
    const state = join(dir, 'backups', 'offsite-ltx.json');
    let now = AT;
    const write = (level: number, min: number, max: number, extra = '') => {
        const path = join(replica, 'ltx', String(level), ltxName(min, max));
        mkdirSync(join(replica, 'ltx', String(level)), { recursive: true });
        // Dated by its transaction, a rewrite a little later.
        const at = AT + max * 1000 + (extra ? 500 : 0);
        writeFileSync(path, ltx(min, max, at, extra));
        utimesSync(path, at / 1000, at / 1000);
        return path;
    };
    const remove = (level: number, min: number, max: number) =>
        rmSync(join(replica, 'ltx', String(level), ltxName(min, max)));
    const ship = () =>
        shipContinuousCopy({
            target,
            prefix: 'company-brain/',
            box,
            replica,
            state,
            reason: backupFailure,
            now: () => now,
        });
    /** The key of a file of this copy's lineage. */
    const key = (file: string) => `offsite/company-brain/litestream/${readLtxState(state).lineage}/ltx/${file}`;
    /** This copy's files off-site, as `<level>/<name>.ltx.sealed`. */
    const remote = () =>
        [...fake.objects.keys()]
            .filter((name) => name.startsWith(key('')))
            .map((name) => name.slice(key('').length))
            .sort();
    const puts = () => fake.requests.filter((request) => request.method === 'PUT').length;
    return {
        dir,
        replica,
        fake,
        target,
        box,
        state,
        write,
        remove,
        ship,
        key,
        remote,
        puts,
        tick: (ms: number) => (now += ms),
        now: () => now,
    };
}

it('seals each new LTX file and sends it once, across restarts', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(0, 4, 4);
    f.write(0, 5, 5);
    expect(await f.ship()).toEqual({
        files: 3,
        sent: 3,
        bytes: expect.any(Number),
        waiting: 0,
        removed: 0,
        // Its first send starts this copy's lineage, the time it started first.
        started: {
            lineage: expect.stringMatching(/^20261020T090000Z-[0-9a-f]{6}$/),
            others: 0,
        },
    });
    expect(f.remote()).toEqual([`0/${ltxName(4, 4)}.sealed`, `0/${ltxName(5, 5)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    // Sealed under the data key, bound like the rest of the off-site copy.
    expect(f.fake.allBytes().toString('latin1')).not.toContain(MARK);
    const sealed = f.fake.objects.get(f.key(`0/${ltxName(4, 4)}.sealed`))!;
    expect(f.box.openBytes(sealed, BACKUP_CONTEXT)).toEqual(ltx(4, 4, AT + 4000));
    expect(readLtxState(f.state)).toMatchObject({
        lastAttemptAt: AT,
        lastSentAt: AT,
        waiting: 0,
        failures: 0,
    });
    // The state names files and sizes, never their contents or keys.
    expect(readFileSync(f.state, 'utf8')).not.toContain(MARK);
    expect(statSync(f.state).mode & 0o777).toBe(0o600);

    // Nothing new: nothing sent, by this run or after a restart (the state
    // is read from disk each time).
    const before = f.puts();
    expect((await f.ship()).sent).toBe(0);
    expect(f.puts()).toBe(before);
    // Touched but unchanged: compared by hash, still not sent.
    const later = new Date(AT + 3_600_000);
    utimesSync(join(f.replica, 'ltx', '0', ltxName(5, 5)), later, later);
    expect((await f.ship()).sent).toBe(0);
    expect(f.puts()).toBe(before);
    // A new file goes, and only it.
    f.write(0, 6, 6);
    expect((await f.ship()).sent).toBe(1);
    expect(f.puts()).toBe(before + 1);
    // Changed under the same name (a database restored behind the replica):
    // sent again.
    f.write(0, 6, 6, 'rewritten');
    expect((await f.ship()).sent).toBe(1);
    // Gone from the target: sent again.
    f.fake.objects.delete(f.key(`9/${ltxName(1, 3)}.sealed`));
    expect((await f.ship()).sent).toBe(1);
    expect(f.remote()).toHaveLength(4);
});

it('sends whole files only, and removes nothing while one waits', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(0, 4, 4);
    await f.ship();
    // Litestream's temporary file while it writes, and stray names: skipped.
    const level1 = join(f.replica, 'ltx', '1');
    mkdirSync(level1, { recursive: true });
    writeFileSync(join(level1, `${ltxName(4, 5)}.tmp`), ltx(4, 5, AT));
    writeFileSync(join(level1, 'notes.txt'), 'hello');
    mkdirSync(join(f.replica, 'ltx', 'tmp'), { recursive: true });
    writeFileSync(join(f.replica, 'ltx', 'tmp', ltxName(4, 5)), ltx(4, 5, AT));
    // A cut-off file under a final name: not an LTX file, so it waits.
    writeFileSync(join(level1, ltxName(4, 6)), Buffer.from('LTX1short'));
    // Compaction moved on meanwhile: the level 0 file is gone locally.
    f.remove(0, 4, 4);
    const result = await f.ship();
    expect(result).toMatchObject({ sent: 0, waiting: 1, removed: 0 });
    // The level 0 file stays off-site: the file waiting may replace it.
    expect(f.remote()).toEqual([`0/${ltxName(4, 4)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    expect(readLtxState(f.state)).toMatchObject({ waiting: 1, lastSentAt: AT });
    // Once whole, it goes, and then the file it replaced is removed.
    f.tick(60_000);
    writeFileSync(join(level1, ltxName(4, 6)), ltx(4, 6, AT));
    expect(await f.ship()).toMatchObject({ sent: 1, waiting: 0, removed: 1 });
    expect(f.remote()).toEqual([`1/${ltxName(4, 6)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    expect(readLtxState(f.state).lastSentAt).toBe(AT + 60_000);
});

it('mirrors compaction and retention, never removing what a restore needs', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    for (const txid of [4, 5, 6]) {
        f.write(0, txid, txid);
    }
    await f.ship();
    expect(f.remote()).toHaveLength(4);
    // Litestream compacts level 0 into level 1, then removes level 0's files.
    f.write(1, 4, 6);
    for (const txid of [4, 5, 6]) {
        f.remove(0, txid, txid);
    }
    f.write(0, 7, 7);
    expect(await f.ship()).toMatchObject({ sent: 2, removed: 3 });
    expect(f.remote()).toEqual([`0/${ltxName(7, 7)}.sealed`, `1/${ltxName(4, 6)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    // Retention: a new snapshot, the older one and what came before it go.
    f.write(9, 1, 7);
    f.remove(9, 1, 3);
    f.remove(1, 4, 6);
    expect(await f.ship()).toMatchObject({ sent: 1, removed: 2 });
    expect(f.remote()).toEqual([`0/${ltxName(7, 7)}.sealed`, `9/${ltxName(1, 7)}.sealed`]);
    expect(Object.keys(readLtxState(f.state).sent).sort()).toEqual([`0/${ltxName(7, 7)}`, `9/${ltxName(1, 7)}`]);
    // An empty or missing replica (unmounted, not started) removes nothing.
    rmSync(join(f.replica, 'ltx'), { recursive: true });
    expect(await f.ship()).toMatchObject({ files: 0, removed: 0 });
    expect(f.remote()).toHaveLength(2);
    // Objects of the daily snapshots, and others under the prefix, stay.
    f.fake.objects.set('offsite/company-brain/snapshots/x/complete', Buffer.from('x'));
    f.write(9, 1, 8);
    await f.ship();
    expect(f.fake.objects.has('offsite/company-brain/snapshots/x/complete')).toBe(true);
});

it('removes nothing, and sends nothing after it, when a file compacted away mid-send never got off-site', async () => {
    const f = await fixture();
    f.write(9, 1, 10);
    f.write(0, 11, 11);
    await f.ship();
    for (const txid of [12, 13, 14]) {
        f.write(0, txid, txid);
    }
    // Once this send listed the replica, Litestream compacts 11 to 13 into
    // level 1 and removes their level 0 files, before they are read: their
    // transactions are now in a file this send didn't list.
    const list = f.target.list.bind(f.target);
    f.target.list = async (prefix, cursor) => {
        f.target.list = list;
        f.write(1, 11, 13);
        for (const txid of [11, 12, 13]) {
            f.remove(0, txid, txid);
        }
        return list(prefix, cursor);
    };
    f.tick(60_000);
    // 14 waits too: sent alone, it would leave a gap after 11 that a restore
    // can't cross.
    expect(await f.ship()).toMatchObject({ sent: 0, waiting: 1, removed: 0 });
    expect(f.remote()).toEqual([`0/${ltxName(11, 11)}.sealed`, `9/${ltxName(1, 10)}.sealed`]);
    expect(restorePoint(f.remote())).toBe(11);
    expect(readLtxState(f.state).lastSentAt).toBe(AT);
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({ sent: 2, waiting: 0, removed: 1 });
    expect(f.remote()).toEqual([
        `0/${ltxName(14, 14)}.sealed`,
        `1/${ltxName(11, 13)}.sealed`,
        `9/${ltxName(1, 10)}.sealed`,
    ]);
    expect(restorePoint(f.remote())).toBe(14);
    expect(readLtxState(f.state).lastSentAt).toBe(AT + 120_000);
});

it('sends the highest level first, so a send cut short leaves no gap', async () => {
    const f = await fixture();
    f.write(9, 1, 10);
    f.write(0, 11, 11);
    await f.ship();
    expect(restorePoint(f.remote())).toBe(11);
    // Sends fail for longer than Litestream keeps level 0: 12 and 13 are
    // compacted into level 1 with 11, and their level 0 files removed.
    f.write(1, 11, 13);
    f.remove(0, 11, 11);
    f.write(0, 14, 14);
    // The next send stops after its first put (it fails, or the host dies).
    const put = f.target.put.bind(f.target);
    f.target.put = async (key, body) => {
        f.target.put = async () => {
            throw new Error('cut short');
        };
        await put(key, body);
    };
    f.tick(600_000);
    await expect(f.ship()).rejects.toThrow('cut short');
    // Level 1's file went first: the lineage restores further than before.
    expect(f.remote()).toEqual([
        `0/${ltxName(11, 11)}.sealed`,
        `1/${ltxName(11, 13)}.sealed`,
        `9/${ltxName(1, 10)}.sealed`,
    ]);
    expect(restorePoint(f.remote())).toBe(13);
    // The next one sends the rest (level 1's again: the send cut short may
    // not have recorded it), then removes what level 1 replaced.
    f.target.put = put;
    expect(await f.ship()).toMatchObject({ sent: 2, waiting: 0, removed: 1 });
    expect(f.remote()).toEqual([
        `0/${ltxName(14, 14)}.sealed`,
        `1/${ltxName(11, 13)}.sealed`,
        `9/${ltxName(1, 10)}.sealed`,
    ]);
    expect(restorePoint(f.remote())).toBe(14);
});

it.skipIf(process.getuid?.() === 0)('keeps its lineage while level 0 can’t be read', async () => {
    const f = await fixture();
    f.write(9, 1, 10);
    f.write(1, 1, 12);
    f.write(0, 13, 13);
    await f.ship();
    const lineage = readLtxState(f.state).lineage;
    // Without level 0 the replica's highest transaction looks behind the one
    // sent, as if Litestream had started over; it hasn't.
    const level0 = join(f.replica, 'ltx', '0');
    chmodSync(level0, 0);
    cleanup.push(() => chmodSync(level0, 0o755));
    f.tick(60_000);
    await expect(f.ship()).rejects.toThrow("can't be read (EACCES)");
    expect(readLtxState(f.state).lineage).toBe(lineage);
    chmodSync(level0, 0o755);
    f.write(0, 14, 14);
    expect(await f.ship()).toMatchObject({ sent: 1 });
    expect(readLtxState(f.state).lineage).toBe(lineage);
    const lineages = new Set(
        [...f.fake.objects.keys()].flatMap((key) => key.match(/\/litestream\/([^/]+)\//)?.[1] ?? []),
    );
    expect([...lineages]).toEqual([lineage]);
    expect(restorePoint(f.remote())).toBe(14);
});

// Litestream compacts and drops files at any time, also while a send
// waits on the target; sends fail, and the host dies mid-send. Seeded, so
// a failure replays.
it.each([1, 2, 3, 4])(
    'keeps the newest lineage restorable after every step, whatever Litestream does meanwhile (seed %i)',
    async (seed) => {
        const dir = scratch('cb-ltx-sim-');
        const replica = join(dir, 'replica');
        const state = join(dir, 'offsite-ltx.json');
        const box = new SecretBox({ current: KEY, legacy: SECRET }, 'backups');
        let random = seed;
        const rnd = () => {
            random = (Math.imul(random, 1103515245) + 12345) & 0x7fffffff;
            return random / 0x7fffffff;
        };

        // Litestream, roughly: level 0 per write, compacted into level 1 and
        // removed a while after, level 1 into level 2 (half the seeds remove
        // level 1's files then), a snapshot now and then, the 3 newest kept
        // and the files before the oldest of them removed.
        const levelDir = (level: number) => join(replica, 'ltx', String(level));
        const files = (level: number) => {
            try {
                return readdirSync(levelDir(level))
                    .filter((name) => name.endsWith('.ltx'))
                    .map((name) => ({
                        name,
                        max: parseInt(name.slice(17, 33), 16),
                    }));
            } catch {
                return [];
            }
        };
        const born = new Map<string, number>();
        let step = 0;
        const write = (level: number, min: number, max: number) => {
            mkdirSync(levelDir(level), { recursive: true });
            const path = join(levelDir(level), ltxName(min, max));
            writeFileSync(`${path}.tmp`, ltx(min, max, AT + max * 1000));
            renameSync(`${path}.tmp`, path);
            born.set(`${level}/${ltxName(min, max)}`, step);
        };
        const remove = (level: number, name: string) => rmSync(join(levelDir(level), name), { force: true });
        let txid = 1;
        let level1 = 0;
        let level2 = 0;
        write(9, 1, 1);
        write(0, 1, 1);
        const litestream = () => {
            step++;
            const r = rnd();
            if (r < 0.4) {
                const min = txid + 1;
                txid += 1 + Math.floor(rnd() * 3);
                write(0, min, txid);
            } else if (r < 0.55) {
                const max = Math.max(level1, ...files(0).map((file) => file.max));
                if (max > level1) {
                    write(1, level1 + 1, max);
                }
                level1 = max;
            } else if (r < 0.65) {
                for (const { name, max } of files(0)) {
                    if (max <= level1 && step - born.get(`0/${name}`)! > 15) {
                        remove(0, name);
                    }
                }
            } else if (r < 0.72) {
                if (level1 > level2) {
                    write(2, level2 + 1, level1);
                    level2 = level1;
                    if (seed % 2) {
                        for (const { name, max } of files(1)) {
                            if (max <= level2) {
                                remove(1, name);
                            }
                        }
                    }
                }
            } else if (r < 0.735) {
                write(9, 1, txid);
            } else if (r < 0.82) {
                const snapshots = files(9).sort((a, b) => a.max - b.max);
                while (snapshots.length > 3) {
                    remove(9, snapshots.shift()!.name);
                }
                for (let level = 1; level < 9; level++) {
                    for (const { name, max } of files(level)) {
                        if (max < snapshots[0].max) {
                            remove(level, name);
                        }
                    }
                }
            }
        };

        // The target, in memory: before and after each call, Litestream may
        // move on, the call may fail, or the host may die.
        const objects = new Map<string, Buffer>();
        const problems: string[] = [];
        let restoresTo = 0;
        /** The newest lineage restores from a snapshot, as far as before or further. */
        const check = (when: string) => {
            // The first one says what went wrong; the rest follow from it.
            if (problems.length) {
                return;
            }
            const lineages = new Set([...objects.keys()].map((key) => key.split('/')[2]));
            if (lineages.size > 1) {
                problems.push(`${when}: ${lineages.size} lineages`);
            }
            const lineage = [...lineages].sort().pop();
            if (!lineage) {
                return;
            }
            const root = `p/litestream/${lineage}/ltx/`;
            const sent = [...objects.keys()].map((key) => key.slice(root.length));
            const point = restorePoint(sent);
            if (!sent.some((file) => file.startsWith('9/'))) {
                problems.push(`${when}: no snapshot`);
            } else if (typeof point !== 'number' || point < restoresTo) {
                problems.push(`${when}: ${point}, after ${restoresTo}`);
            } else {
                restoresTo = point;
            }
        };
        let calls = 0;
        let busy = true;
        let failAt = -1;
        let crashAt = -1;
        /** The state file as the host left it, when it died mid-send. */
        let crashed: string | null | undefined;
        const call = (name: string) => {
            check(`step ${step}, ${name}`);
            if (busy && rnd() < 0.3) {
                litestream();
            }
            calls++;
            if (calls === crashAt) {
                crashed = existsSync(state) ? readFileSync(state, 'utf8') : null;
                throw new Error('the host died');
            }
            if (calls === failAt) {
                throw new Error('network');
            }
        };
        const target: ObjectStore = {
            driver: 's3',
            async ensureReady() {
                call('before the target is ready');
            },
            async put(key, body) {
                call('before a put');
                objects.set(key, Buffer.from(body));
                call('after a put');
            },
            async get(key) {
                return objects.get(key);
            },
            async head(key) {
                const body = objects.get(key);
                return body && { size: body.length };
            },
            async delete(key) {
                call('before a delete');
                objects.delete(key);
                call('after a delete');
            },
            // A page of 7 at a time, so listings take more than one call.
            async list(prefix, cursor) {
                call('before a listing');
                const keys = [...objects.keys()]
                    .filter((key) => key.startsWith(prefix) && (!cursor || key > cursor))
                    .sort();
                const page = keys.slice(0, 7);
                return {
                    keys: page.map((key) => ({ key, size: objects.get(key)!.length })),
                    next: keys.length > 7 ? page[6] : undefined,
                };
            },
        };
        const ship = () =>
            shipContinuousCopy({
                target,
                prefix: 'p/',
                box,
                replica,
                state,
                reason: backupFailure,
            });

        for (let round = 0; round < 150; round++) {
            const between = rnd() < 0.05 ? 30 + Math.floor(rnd() * 30) : 1 + Math.floor(rnd() * 5);
            for (let i = 0; i < between; i++) {
                litestream();
            }
            calls = 0;
            crashed = undefined;
            crashAt = rnd() < 0.15 ? 1 + Math.floor(rnd() * 30) : -1;
            failAt = rnd() < 0.1 ? 1 + Math.floor(rnd() * 30) : -1;
            try {
                await ship();
            } catch {
                // A host that died wrote nothing after.
                if (crashed === null) {
                    rmSync(state, { force: true });
                } else if (crashed !== undefined) {
                    writeFileSync(state, crashed);
                }
            }
            check(`step ${step}, after round ${round}`);
        }
        // Left alone, a send brings the lineage up to the replica.
        busy = false;
        crashAt = failAt = -1;
        await ship();
        check('at the end');
        expect(problems).toEqual([]);
        expect(restoresTo).toBe(txid);
    },
);

it('never removes or overwrites what an earlier host sent: a new host sends a new lineage', async () => {
    // The host is lost; its copy is off-site.
    const old = await fixture();
    old.write(9, 1, 3);
    old.write(1, 4, 6);
    old.write(0, 7, 7);
    await old.ship();
    const lineage = readLtxState(old.state).lineage!;
    const before = new Map([...old.fake.objects].filter(([key]) => key.includes('/litestream/')));
    expect(before.size).toBe(3);

    // The stack comes back on new storage before anyone restored: an empty
    // database, a fresh replica (transactions from 1 again, under names the
    // old one used), and no state file.
    const dir = scratch('cb-ltx-new-host-');
    const replica = join(dir, 'litestream', 'company-brain');
    const write = (level: number, min: number, max: number) => {
        mkdirSync(join(replica, 'ltx', String(level)), { recursive: true });
        writeFileSync(
            join(replica, 'ltx', String(level), ltxName(min, max)),
            ltx(min, max, AT + 86_400_000, 'new host'),
        );
    };
    write(9, 1, 3);
    write(0, 4, 4);
    writeFileSync(join(dir, 'brain.sqlite'), 'db');
    const lines: string[] = [];
    const service = new BackupService({
        databasePath: join(dir, 'brain.sqlite'),
        userDataDir: join(dir, 'userdata'),
        settings: {
            directory: join(dir, 'backups'),
            keep: 3,
            intervalHours: 0,
            continuous: replica,
            offsite: {
                ...old.fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: old.target,
        keys: { current: KEY, legacy: SECRET },
        log: (line) => lines.push(line),
        now: () => AT + 86_400_000,
    });
    expect(await service.shipContinuous()).toBe(true);
    const state = readLtxState(join(dir, 'backups', 'offsite-ltx.json'));
    expect(state.lineage).toMatch(/^20261021T090000Z-/);
    expect(lines).toEqual([
        `Continuous copy off-site: sending a new lineage, ${state.lineage}; the 1 older one(s) stay off-site until removed by hand.`,
    ]);
    // Then Litestream compacts and drops files on the new host: mirrored in
    // its own lineage only.
    write(9, 1, 5);
    rmSync(join(replica, 'ltx', '9', ltxName(1, 3)));
    rmSync(join(replica, 'ltx', '0', ltxName(4, 4)));
    expect(await service.shipContinuous()).toBe(true);
    expect(
        [...old.fake.objects.keys()]
            .filter((key) => key.includes(`/litestream/${state.lineage}/`))
            .map((key) => key.split('/ltx/')[1]),
    ).toEqual([`9/${ltxName(1, 5)}.sealed`]);
    // The old copy is untouched, byte for byte.
    for (const [key, body] of before) {
        expect(old.fake.objects.get(key)).toEqual(body);
    }

    // A restore has to name the lineage; the old one comes back whole.
    const box = new SecretBox({ current: KEY, legacy: SECRET }, 'backups');
    const into = join(scratch('cb-ltx-restore-'), 'replica');
    await expect(
        fetchContinuousCopy({
            target: old.target,
            prefix: 'company-brain/',
            box,
            directory: into,
        }),
    ).rejects.toThrow(
        `The off-site copy has 2 lineages of the continuous copy; name the one to restore (the newest first):\n  ${state.lineage}: 1 file(s), up to transaction 5\n  ${lineage}: 3 file(s), up to transaction 7`,
    );
    await expect(
        fetchContinuousCopy({
            target: old.target,
            prefix: 'company-brain/',
            box,
            directory: into,
            lineage: 'nope',
        }),
    ).rejects.toThrow('The off-site copy has no lineage nope.');
    expect(
        await fetchContinuousCopy({
            target: old.target,
            prefix: 'company-brain/',
            box,
            directory: into,
            lineage,
        }),
    ).toMatchObject({ lineage, files: 3 });
    for (const [level, min, max] of [
        [9, 1, 3],
        [1, 4, 6],
        [0, 7, 7],
    ]) {
        expect(readFileSync(join(into, 'ltx', String(level), ltxName(min, max)))).toEqual(
            readFileSync(join(old.replica, 'ltx', String(level), ltxName(min, max))),
        );
    }
});

it('starts a new lineage when Litestream starts over on the same host', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(0, 4, 4);
    await f.ship();
    const first = readLtxState(f.state).lineage!;
    // A database put back to an earlier point: Litestream's replica starts
    // again below the transactions already sent.
    rmSync(join(f.replica, 'ltx'), { recursive: true });
    f.write(9, 1, 2);
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({
        sent: 1,
        removed: 0,
        started: { others: 1 },
    });
    const second = readLtxState(f.state).lineage!;
    expect(second).not.toBe(first);
    expect(f.remote()).toEqual([`9/${ltxName(1, 2)}.sealed`]);
    // The earlier lineage stays whole.
    for (const file of [`9/${ltxName(1, 3)}`, `0/${ltxName(4, 4)}`]) {
        expect(f.fake.objects.has(`offsite/company-brain/litestream/${first}/ltx/${file}.sealed`)).toBe(true);
    }
    // Going on from there stays in the new lineage.
    f.write(0, 3, 3);
    expect(await f.ship()).toMatchObject({ sent: 1 });
    expect(readLtxState(f.state).lineage).toBe(second);
});

it('keeps a newer off-site copy when BACKUP_DIR comes back from an older one', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(0, 4, 4);
    await f.ship();
    const first = readLtxState(f.state).lineage!;
    // A copy of /backups (the replica and the state file) at this point.
    const snapshot = scratch('cb-ltx-snapshot-');
    cpSync(f.replica, join(snapshot, 'replica'), { recursive: true });
    cpSync(f.state, join(snapshot, 'offsite-ltx.json'));
    // Then two transactions, compacted into level 1, all off-site.
    f.write(0, 5, 5);
    f.write(0, 6, 6);
    await f.ship();
    f.write(1, 4, 6);
    for (const txid of [4, 5, 6]) {
        f.remove(0, txid, txid);
    }
    expect(await f.ship()).toMatchObject({ removed: 3 });
    const before = new Map([...f.fake.objects].filter(([key]) => key.includes(`/${first}/`)));
    expect([...before.keys()].map((key) => key.split('/ltx/')[1])).toEqual([
        `9/${ltxName(1, 3)}.sealed`,
        `1/${ltxName(4, 6)}.sealed`,
    ]);

    // /backups is put back from the older copy: the state and the replica
    // agree with each other, and both are behind what is off-site.
    rmSync(f.replica, { recursive: true });
    cpSync(join(snapshot, 'replica'), f.replica, { recursive: true });
    cpSync(join(snapshot, 'offsite-ltx.json'), f.state);
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({
        sent: 2,
        removed: 0,
        started: { others: 1 },
    });
    expect(readLtxState(f.state).lineage).not.toBe(first);
    // Transactions 5 and 6 are still off-site, byte for byte.
    for (const [key, body] of before) {
        expect(f.fake.objects.get(key)).toEqual(body);
    }
    const into = join(scratch('cb-ltx-restore-'), 'replica');
    await fetchContinuousCopy({
        target: f.target,
        prefix: 'company-brain/',
        box: f.box,
        directory: into,
        lineage: first,
    });
    expect(readFileSync(join(into, 'ltx', '1', ltxName(4, 6)))).toEqual(ltx(4, 6, AT + 6000));
});

it('never removes or overwrites another sender’s files when two hosts share one state file', async () => {
    // Host A sends; host B starts from a copy of its /backups (a host move
    // while the old host still runs).
    const a = await fixture();
    a.write(9, 1, 3);
    a.write(0, 4, 4);
    await a.ship();
    const shared = readLtxState(a.state).lineage!;
    const dir = scratch('cb-ltx-host-b-');
    const replica = join(dir, 'replica');
    const state = join(dir, 'offsite-ltx.json');
    cpSync(a.replica, replica, { recursive: true });
    cpSync(a.state, state);
    const write = (level: number, min: number, max: number) => {
        mkdirSync(join(replica, 'ltx', String(level)), { recursive: true });
        writeFileSync(join(replica, 'ltx', String(level), ltxName(min, max)), ltx(min, max, AT + max * 1000, 'host B'));
    };
    const b = () =>
        shipContinuousCopy({
            target: a.target,
            prefix: 'company-brain/',
            box: a.box,
            replica,
            state,
            reason: backupFailure,
            now: () => AT + 60_000,
        });
    const key = (lineage: string, file: string) => `offsite/company-brain/litestream/${lineage}/ltx/${file}.sealed`;
    const opened = (lineage: string, file: string) =>
        a.box.openBytes(a.fake.objects.get(key(lineage, file))!, BACKUP_CONTEXT);

    // Each goes on with its own transaction 5, under the same name.
    a.write(0, 5, 5);
    await a.ship();
    write(0, 5, 5);
    expect(await b()).toMatchObject({ removed: 0, started: { others: 1 } });
    const own = readLtxState(state).lineage!;
    expect(own).not.toBe(shared);
    expect(opened(shared, `0/${ltxName(5, 5)}`)).toEqual(readFileSync(join(a.replica, 'ltx', '0', ltxName(5, 5))));
    // Each compacts, and removes only in its own lineage.
    write(1, 4, 5);
    rmSync(join(replica, 'ltx', '0', ltxName(4, 4)));
    rmSync(join(replica, 'ltx', '0', ltxName(5, 5)));
    expect(await b()).toMatchObject({ removed: 2 });
    a.write(1, 4, 5);
    a.remove(0, 4, 4);
    a.remove(0, 5, 5);
    expect(await a.ship()).toMatchObject({ removed: 2 });
    expect(readLtxState(a.state).lineage).toBe(shared);
    expect(a.remote()).toEqual([`1/${ltxName(4, 5)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    expect(opened(shared, `1/${ltxName(4, 5)}`)).toEqual(readFileSync(join(a.replica, 'ltx', '1', ltxName(4, 5))));
    expect(opened(own, `1/${ltxName(4, 5)}`)).toEqual(readFileSync(join(replica, 'ltx', '1', ltxName(4, 5))));
});

it('keeps a file a send cut short put off-site as its own', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    await f.ship();
    const lineage = readLtxState(f.state).lineage;
    // The file goes, and the send stops before it records that it went.
    f.write(0, 4, 4);
    const put = f.target.put.bind(f.target);
    f.target.put = async (key, body) => {
        await put(key, body);
        throw new Error('cut short');
    };
    await expect(f.ship()).rejects.toThrow('cut short');
    expect(f.remote()).toContain(`0/${ltxName(4, 4)}.sealed`);
    f.target.put = put;
    // Not another sender's file: the same lineage, the file sent again.
    expect(await f.ship()).toMatchObject({ sent: 1 });
    expect(readLtxState(f.state)).toMatchObject({ lineage, sending: [] });
    // And removed once compacted, as any other.
    f.write(1, 4, 4);
    f.remove(0, 4, 4);
    expect(await f.ship()).toMatchObject({ removed: 1 });
});

it.skipIf(process.getuid?.() === 0)(
    'removes nothing while a level of the replica can’t be read, and says so',
    async () => {
        const f = await fixture();
        f.write(9, 1, 3);
        f.write(0, 4, 4);
        await f.ship();
        // Compacted, so level 0's file could go, but the snapshots can't be read.
        f.write(1, 4, 5);
        f.remove(0, 4, 4);
        const snapshots = join(f.replica, 'ltx', '9');
        chmodSync(snapshots, 0);
        cleanup.push(() => chmodSync(snapshots, 0o755));
        f.tick(60_000);
        const message =
            "Some of the continuous copy's files can't be read (EACCES); nothing off-site is removed until they can.";
        await expect(f.ship()).rejects.toThrow(message);
        // What it could read went; nothing was removed.
        expect(f.remote()).toEqual([
            `0/${ltxName(4, 4)}.sealed`,
            `1/${ltxName(4, 5)}.sealed`,
            `9/${ltxName(1, 3)}.sealed`,
        ]);
        expect(readLtxState(f.state)).toMatchObject({
            failures: 1,
            lastError: message,
            lastSentAt: AT,
        });
        chmodSync(snapshots, 0o755);
        expect(await f.ship()).toMatchObject({ sent: 0, removed: 1 });
        expect(f.remote()).toEqual([`1/${ltxName(4, 5)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    },
);

it('removes nothing when the replica’s ltx directory, or a level of it, is missing', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(0, 4, 4);
    await f.ship();
    const lineage = readLtxState(f.state).lineage;
    // The replica's volume is gone: nothing removed, nothing claimed sent.
    const ltxDir = join(f.replica, 'ltx');
    rmSync(ltxDir, { recursive: true });
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({ files: 0, removed: 0 });
    expect(f.remote()).toHaveLength(2);
    expect(readLtxState(f.state)).toMatchObject({ lineage, lastSentAt: AT });
    // A level gone while it is listed: the listing is short, so nothing goes.
    f.write(0, 4, 4);
    f.write(1, 4, 4);
    f.remove(0, 4, 4);
    symlinkSync(join(f.dir, 'nowhere'), join(ltxDir, '9'));
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({ sent: 1, removed: 0 });
    expect(f.remote()).toEqual([`0/${ltxName(4, 4)}.sealed`, `1/${ltxName(4, 4)}.sealed`, `9/${ltxName(1, 3)}.sealed`]);
    expect(readLtxState(f.state)).toMatchObject({ lineage, lastSentAt: AT });
    // Back: the level 0 file is removed, its transaction in level 1.
    rmSync(join(ltxDir, '9'));
    f.write(9, 1, 3);
    f.tick(60_000);
    expect(await f.ship()).toMatchObject({ sent: 0, removed: 1 });
    expect(readLtxState(f.state).lastSentAt).toBe(f.now());
});

it('sends files sealed under an older data key again under the new one', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    await f.ship();
    const old = f.box.currentKey;
    const next = randomBytes(32);
    const rotated = new SecretBox({ current: next, previous: KEY, legacy: SECRET }, 'backups');
    const result = await shipContinuousCopy({
        target: f.target,
        prefix: 'company-brain/',
        box: rotated,
        replica: f.replica,
        state: f.state,
        reason: backupFailure,
    });
    expect(result.sent).toBe(1);
    const sealed = f.fake.objects.get(f.key(`9/${ltxName(1, 3)}.sealed`))!;
    expect(rotated.bytesKey(sealed)).not.toBe(old);
    expect(rotated.bytesKey(sealed)).toBe(rotated.currentKey);
});

it('records failures, backs off, and shows the continuous copy off-site on Service setup', async () => {
    const f = await fixture();
    const database = join(f.dir, 'brain.sqlite');
    writeFileSync(database, 'db');
    writeFileSync(`${database}-wal`, 'wal');
    const lines: string[] = [];
    let schedule: { intervalHours: number; ltxIntervalSeconds: number } = {
        intervalHours: 24,
        ltxIntervalSeconds: 60,
    };
    const service = new BackupService({
        databasePath: database,
        userDataDir: join(f.dir, 'userdata'),
        settings: {
            directory: join(f.dir, 'backups'),
            keep: 3,
            intervalHours: 24,
            ltxIntervalSeconds: 300,
            continuous: f.replica,
            offsite: {
                ...f.fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: f.target,
        keys: { current: KEY, legacy: SECRET },
        schedule: () => schedule,
        log: (line) => lines.push(line),
        now: f.now,
    });
    // Nothing sent yet.
    expect(service.status().continuous?.offsite).toMatchObject({
        lagMs: 0,
        intervalSeconds: 60,
        waiting: 0,
        failures: 0,
        behind: false,
    });
    expect(service.ltxDue()).toBe(true);

    f.write(9, 1, 3);
    f.fake.failNext(1, 503);
    expect(await service.shipContinuous()).toBe(false);
    expect(lines).toEqual(['Continuous copy off-site failed: Object storage HEAD failed: HTTP 503.']);
    const failed = service.status().continuous!.offsite!;
    expect(failed).toMatchObject({
        failures: 1,
        lastErrorAt: AT,
        lastError: 'Object storage HEAD failed: HTTP 503.',
        waiting: 1,
        behind: true,
    });
    expect(failed.lastSentAt).toBeUndefined();
    // Tried again later each time: 2, then 4 minutes, up to 30.
    f.tick(60_000);
    expect(service.ltxDue()).toBe(false);
    f.tick(60_000);
    expect(service.ltxDue()).toBe(true);
    f.fake.failNext(1, 503);
    await service.shipContinuous();
    expect(service.status().continuous!.offsite!.failures).toBe(2);
    // Logged once a streak.
    expect(lines).toHaveLength(1);
    f.tick(3 * 60_000);
    expect(service.ltxDue()).toBe(false);
    f.tick(60_000);
    expect(service.ltxDue()).toBe(true);
    expect(ltxWaitMs(60, 10)).toBe(LTX_BACKOFF_MAX_MS);
    expect(ltxWaitMs(3600, 3)).toBe(3600_000 * 1);
    expect(ltxWaitMs(600, 2)).toBe(LTX_BACKOFF_MAX_MS);

    // It works again: the failures clear.
    expect(await service.shipContinuous()).toBe(true);
    expect(lines.at(-1)).toBe('Continuous copy off-site: sending again after a failure.');
    const sentAt = f.now();
    expect(service.status().continuous!.offsite).toEqual({
        intervalSeconds: 60,
        lastSentAt: sentAt,
        lagMs: 0,
        waiting: 0,
        failures: 0,
        behind: false,
    });
    // A copy Litestream made since then: waiting; behind once it has waited
    // over the interval and 5 minutes.
    const path = f.write(0, 4, 4);
    f.tick(1000);
    utimesSync(path, new Date(f.now()), new Date(f.now()));
    f.tick(5 * 60_000);
    expect(service.status().continuous!.offsite).toMatchObject({
        lagMs: 5 * 60_000 + 1000,
        behind: false,
    });
    f.tick(60_000);
    expect(service.status().continuous!.offsite!.behind).toBe(true);
    // Off from Settings: never due, never behind.
    schedule = { intervalHours: 24, ltxIntervalSeconds: 0 };
    expect(service.ltxDue()).toBe(false);
    expect(service.status().continuous!.offsite).toMatchObject({
        intervalSeconds: 0,
        behind: false,
    });
});

it('counts the wait before the first send from when the server started', async () => {
    const f = await fixture();
    // The database was idle for hours before this server started.
    const path = f.write(9, 1, 3);
    const idle = new Date(AT - 3 * 3_600_000);
    utimesSync(path, idle, idle);
    writeFileSync(join(f.dir, 'brain.sqlite'), 'db');
    const service = new BackupService({
        databasePath: join(f.dir, 'brain.sqlite'),
        userDataDir: join(f.dir, 'userdata'),
        settings: {
            directory: join(f.dir, 'backups'),
            keep: 3,
            intervalHours: 0,
            continuous: f.replica,
            offsite: {
                ...f.fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: f.target,
        keys: { current: KEY, legacy: SECRET },
        log: () => {},
        now: f.now,
    });
    f.tick(5000);
    expect(service.status().continuous!.offsite).toMatchObject({
        lagMs: 5000,
        behind: false,
    });
});

it('shows a file that keeps waiting as behind: it holds back removals off-site', async () => {
    const f = await fixture();
    // Copied before the first send, and nothing since.
    const snapshot = f.write(9, 1, 3);
    utimesSync(snapshot, new Date(AT - 2000), new Date(AT - 2000));
    writeFileSync(join(f.dir, 'brain.sqlite'), 'db');
    const service = new BackupService({
        databasePath: join(f.dir, 'brain.sqlite'),
        userDataDir: join(f.dir, 'userdata'),
        settings: {
            directory: join(f.dir, 'backups'),
            keep: 3,
            intervalHours: 0,
            ltxIntervalSeconds: 60,
            continuous: f.replica,
            offsite: {
                ...f.fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: f.target,
        keys: { current: KEY, legacy: SECRET },
        log: () => {},
        now: f.now,
    });
    expect(await service.shipContinuous()).toBe(true);
    // Never a whole LTX file, and older than the last send: no copy waits.
    const level1 = join(f.replica, 'ltx', '1');
    mkdirSync(level1, { recursive: true });
    const stuck = join(level1, ltxName(4, 6));
    writeFileSync(stuck, Buffer.from('LTX1short'));
    utimesSync(stuck, new Date(AT - 1000), new Date(AT - 1000));
    f.tick(60_000);
    expect(await service.shipContinuous()).toBe(true);
    expect(service.status().continuous!.offsite).toMatchObject({
        lastSentAt: AT,
        lagMs: 0,
        waiting: 1,
        behind: false,
    });
    f.tick(6 * 60_000);
    expect(await service.shipContinuous()).toBe(true);
    expect(service.status().continuous!.offsite).toMatchObject({
        lagMs: 0,
        waiting: 1,
        behind: true,
    });
});

it('sends on its own from start, at the interval in force', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    let seconds = 0;
    const service = new BackupService({
        databasePath: join(f.dir, 'brain.sqlite'),
        userDataDir: join(f.dir, 'userdata'),
        settings: {
            directory: join(f.dir, 'backups'),
            keep: 3,
            intervalHours: 0,
            continuous: f.replica,
            offsite: {
                ...f.fake.settings({ bucket: 'offsite' }),
                prefix: 'company-brain/',
            },
        },
        offsiteStore: f.target,
        keys: { current: KEY, legacy: SECRET },
        schedule: () => ({ ltxIntervalSeconds: seconds }),
        log: () => {},
        ltxCheckMs: 5,
    });
    service.start();
    cleanup.push(() => service.stop());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.remote()).toEqual([]);
    // Turned on in Settings: no restart needed.
    seconds = 10;
    await vi.waitFor(() => expect(f.remote()).toEqual([`9/${ltxName(1, 3)}.sealed`]));
});

it('downloads and opens the continuous copy into a file replica for litestream restore', async () => {
    const f = await fixture();
    f.write(9, 1, 3);
    f.write(1, 4, 6);
    f.write(0, 7, 7);
    await f.ship();
    const restore = join(scratch('cb-ltx-restore-'), 'replica');
    const result = await fetchContinuousCopy({
        target: f.target,
        prefix: 'company-brain/',
        box: new SecretBox({ current: KEY, legacy: SECRET }, 'backups'),
        directory: restore,
    });
    expect(result).toEqual({
        lineage: readLtxState(f.state).lineage,
        files: 3,
        bytes: 3 * 180,
        newestAt: AT + 7000,
    });
    for (const [level, min, max] of [
        [9, 1, 3],
        [1, 4, 6],
        [0, 7, 7],
    ]) {
        const path = join(restore, 'ltx', String(level), ltxName(min, max));
        // Byte for byte Litestream's file, dated by its header as Litestream
        // dates its own, so `-timestamp` restores pick the same files.
        expect(readFileSync(path)).toEqual(readFileSync(join(f.replica, 'ltx', String(level), ltxName(min, max))));
        expect(Math.round(statSync(path).mtimeMs)).toBe(AT + max * 1000);
        expect(ltxTimestamp(readFileSync(path))).toBe(AT + max * 1000);
    }
    // Not over files already there.
    await expect(
        fetchContinuousCopy({
            target: f.target,
            prefix: 'company-brain/',
            box: f.box,
            directory: restore,
        }),
    ).rejects.toThrow('The directory for the replica must be new or empty.');
    // Without the data key, nothing opens.
    await expect(
        fetchContinuousCopy({
            target: f.target,
            prefix: 'company-brain/',
            box: new SecretBox({ current: randomBytes(32), legacy: SECRET }, 'backups'),
            directory: join(scratch('cb-ltx-restore-'), 'replica'),
        }),
    ).rejects.toThrow();
});

it('reads BACKUP_LTX_INTERVAL_SECONDS: 60 by default, 0 off, at least 10', () => {
    expect(backupSettingsFromEnv({}, { dataKey: false }).ltxIntervalSeconds).toBe(60);
    for (const [value, seconds] of [
        ['0', 0],
        [' 10 ', 10],
        ['86400', 86_400],
    ] as const) {
        expect(
            backupSettingsFromEnv({ BACKUP_LTX_INTERVAL_SECONDS: value }, { dataKey: false }).ltxIntervalSeconds,
        ).toBe(seconds);
    }
    for (const value of ['5', '1.5', '86401', 'often', '-1']) {
        expect(() => backupSettingsFromEnv({ BACKUP_LTX_INTERVAL_SECONDS: value }, { dataKey: false })).toThrow(
            /^BACKUP_LTX_INTERVAL_SECONDS must be 0 \(off\)/,
        );
    }
});

it('lets admins set the backup schedule over the environment’s, applied without a restart', async () => {
    const dir = scratch('cb-backup-schedule-');
    const { app, store, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'unused', model: 'qwen-test' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'schedule-secret-0123456789abcdef'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const service = new BackupService({
        databasePath: join(dir, 'brain.sqlite'),
        userDataDir: join(dir, 'userdata'),
        settings: {
            directory: join(dir, 'backups'),
            keep: 3,
            intervalHours: 24,
            ltxIntervalSeconds: 60,
        },
        schedule: () => store.settings().backupSchedule,
        log: () => {},
    });
    platform.useBackups(service);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const alice = await as('alice');
    const bob = await as('bob');
    const scheduleIn = async (response: Response) =>
        ((await response.json()) as { settings: { backupSchedule: unknown } }).settings.backupSchedule;
    // Members see the schedule in force; the environment's to begin with.
    expect(await scheduleIn(await bob('/api/state'))).toEqual({
        intervalHours: 24,
        ltxIntervalSeconds: 60,
        drillIntervalDays: 30,
        purgeBackupDays: 30,
    });
    expect(
        (
            await bob('/api/settings', 'PATCH', {
                backupSchedule: {
                    intervalHours: 1,
                    ltxIntervalSeconds: 10,
                    drillIntervalDays: 7,
                    purgeBackupDays: 30,
                },
            })
        ).status,
    ).toBe(403);
    for (const bad of [
        { intervalHours: -1, ltxIntervalSeconds: 60 },
        { intervalHours: 721, ltxIntervalSeconds: 60 },
        { intervalHours: 24, ltxIntervalSeconds: 5 },
        { intervalHours: 24, ltxIntervalSeconds: 30.5 },
        { intervalHours: 24, ltxIntervalSeconds: 86_401 },
        { intervalHours: 24 },
        // The restore drill's days (CB-111): whole, 0 to 365, and always sent.
        { intervalHours: 24, ltxIntervalSeconds: 60 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: -1, purgeBackupDays: 30 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 1.5, purgeBackupDays: 30 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 366, purgeBackupDays: 30 },
        // Permanent removals' backups (CB-391): whole days, 1 to 365, and always sent.
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 30 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 30, purgeBackupDays: 0 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 30, purgeBackupDays: 1.5 },
        { intervalHours: 24, ltxIntervalSeconds: 60, drillIntervalDays: 30, purgeBackupDays: 366 },
    ]) {
        expect((await alice('/api/settings', 'PATCH', { backupSchedule: bad })).status).toBe(400);
    }
    expect(
        (
            await alice('/api/settings', 'PATCH', {
                backupSchedule: {
                    intervalHours: 0.5,
                    ltxIntervalSeconds: 0,
                    drillIntervalDays: 0,
                    purgeBackupDays: 90,
                },
            })
        ).status,
    ).toBe(200);
    expect(await scheduleIn(await bob('/api/state'))).toEqual({
        intervalHours: 0.5,
        ltxIntervalSeconds: 0,
        drillIntervalDays: 0,
        purgeBackupDays: 90,
    });
    // The service reads it at its next check: no restart.
    expect(service.schedule()).toEqual({
        intervalHours: 0.5,
        ltxIntervalSeconds: 0,
        drillIntervalDays: 0,
        purgeBackupDays: 90,
    });
    expect(service.status().intervalHours).toBe(0.5);
    // Other settings keep it.
    await alice('/api/settings', 'PATCH', { researchAllowed: false });
    expect(store.settings().backupSchedule).toEqual({
        intervalHours: 0.5,
        ltxIntervalSeconds: 0,
        drillIntervalDays: 0,
        purgeBackupDays: 90,
    });
});
