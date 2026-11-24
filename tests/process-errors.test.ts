import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// CB-516: Node's fetch (undici) can emit "socket idle timeout" on an HTTP/2
// stream with no 'error' listener when an idle pooled connection closes.
// That notice is logged and the process keeps serving; any other error that
// reaches the top still ends the process with code 1.

const monitor = fileURLToPath(new URL('../packages/foundation/src/observability/stall-monitor.ts', import.meta.url));

function run(code: string | undefined) {
    const script = `
        import { EventEmitter } from 'node:events';
        import { guardProcessErrors } from ${JSON.stringify(monitor)};
        guardProcessErrors();
        const error = Object.assign(new Error('socket idle timeout'), { name: 'InformationalError' });
        if (${JSON.stringify(code)} !== undefined) error.code = ${JSON.stringify(code)};
        // An emitter with no 'error' listener, like the HTTP/2 stream in the crash.
        setTimeout(() => new EventEmitter().emit('error', error), 0);
        setTimeout(() => { console.log('still serving'); process.exit(0); }, 50);
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
        timeout: 20_000,
    });
}

it('logs an undici connection notice and keeps the process up', () => {
    const result = run('UND_ERR_INFO');
    expect(result.stdout).toContain('still serving');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Recovered: {"origin":"uncaughtException","name":"InformationalError"');
    expect(result.stderr).not.toContain('Fatal:');
});

it('still exits with code 1 on any other uncaught error', () => {
    const result = run(undefined);
    expect(result.stdout).not.toContain('still serving');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Fatal: {"origin":"uncaughtException"');
});
