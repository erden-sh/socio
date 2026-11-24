import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeBundle } from '@socio/foundation/apps/bundle';

import { runtimeConfigFromEnv } from '../src/apps-runtime/config.js';
import { AppsSupervisor } from '../src/apps-runtime/supervisor.js';

/**
 * The runtime as production runs it: its own uid with CAP_CHOWN but not
 * CAP_FOWNER, umask 007, a uid per app. Tests can't switch users, so the
 * file system plays it: a chown gives a path away (recorded, not done) and
 * a chmod of a path given away fails with EPERM, as it does there. Apps run
 * as this process (setpriv needs the capabilities). The real thing, in a
 * container with production's uid, capabilities and umask, is
 * scripts/apps-runtime-caps.sh.
 */
const given = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    const self = process.getuid?.() ?? 0;
    const eperm = (syscall: string, path: string) =>
        Object.assign(new Error(`EPERM: operation not permitted, ${syscall} '${path}'`), {
            code: 'EPERM',
            syscall,
            path,
        });
    const opened = new Map<number, string>();
    const give = (path: string, uid: number) => {
        if (uid === self) {
            given.delete(path);
        } else {
            given.set(path, uid);
        }
    };
    const mocked = {
        ...fs,
        openSync: (path: string, ...rest: [never, never]) => {
            const fd = fs.openSync(path, ...rest);
            opened.set(fd, path);
            return fd;
        },
        closeSync: (fd: number) => {
            opened.delete(fd);
            fs.closeSync(fd);
        },
        lchownSync: (path: string, uid: number) => give(path, uid),
        fchownSync: (fd: number, uid: number) => give(opened.get(fd)!, uid),
        // The app runs as this process here: its socket is its user's.
        fstatSync: (fd: number, ...rest: [never]) => {
            const stat = fs.fstatSync(fd, ...rest);
            if (stat.isSocket()) {
                stat.uid = 20000;
            }
            return stat;
        },
        chmodSync: (path: string, mode: number) => {
            if (given.has(path)) {
                throw eperm('chmod', path);
            }
            fs.chmodSync(path, mode);
        },
        renameSync: (from: string, to: string) => {
            fs.renameSync(from, to);
            const owner = given.get(from);
            given.delete(from);
            if (owner === undefined) {
                given.delete(to);
            } else {
                given.set(to, owner);
            }
        },
        rmSync: (path: string, options?: import('node:fs').RmOptions) => {
            fs.rmSync(path, options);
            for (const key of [...given.keys()]) {
                if (key === path || key.startsWith(`${path}/`)) {
                    given.delete(key);
                }
            }
        },
    };
    return { ...mocked, default: mocked };
});
// setpriv needs CAP_SETUID: the app runs as this process here.
vi.mock('../src/apps-runtime/agent-user.js', () => ({ agentUserCommand: () => [] }));

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const APP = `
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((req, res) => {
  res.end(readFileSync(process.env.CB_DATA_TOKEN_FILE, 'utf8').trim());
}).listen(process.env.CB_SOCKET);
process.on('SIGTERM', () => process.exit(0));
`;

const get = (socketPath: string) =>
    new Promise<string>((resolve, reject) => {
        request({ socketPath, path: '/' }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve(body));
        })
            .on('error', reject)
            .end();
    });

describe('the runtime without CAP_FOWNER', () => {
    it('starts an app as its own user and replaces its token', async () => {
        const umask = process.umask(0o007);
        const dir = mkdtempSync(join(tmpdir(), 'cb-rt-caps-'));
        const supervisor = new AppsSupervisor(
            runtimeConfigFromEnv({
                APPS_RUNTIME_TOKEN: 'runtime-token-0123456789abcdef',
                APPS_RUNTIME_DIR: dir,
                APPS_RUNTIME_COMMAND: process.execPath,
                APPS_RUNTIME_START_SECONDS: '5',
                APPS_RUNTIME_UID_BASE: '20000',
                APPS_RUNTIME_GID: String(process.getgid?.() ?? 1000),
                PATH: process.env.PATH,
            }),
            () => {},
        );
        supervisor.init();
        cleanup.push(async () => {
            await supervisor.stopAll();
            process.umask(umask);
            rmSync(dir, { recursive: true, force: true });
        });
        const id = 'tracker--dot-ab12cd';
        const packed = encodeBundle({
            manifest: {
                name: 'Tracker',
                description: '',
                entry: 'server.mjs',
                runtime: 'bun',
                datasets: [],
                egress: [],
            },
            files: [{ path: 'server.mjs', data: Buffer.from(APP) }],
        });
        await supervisor.deploy(id, 1, packed.bytes, packed.sha256);
        const started = await supervisor.start(id, {
            version: 1,
            token: 'cbdt_app-token-1',
            dataUrl: 'http://app:4310/api/data',
            appUrl: `http://${id}.apps.localhost:4310`,
            env: {},
        });
        expect(started).toMatchObject({ state: 'running', version: 1 });
        // Given to the app's user with its final mode: read only, for it alone.
        const file = join(dir, id, 'run', 'data-token');
        expect(given.get(file)).toBe(20000);
        expect(statSync(file).mode & 0o777).toBe(0o400);
        expect(given.get(join(dir, id, 'v1', 'server.mjs'))).toBe(20000);
        expect(await get(supervisor.socketPath(id))).toBe('cbdt_app-token-1');
        // A new token replaces the file whole, the same way.
        supervisor.setToken(id, 'cbdt_app-token-2');
        expect(readFileSync(file, 'utf8').trim()).toBe('cbdt_app-token-2');
        expect(given.get(file)).toBe(20000);
        expect(statSync(file).mode & 0o777).toBe(0o400);
        expect(await get(supervisor.socketPath(id))).toBe('cbdt_app-token-2');
    });
});
