// One backup in a process of its own, for tests/backup-memory.test.ts
// (CB-378): it reads the run from BACKUP_MEMORY_RUN (JSON), runs a small
// backup (`warmup`) once to load what any run loads once, then that small
// one again and the large one, each from a reset peak RSS, and prints how
// much more the large one grew the resident set, as JSON on stdout: what
// grows with the data, not what every run costs on a given Node. Linux
// only: the peak comes from /proc/self/status (VmHWM), reset through
// /proc/self/clear_refs.
import { readFileSync, writeFileSync } from 'node:fs';

import { runBackup } from '../../src/server/backup/backup-service.js';
import type { BackupSettings } from '../../src/server/backup/contract.js';
import { S3ObjectStore } from '../../src/server/storage/s3-store.js';

type Run = Pick<MemoryRun, 'databasePath' | 'userDataDir' | 'settings'>;
interface MemoryRun {
    databasePath: string;
    userDataDir: string;
    settings: BackupSettings;
    /** The data space's S3 (the fake's settings). */
    objects: BackupSettings['offsite'] & { tenantId: string };
    /** The data key, base64. */
    key: string;
    /** A small backup run first: paths, settings and a tenant of its own. */
    warmup: Run & { tenantId: string };
}

const kib = (field: string) => {
    const match = readFileSync('/proc/self/status', 'utf8').match(new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm'));
    if (!match) {
        throw new Error(`No ${field} in /proc/self/status.`);
    }
    return Number(match[1]) * 1024;
};

const run = JSON.parse(process.env.BACKUP_MEMORY_RUN ?? '') as MemoryRun;
const { tenantId, prefix: _prefix, ...objects } = run.objects;
const options = { backoffMs: 1, timeoutMs: 120_000 };
const backup = (of: Run, tenant = tenantId) =>
    runBackup({
        databasePath: of.databasePath,
        userDataDir: of.userDataDir,
        settings: of.settings,
        objects: { store: new S3ObjectStore(objects, options), tenantId: tenant },
        offsiteStore: new S3ObjectStore(of.settings.offsite!, options),
        keys: { current: Buffer.from(run.key, 'base64'), legacy: 'backup-memory-test-secret-0123456' },
    });
/** How far the resident set grows while `work` runs, from a settled start. */
async function growth<T>(work: () => Promise<T>) {
    globalThis.gc?.();
    writeFileSync('/proc/self/clear_refs', '5');
    const before = kib('VmRSS');
    const result = await work();
    return { result, before, peak: kib('VmHWM'), growth: kib('VmHWM') - before };
}
const small = () => backup(run.warmup, run.warmup.tenantId);
// Once to load what any run loads once, then measured: what every run
// costs (its integrity check's worker, fetch, buffers), whatever the data.
await small();
const baseline = await growth(small);
if (baseline.result.offsiteError) {
    throw new Error(`The small backup's off-site copy failed: ${baseline.result.offsiteError}`);
}
const { result, before, peak, growth: total } = await growth(() => backup(run));
process.stdout.write(
    `${JSON.stringify({
        before,
        peak,
        total,
        baseline: baseline.growth,
        /** What grows with the data: this run's growth over the small one's. */
        growth: total - baseline.growth,
        offsiteError: result.offsiteError,
        offsite: result.offsite,
        objects: result.objects,
        datasets: result.datasets,
        files: result.files,
    })}\n`,
);
