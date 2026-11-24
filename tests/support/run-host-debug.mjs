// Manual debug driver for the session-host entry. Spawns the entry against the
// fake codex peer, sends turn_start, waits for events, sends close, and prints
// all stdout + stderr. Run with: node tests/support/run-host-debug.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tok = mkdtempSync(join(tmpdir(), 'socio-host-'));
writeFileSync(join(tok, 'token'), 'cbgw_test_token_0123456789');

const child = spawn('node', ['--import', 'tsx', 'src/server/coding/host/session-host.ts', 'sess-1', 'codex', 'gpt-5'], {
    cwd: process.cwd(),
    env: {
        ...process.env,
        SOCIO_HOST_TOKEN_FILE: join(tok, 'token'),
        SOCIO_HOST_CODEX_BIN: 'tests/support/fake-codex-bin.sh',
        SOCIO_HOST_CWD: tok,
        SOCIO_HOST_STATE_DIR: join(tok, 'state'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => {
    stdout += c;
});
child.stderr.on('data', (c) => {
    stderr += c;
});

const exit = new Promise((res) => child.on('exit', (code) => res(code ?? 0)));

await new Promise((r) => setTimeout(r, 800));
child.stdin.write(JSON.stringify({ op: 'turn_start', payload: { message: 'hi' } }) + '\n');
await new Promise((r) => setTimeout(r, 2000));
child.stdin.write(JSON.stringify({ op: 'close' }) + '\n');
const code = await Promise.race([exit, new Promise((r) => setTimeout(() => r('TIMEOUT'), 3000))]);
console.log('=== EXIT', code, '===');
console.log('=== STDOUT ===');
console.log(stdout);
console.log('=== STDERR ===');
console.log(stderr);
child.kill('SIGKILL');
