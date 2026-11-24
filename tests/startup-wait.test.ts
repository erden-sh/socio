import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { runScript } from '../src/server/schedules/startup-wait.js';

/** The wrapper a job runs through, waiting for the app first (CB-161). */

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
const bunAvailable = spawnSync('bun', ['--version']).status === 0;

/** A run directory holding run.sh and the job's files. */
function runDir(script: string, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'cb-run-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'run.sh'), script);
    for (const [name, contents] of Object.entries(files)) {
        writeFileSync(join(dir, name), contents);
    }
    return dir;
}
const play = (dir: string, env: Record<string, string>) => {
    const started = Date.now();
    spawnSync('bash', [join(dir, 'run.sh')], {
        env: { PATH: process.env.PATH ?? '', ...env },
        stdio: 'ignore',
    });
    const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
    return {
        ms: Date.now() - started,
        exit: read('exit.code')?.trim(),
        out: read('out.log'),
        err: read('err.log'),
    };
};
async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

it('keeps the job’s command line exactly as it was, after the wait', () => {
    const ts = runScript({
        command: 'bun ./main.ts',
        seconds: 30,
        waitSeconds: 15,
    });
    expect(ts).toContain('timeout -k 5 30 bun ./main.ts > out.log 2> err.log < /dev/null &');
    expect(ts.indexOf('/healthz')).toBeLessThan(ts.indexOf('timeout -k 5'));
    // No wait: the script is the one from before.
    expect(runScript({ command: 'bash main.sh', seconds: 30, waitSeconds: 0 })).toBe(
        [
            'cd "$(dirname "$0")" || exit 1',
            'timeout -k 5 30 bash main.sh > out.log 2> err.log < /dev/null &',
            'echo $! > job.pid',
            'wait $!',
            'echo $? > exit.code',
            '',
        ].join('\n'),
    );
});

it.skipIf(!bunAvailable)('really runs main.ts through run.sh', () => {
    const dir = runDir(runScript({ command: 'bun ./main.ts', seconds: 30, waitSeconds: 5 }), {
        'main.ts': 'console.log("ran " + (1 + 1));\n',
    });
    expect(play(dir, {})).toMatchObject({ exit: '0', out: 'ran 2\n' });
});

it('waits for an app that starts late, then runs the job once', async () => {
    const port = await freePort();
    const dir = runDir(runScript({ command: 'bash main.sh', seconds: 30, waitSeconds: 15 }), {
        'main.sh': 'echo ran >> ran.txt\n',
    });
    setTimeout(() => {
        const server = createServer((request, response) => {
            response.statusCode = request.url === '/healthz' ? 200 : 404;
            response.end('{"ok":true}');
        });
        servers.push(server);
        server.listen(port, '127.0.0.1');
    }, 1500);
    const run = await new Promise<ReturnType<typeof play>>((resolve) => {
        // Off the event loop's thread: the server must answer meanwhile.
        import('node:child_process').then(({ spawn }) => {
            const started = Date.now();
            spawn('bash', [join(dir, 'run.sh')], {
                env: {
                    PATH: process.env.PATH ?? '',
                    CB_DATA_URL: `http://127.0.0.1:${port}/api/data`,
                },
                stdio: 'ignore',
            }).on('exit', () =>
                resolve({
                    ms: Date.now() - started,
                    exit: readFileSync(join(dir, 'exit.code'), 'utf8').trim(),
                    out: null,
                    err: null,
                }),
            );
        });
    });
    expect(run.exit).toBe('0');
    expect(run.ms).toBeGreaterThanOrEqual(1400);
    expect(readFileSync(join(dir, 'ran.txt'), 'utf8')).toBe('ran\n');
}, 30_000);

it('fails the batch, saying the connection was refused, when the app is never up', async () => {
    const port = await freePort();
    const dir = runDir(runScript({ command: 'bash main.sh', seconds: 30, waitSeconds: 2 }), {
        'main.sh': 'echo ran >> ran.txt\n',
    });
    const run = play(dir, { CB_DATA_URL: `http://127.0.0.1:${port}/api/data` });
    expect(run.exit).toBe('1');
    expect(run.err).toMatch(/^Connection refused: the app at http:\/\/127\.0\.0\.1:\d+ did not answer within 2 s/);
    expect(existsSync(join(dir, 'ran.txt'))).toBe(false);
    expect(run.ms).toBeLessThan(8000);
}, 30_000);

it('runs a set -u script without a data API address, with no wait', () => {
    const dir = runDir(runScript({ command: 'bash main.sh', seconds: 30, waitSeconds: 15 }), {
        'main.sh': 'set -u\necho "url=${CB_DATA_URL:-none}"\n',
    });
    expect(play(dir, {})).toMatchObject({ exit: '0', out: 'url=none\n' });
});
