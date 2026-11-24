import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { randomBytes } from 'node:crypto';
import { copyFile, chmod, chown, mkdir, readFile, readdir, writeFile, unlink, lstat } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout } from 'node:timers';

import { PrincipalRuntime } from '/candidate/principal-runtime.ts';
import { jobEntryCommand } from '/job-source/entry.ts';
import { runScript } from '/job-source/startup.ts';

await copyFile('/candidate/principal-worker.ts', '/app/src/principal-worker.ts');
await mkdir('/test-shared', { mode: 0o2770 });
await chown('/test-shared', 0, 20000);
await chmod('/test-shared', 0o2770);
const options = {
    privateRoot: '/test-private',
    sharedRoot: '/test-shared',
    workerFile: '/app/src/principal-worker.ts',
    environment: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
};
let runtime = new PrincipalRuntime(options);
const A = { kind: 'person', id: 'person-a' },
    B = { kind: 'person', id: 'person-b' },
    APP = { kind: 'app', id: 'app-a' },
    JOB = { kind: 'job', id: 'job-a' };
const ids = await Promise.all([
    runtime.identity(A),
    runtime.identity(B),
    runtime.identity(APP),
    runtime.identity(JOB),
    runtime.identity(A),
]);
assert.equal(new Set(ids.slice(0, 4).map((i) => i.uid)).size, 4);
assert.equal(ids[0].uid, ids[4].uid);
runtime = new PrincipalRuntime(options);
assert.equal((await runtime.identity(A)).uid, ids[0].uid);
assert.equal((await lstat(ids[0].home)).mode & 0o777, 0o700);
const execute = async (principal, command, variables = {}) => {
    const result = await runtime.dispatch(principal, 'exec', {
        command,
        variables,
        timeoutMs: 20000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    return JSON.parse(result.stdout.trim());
};
const secret = randomBytes(32).toString('hex');
const held = execute(
    A,
    `bun -e 'const fs=require("node:fs");fs.writeFileSync("private.txt","private-a");fs.writeFileSync("shared/pid-a",String(process.pid));fs.chmodSync("shared/pid-a",0o640);await Bun.sleep(4000);console.log(JSON.stringify({uid:process.getuid(),groups:process.getgroups(),hasToken:!!process.env.CB_DATA_TOKEN,privateMode:fs.statSync("private.txt").mode&0o777,noNewPrivs:/NoNewPrivs:\\s+1/.test(fs.readFileSync("/proc/self/status","utf8")),effectiveCapsZero:/^CapEff:\\s+0+$/m.test(fs.readFileSync("/proc/self/status","utf8"))}));'`,
    { CB_DATA_TOKEN: secret },
);
await new Promise((r) => setTimeout(r, 600));
const other = await execute(
    B,
    `bun -e 'const fs=require("node:fs");const pid=fs.readFileSync("shared/pid-a","utf8").trim();let environment=false,privateFile=false;try{environment=fs.readFileSync("/proc/"+pid+"/environ","utf8").includes("CB_DATA_TOKEN=")}catch{}try{privateFile=fs.readFileSync("${ids[0].home}/private.txt","utf8")==="private-a"}catch{}console.log(JSON.stringify({uid:process.getuid(),groups:process.getgroups(),processAlive:fs.existsSync("/proc/"+pid),environment,privateFile}));'`,
);
assert.equal(other.processAlive, true);
assert.equal(other.environment, false);
assert.equal(other.privateFile, false);
assert.notEqual(other.uid, 0);
assert(!other.groups.includes(0));
for (const pid of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
    const argv = await readFile('/proc/' + pid + '/cmdline').catch(() => Buffer.alloc(0));
    assert(!argv.includes(Buffer.from(secret)), 'A credential appeared in process arguments.');
}
const own = await held;
assert(own.hasToken);
assert.notEqual(own.uid, 0);
assert.equal(own.privateMode, 0o600);
assert(own.noNewPrivs);
assert(own.effectiveCapsZero);
await runtime.dispatch(A, 'files_write', {
    path: 'local-note.txt',
    contents: 'mine',
});
assert.equal((await runtime.dispatch(A, 'files_read', { path: 'local-note.txt' })).text, 'mine');
const unicode = '🦩'.repeat(15000);
await runtime.dispatch(A, 'files_write', {
    path: 'unicode.txt',
    contents: unicode,
});
assert.equal((await runtime.dispatch(A, 'files_read', { path: 'unicode.txt' })).text, unicode);
await assert.rejects(runtime.dispatch(B, 'files_read', { path: 'local-note.txt' }));
await assert.rejects(runtime.dispatch(APP, 'files_read', { path: 'local-note.txt' }));
await assert.rejects(runtime.dispatch(JOB, 'files_read', { path: 'local-note.txt' }));
await runtime.dispatch(A, 'files_write', {
    path: 'shared/tool-shared.txt',
    contents: 'shared-through-tool',
});
assert.equal((await runtime.dispatch(B, 'files_read', { path: 'shared/tool-shared.txt' })).text, 'shared-through-tool');
// Shared writes are deliberate: the owner chooses group readability.
await execute(
    A,
    `bun -e 'const fs=require("node:fs");fs.writeFileSync("shared/public.txt","shared-a");fs.chmodSync("shared/public.txt",0o660);console.log("{}")'`,
);
assert.equal((await runtime.dispatch(B, 'files_read', { path: 'shared/public.txt' })).text, 'shared-a');
const files = await runtime.dispatch(B, 'files_list', { path: '' });
assert(files.entries.some((e) => e.path === 'shared' && e.kind === 'folder'));
await execute(B, `bun -e 'require("node:fs").symlinkSync("${ids[0].home}/private.txt","escape");console.log("{}")'`);
await assert.rejects(runtime.dispatch(B, 'files_read', { path: 'escape' }));
await assert.rejects(
    runtime.dispatch(B, 'files_read', {
        path: '../' + ids[0].key + '/private.txt',
    }),
);
assert.throws(() => runtime.identity({ kind: 'root', id: 'bad' }));
await copyFile('/bin/cat', '/test-shared/suid-cat');
await chmod('/test-shared/suid-cat', 0o4755);
const elevated = await runtime.dispatch(B, 'exec', {
    command: 'shared/suid-cat ' + ids[0].home + '/private.txt',
    timeoutMs: 1000,
});
assert.notEqual(elevated.exitCode, 0);
assert(!elevated.stdout.includes('private-a'));
const aborted = new globalThis.AbortController();
const cancelled = runtime.dispatch(B, 'exec', { command: 'sleep 30', timeoutMs: 30000 }, { signal: aborted.signal });
setTimeout(() => aborted.abort(), 200);
await assert.rejects(cancelled, /cancelled/);
// CB-226: the real detached job wrapper must launch from a private nested home.
const jobDir = '.socio/jobs/kernel-fixture/run';
await runtime.dispatch(JOB, 'files_write', {
    path: `${jobDir}/main.ts`,
    contents: 'console.log("JOB_CWD_OK");',
});
await runtime.dispatch(JOB, 'files_write', {
    path: `${jobDir}/run.sh`,
    contents: runScript({
        command: jobEntryCommand('main.ts'),
        seconds: 5,
        waitSeconds: 0,
    }),
});
const launched = await runtime.dispatch(JOB, 'exec', {
    command: `setsid bash ${jobDir}/run.sh < /dev/null > /dev/null 2>&1 & echo started`,
    timeoutMs: 5000,
});
assert.equal(launched.exitCode, 0);
let jobExit;
for (const end = Date.now() + 5000; Date.now() < end;) {
    try {
        jobExit = await runtime.dispatch(JOB, 'files_read', {
            path: `${jobDir}/exit.code`,
        });
        break;
    } catch {
        await new Promise((r) => setTimeout(r, 50));
    }
}
assert.equal(jobExit?.text.trim(), '0');
assert.equal((await runtime.dispatch(JOB, 'files_read', { path: `${jobDir}/out.log` })).text.trim(), 'JOB_CWD_OK');
assert.equal((await lstat('/test-private')).mode & 0o777, 0o755);
assert.equal((await lstat((await runtime.identity(JOB)).home)).mode & 0o777, 0o700);
// CB-226: ordinary package scripts must work in a person's private project,
// not only jobs using their fixed direct Bun entry.
await runtime.dispatch(A, 'files_write', {
    path: 'project/package.json',
    contents: JSON.stringify({
        name: 'private-project',
        scripts: { proof: 'bun ./main.ts' },
    }),
});
await runtime.dispatch(A, 'files_write', {
    path: 'project/main.ts',
    contents: 'console.log("PRIVATE_PACKAGE_SCRIPT_OK");',
});
const packageScript = await runtime.dispatch(A, 'exec', {
    command: 'cd project && bun run proof',
    timeoutMs: 5000,
});
assert.equal(packageScript.exitCode, 0, packageScript.stderr);
assert.equal(packageScript.stdout.trim(), 'PRIVATE_PACKAGE_SCRIPT_OK');
// Readable root metadata never makes principal names or the registry readable.
const metadata = await execute(
    B,
    `bun -e 'const fs=require("node:fs");let homes=false,registry=false;try{fs.readdirSync("/test-private/homes");homes=true}catch{}try{fs.readFileSync("/test-private/control/principals.json");registry=true}catch{}console.log(JSON.stringify({homes,registry}));'`,
);
assert.equal(metadata.homes, false);
assert.equal(metadata.registry, false);
assert.equal((await lstat('/test-private/homes')).mode & 0o777, 0o711);
assert.equal((await lstat('/test-private/control')).mode & 0o777, 0o700);
assert.equal((await lstat('/test-private/control/principals.json')).mode & 0o777, 0o600);
const registry = '/test-private/control/principals.json';
const saved = await readFile(registry);
await unlink(registry);
await assert.rejects(runtime.identity(A), /registry is missing/);
await writeFile(registry, saved, { mode: 0o600 });
await writeFile(registry, JSON.stringify({ version: 1, nextUid: 20001, entries: {} }), { mode: 0o600 });
await assert.rejects(runtime.identity(B), /does not match/);
await writeFile(registry, saved, { mode: 0o600 });
await writeFile(registry, 'broken', { mode: 0o600 });
await assert.rejects(runtime.identity(B));
await writeFile(registry, saved, { mode: 0o600 });
console.log(
    JSON.stringify({
        passed: true,
        checks: {
            privatePackageScript: true,
            principalNamesAndRegistryUnreadable: true,
            detachedJobEntryInPrivateCwd: true,
            distinctPrincipals: true,
            restartPreservesUid: true,
            privateHomePermissions: true,
            concurrentProcDenied: true,
            privateFileDenied: true,
            commandEnvironmentDelivered: true,
            credentialsAbsentFromArgv: true,
            unicodeRoundtrip: true,
            privateFileMode: true,
            noNewPrivileges: true,
            noEffectiveCapabilities: true,
            legacySuidCannotElevate: true,
            cancellation: true,
            appAndJobCannotReadPersonFiles: true,
            explicitSharedFiles: true,
            fileApiSymlinkAndTraversalDenied: true,
            invalidPrincipalsRefused: true,
            missingCorruptAndStaleRegistryFailClosed: true,
        },
    }),
);
