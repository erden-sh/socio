#!/usr/bin/env node
// A TCP proxy between the app and one servers.mjs workspace, for the chaos
// cases: it drops the chat's follow streams (`/stream`) or plays
// the server going away (a restart, a deploy): every connection reset and new
// ones refused, until it comes back.
//
//   node apps/mobile/e2e/chaos-proxy.mjs [--port 4351] [--listen 4451] [--control 4459]
//       [--device <serial> | --no-adb]
//
// The app keeps its origin (`http://localhost:<port>`): on Android the proxy
// points the device's `adb reverse tcp:<port>` at itself and puts servers.mjs's
// rule back at the end; from a Mac, open the tunnel to `--listen` instead of
// the server's port (`ssh -N -R 4351:127.0.0.1:4451 -R 4459:127.0.0.1:4459 <mac>`).
// Control it from the keyboard (d: drop the streams, o: off, u: up again) or
// over loopback HTTP, as the flows do from Maestro (`common/proxy.yaml`):
// POST /drop, /down, /stall, /up; GET /status. Stall (the pages' kill mid-save)
// passes every request on but holds the answers until up: the server has
// done the write and the app hasn't heard, as when it is killed mid-save. Bytes pass as they are; nothing is read
// but each request line, to spot a stream and to count requests: GET
// /requests lists them by method and path, ids as `:id` (`requestKey`), and
// POST /reset starts the count again, so a flow or a script can say how many
// saves and page reads one stretch sent (`two-devices.mjs`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_PROXY = { port: 4351, listen: 4451, control: 4459 };

const USAGE = `Usage: node apps/mobile/e2e/chaos-proxy.mjs [options]

  --port <port>       the workspace server's port, which the app's origin names (default ${DEFAULT_PROXY.port})
  --listen <port>     where the proxy listens (default ${DEFAULT_PROXY.listen})
  --control <port>    the loopback control port (default ${DEFAULT_PROXY.control})
  --device <serial>   the Android device whose adb reverse it takes over (default: ANDROID_SERIAL)
  --no-adb            leave adb alone (a Mac's simulator, through a tunnel)`;

/** @param {string} value @param {string} flag */
function portOf(value, flag) {
    const number = Number(value);
    if (!/^\d+$/.test(value) || number < 1024 || number > 65535) {
        throw new Error(`${flag} takes a port from 1024 to 65535, not "${value}".`);
    }
    return number;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseProxyArgs(argv, env = {}) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            port: { type: 'string', default: String(DEFAULT_PROXY.port) },
            listen: { type: 'string', default: String(DEFAULT_PROXY.listen) },
            control: { type: 'string', default: String(DEFAULT_PROXY.control) },
            device: { type: 'string' },
            'no-adb': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: USAGE };
    }
    const options = {
        port: portOf(values.port, '--port'),
        listen: portOf(values.listen, '--listen'),
        control: portOf(values.control, '--control'),
        device: values.device ?? env.ANDROID_SERIAL ?? null,
        adb: !values['no-adb'],
    };
    if (new Set([options.port, options.listen, options.control]).size !== 3) {
        throw new Error('--port, --listen and --control must be different ports.');
    }
    if (options.adb && options.device === null) {
        throw new Error('Name the device (--device or ANDROID_SERIAL), or pass --no-adb.');
    }
    return options;
}

/** Whether a connection's first bytes ask for a chat's follow stream. @param {string} head */
export function isStreamRequest(head) {
    return /^GET \/api\/conversations\/[^/\s]+\/stream[?\s]/.test(head);
}

/** The collections whose next path segment is an id (`/api/spaces/<id>/pages/<id>`). */
const ID_AFTER = new Set(['spaces', 'pages', 'conversations', 'issues', 'rooms', 'media', 'members', 'images']);
/** Words that follow a collection but aren't ids. */
const NOT_IDS = new Set(['search', 'deleted', 'titles']);

/**
 * A request's method and path with its query dropped and each id as `:id`:
 * `PATCH /api/spaces/s-1/pages/p-2?x=1` is `PATCH /api/spaces/:id/pages/:id`.
 * @param {string} method
 * @param {string} target
 */
export function requestKey(method, target) {
    const segments = target.split('?')[0].split('/');
    const path = segments
        .map((segment, index) =>
            index > 0 && ID_AFTER.has(segments[index - 1]) && segment !== '' && !NOT_IDS.has(segment) ? ':id' : segment,
        )
        .join('/');
    return `${method} ${path}`;
}

/**
 * The requests that start in a chunk the app sent: a request line at its
 * start, or right after a CRLF or a JSON body's last bracket (a kept-alive
 * connection's next request), as `requestKey`s. A body that happens to hold
 * such a line would count too; the app's JSON bodies hold no CRLF.
 * @param {string} chunk
 */
export function requestLines(chunk) {
    const found = [];
    for (const match of chunk.matchAll(
        /(?:^|\r\n|(?<=[}\]]))(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*) HTTP\/1\.[01]\r\n/g,
    )) {
        found.push(requestKey(match[1], match[2]));
    }
    return found;
}

const say = (/** @type {string} */ line) => console.log(`[chaos-proxy] ${line}`);

function main() {
    const options = parseProxyArgs(process.argv.slice(2), process.env);
    if ('help' in options) {
        console.log(options.help);
        return;
    }
    const sdk = process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk');
    const adbPath = existsSync(join(sdk, 'platform-tools/adb')) ? join(sdk, 'platform-tools/adb') : 'adb';
    const adb = (/** @type {string[]} */ args) =>
        spawnSync(adbPath, ['-s', String(options.device), ...args], { encoding: 'utf8' });

    /** @type {Set<{ client: import('node:net').Socket, upstream: import('node:net').Socket, stream: boolean, held: Buffer[] }>} */
    const pairs = new Set();
    let down = false;
    let stalled = false;
    const counts = { connections: 0, dropped: 0, refused: 0 };
    /** @type {Map<string, number>} requests by `requestKey`, since the start or the last POST /reset */
    const requests = new Map();

    const proxy = createServer((client) => {
        if (down) {
            counts.refused += 1;
            client.resetAndDestroy();
            return;
        }
        counts.connections += 1;
        const upstream = connect(options.port, '127.0.0.1');
        /** @type {{ client: import('node:net').Socket, upstream: import('node:net').Socket, stream: boolean, held: Buffer[] }} */
        const pair = { client, upstream, stream: false, held: [] };
        pairs.add(pair);
        // Each request on a kept-alive connection starts a chunk with its request line: the latest says
        // whether the connection now carries a stream (a stream's response holds it until it ends).
        client.on('data', (chunk) => {
            const head = chunk.toString('latin1', 0, 256);
            if (/^[A-Z]+ \//.test(head)) {
                pair.stream = isStreamRequest(head);
            }
            for (const key of requestLines(chunk.toString('latin1'))) {
                requests.set(key, (requests.get(key) ?? 0) + 1);
            }
        });
        client.pipe(upstream);
        upstream.on('data', (chunk) => {
            if (stalled) {
                pair.held.push(chunk);
            } else {
                client.write(chunk);
            }
        });
        upstream.on('end', () => {
            if (!stalled) {
                client.end();
            }
        });
        const end = () => {
            pairs.delete(pair);
            client.destroy();
            upstream.destroy();
        };
        client.on('error', end).on('close', end);
        upstream.on('error', end).on('close', end);
    });

    const drop = (/** @type {boolean} */ all) => {
        let dropped = 0;
        for (const pair of [...pairs]) {
            if (all || pair.stream) {
                pair.client.resetAndDestroy();
                pair.upstream.destroy();
                pairs.delete(pair);
                dropped += 1;
            }
        }
        counts.dropped += dropped;
        return dropped;
    };
    const actions = {
        drop: () => `dropped ${drop(false)} stream(s)`,
        down: () => {
            down = true;
            return `down: reset ${drop(true)} connection(s), refusing new ones`;
        },
        stall: () => {
            stalled = true;
            return 'stalled: requests pass, answers are held';
        },
        up: () => {
            down = false;
            stalled = false;
            for (const pair of pairs) {
                for (const chunk of pair.held.splice(0)) {
                    pair.client.write(chunk);
                }
            }
            return 'up';
        },
        reset: () => {
            requests.clear();
            return 'request count reset';
        },
    };
    const status = () => ({
        down,
        stalled,
        open: pairs.size,
        streams: [...pairs].filter((pair) => pair.stream).length,
        ...counts,
    });

    const control = createHttpServer((request, response) => {
        const name = (request.url ?? '').replace(/^\//, '').split('?')[0];
        if (request.method === 'POST' && name in actions) {
            const line = actions[/** @type {keyof typeof actions} */ (name)]();
            say(line);
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status()));
            return;
        }
        if (request.method === 'GET' && name === 'requests') {
            response
                .writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify(Object.fromEntries([...requests].sort())));
            return;
        }
        if (request.method === 'GET' && name === 'status') {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status()));
            return;
        }
        response.writeHead(404).end();
    });

    let reversed = false;
    const teardown = () => {
        if (reversed) {
            // servers.mjs's own rule back, so its teardown finds what it added.
            adb(['reverse', `tcp:${options.port}`, `tcp:${options.port}`]);
        }
        drop(true);
        proxy.close();
        control.close();
        process.exit(0);
    };
    process.on('SIGINT', teardown).on('SIGTERM', teardown);

    proxy.listen(options.listen, '127.0.0.1', () => {
        control.listen(options.control, '127.0.0.1', () => {
            if (options.adb) {
                const result = adb(['reverse', `tcp:${options.port}`, `tcp:${options.listen}`]);
                if (result.status !== 0) {
                    say(`adb reverse failed: ${String(result.stderr).trim()}`);
                    teardown();
                    return;
                }
                reversed = true;
            }
            say(
                `127.0.0.1:${options.listen} → 127.0.0.1:${options.port}; control on 127.0.0.1:${options.control}; keys d (drop streams), o (off), u (up), q (quit)`,
            );
        });
    });

    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.on('data', (key) => {
            const pressed = key.toString();
            if (pressed === 'q' || pressed === '\u0003') {
                teardown();
            } else if (pressed === 'd') {
                say(actions.drop());
            } else if (pressed === 'o') {
                say(actions.down());
            } else if (pressed === 'u') {
                say(actions.up());
            }
        });
    }
}

if (import.meta.main) {
    try {
        main();
    } catch (error) {
        console.error(`[chaos-proxy] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
