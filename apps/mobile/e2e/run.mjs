#!/usr/bin/env node
// Runs the app's Maestro flows (flows/) on an Android emulator or phone, or an
// iOS simulator, for one variant, then lists the app's whole container from
// the host after each flow.
//
//   node apps/mobile/e2e/run.mjs [--platform android|ios]
//       [--variant development|preview|production] [--metro <port>]
//       [--device <serial or udid>] [--out <dir>] [--credentials <file>]
//       [--no-workspace-left] [--servers-down] [--proxy-control <port>]
//       [--servers-control <port>] [--env NAME=value ...] [flow.yaml ...]
//
// With no flow named it runs flows/launch.yaml. Each flow gets APP_ID, the
// variant's application id, APP_SCHEME, its link scheme, and DEV_CLIENT_URL, the development client's link
// to Metro at http://localhost:<port> (with --metro; empty otherwise). With
// --credentials (servers.mjs's file) it also gets PASSWORD and, per workspace
// letter, ORIGIN_A, HOST_A, WORKSPACE_A and CHAT_A. PROXY_CONTROL and
// SERVERS_CONTROL are chaos-proxy.mjs's and servers.mjs's control ports
// (4459 and 4549 unless --proxy-control and --servers-control say otherwise:
// a second set of servers, beside another run's). Each --env NAME=value hands
// a flow one more variable (the pages' two-device flows: which line to edit and
// what to type). With --no-workspace-left a
// flow fails when its container listing still holds a workspace's folder or an
// answer in the system's HTTP cache (Android's cache/http-cache entries; iOS's
// Library/Caches/<app id>/Cache.db rows for a --credentials origin, read with
// sqlite3), a WebView's stored data or an iOS app-switcher snapshot, or when
// the listing itself failed (a command's error, or no
// socio/registry.db).
// A flow in NO_ROOMS_FLOWS (chat-tour.yaml) runs only against servers.mjs
// --no-rooms: it archives every chat, and a room has no Archive.
// With --servers-down nothing runs while an origin from --credentials answers,
// or, on Android, while an adb reverse rule still carries an origin's port. On
// Android, --metro also adds `adb reverse` for the port and removes it at the
// end. Start Metro yourself, on loopback and without Bonjour:
// `EXPO_UNSTABLE_BONJOUR=0 pnpm start --port <port> --localhost`.
//
// Maestro runs with its analytics off, and with its API pointed at a closed
// local port: 2.12.1 asks that API for its latest version on every start (with
// an install id) and sends it error reports with the command line.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const FLOWS = join(import.meta.dirname, 'flows');

/** chaos-proxy.mjs's and servers.mjs's default control ports, which flows/common/*.js post to. */
export const DEFAULT_PROXY_CONTROL = 4459;
export const DEFAULT_SERVERS_CONTROL = 4549;

/** Maestro 2.12.1's switches: no analytics, no notices, and its API on a port nothing listens on. */
export const MAESTRO_ENV = {
    MAESTRO_CLI_NO_ANALYTICS: '1',
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    MAESTRO_DISABLE_UPDATE_CHECK: 'true',
    MAESTRO_API_URL: 'http://127.0.0.1:1',
};

/** Each variant's application id and scheme, as variant.ts has them. */
export const VARIANT_APPS = {
    development: { id: 'com.ingenioventures.socio.dev', scheme: 'socio-dev' },
    preview: { id: 'com.ingenioventures.socio.preview', scheme: 'socio-preview' },
    production: { id: 'com.ingenioventures.socio', scheme: 'socio' },
};

/** The variables run.mjs hands every flow itself, which --env can't set. */
export const RESERVED_ENV = ['APP_ID', 'APP_SCHEME', 'DEV_CLIENT_URL', 'PROXY_CONTROL', 'SERVERS_CONTROL', 'PASSWORD'];

const USAGE = `Usage: node apps/mobile/e2e/run.mjs [options] [flow.yaml ...]

  --platform <android|ios>   where to run (default android)
  --variant <name>           development (default), preview or production
  --metro <port>             a development build loads from Metro at http://localhost:<port>
  --device <id>              the emulator or phone serial, or the simulator's udid
  --out <dir>                Maestro's output and the listings (default: a new temporary directory)
  --credentials <file>       servers.mjs's credentials file: PASSWORD and each workspace's ORIGIN_, HOST_, WORKSPACE_, CHAT_, SPACE_, PAGE_, SUBPAGE_
  --no-workspace-left        fail a flow whose container listing still holds a workspace's folder, an HTTP cache entry, a WebView's stored data or an iOS app-switcher snapshot, or failed
  --servers-down             run nothing while a --credentials origin answers or an adb reverse rule carries its port
  --proxy-control <port>     chaos-proxy.mjs's control port, PROXY_CONTROL in flows (default 4459)
  --servers-control <port>   servers.mjs's control port, SERVERS_CONTROL in flows (default 4549)
  --env <NAME=value>         one more variable for the flows (repeatable)`;

/**
 * The variables a flow gets from servers.mjs's credentials file: the password,
 * and each workspace's origin, host (the drawer's testIDs), name, marker chat, and Space with its
 * page and subpage by letter.
 * @param {{ password: string, servers: { letter: string, origin: string, workspaceName: string, chat: string, space?: string, page?: string, subpage?: string }[] }} credentials
 * @returns {Record<string, string>}
 */
export function credentialEnv(credentials) {
    /** @type {Record<string, string>} */
    const env = { PASSWORD: credentials.password };
    for (const server of credentials.servers) {
        env[`ORIGIN_${server.letter}`] = server.origin;
        env[`HOST_${server.letter}`] = new URL(server.origin).host;
        env[`WORKSPACE_${server.letter}`] = server.workspaceName;
        env[`CHAT_${server.letter}`] = server.chat;
        // Values for the library flows; older credentials files have none.
        for (const [name, value] of [
            ['SPACE', server.space],
            ['PAGE', server.page],
            ['SUBPAGE', server.subpage],
        ]) {
            if (typeof value === 'string') {
                env[`${name}_${server.letter}`] = value;
            }
        }
    }
    return env;
}

/**
 * The flows that empty the chat list (chat-tour.yaml: the first run shows only
 * then), which a room would keep from emptying: the app has no Archive for a
 * room. They need servers.mjs started with `--no-rooms`.
 */
export const NO_ROOMS_FLOWS = ['chat-tour.yaml'];

/**
 * Why these flows can't run against these servers: a NO_ROOMS_FLOWS flow
 * while the credentials file says Rooms are on or lists a room. Null when
 * they can.
 * @param {string[]} flows
 * @param {{ rooms?: boolean, servers: Array<{ room?: unknown }> } | undefined} credentials
 */
export function roomsRefusal(flows, credentials) {
    const needing = flows.map((flow) => basename(flow)).filter((name) => NO_ROOMS_FLOWS.includes(name));
    if (!credentials || needing.length === 0) {
        return null;
    }
    if (credentials.rooms !== true && !credentials.servers.some((server) => server.room)) {
        return null;
    }
    return `${needing.join(', ')} archive${needing.length === 1 ? 's' : ''} every chat, and the app can't archive a room: start servers.mjs with --no-rooms.`;
}

/**
 * The workspace folders in a container listing: `socio/<id>/`, where `<id>` is
 * a hex SHA-256 (layout.ts). After a sign-out there must be none.
 * @param {string} listing
 */
export function workspaceFolders(listing) {
    return [...new Set(listing.match(/socio\/[0-9a-f]{64}/g) ?? [])];
}

/**
 * The entries in Android's HTTP cache (OkHttp's DiskLruCache under
 * `cache/http-cache/`): `<md5 of the URL>.0` and `.1` files. The journal alone,
 * which OkHttp writes as it opens the cache, holds no answer.
 * @param {string} listing
 */
export function httpCacheEntries(listing) {
    return [...new Set(listing.match(/cache\/http-cache\/[0-9a-f]{32}\.\d+/g) ?? [])];
}

/**
 * What a WebView kept that could hold a page's data:
 * under Android's `app_webview/` and iOS's `Library/WebKit/` and
 * `Library/Caches/<id>/WebKit/`, the stores a page fills (IndexedDB, Local
 * Storage's tables, Service Workers, the HTTP and code caches' entries, file
 * systems, WebSQL's databases, iOS's website data and cookie file). Chromium's
 * empty bookkeeping (Cookies with no row, Local Storage's empty log, WebSQL's
 * Databases.db, Preferences)
 * isn't data. The page editor runs incognito with storage off, and sign-out
 * clears every WebView's data, so after a sign-out there must be none.
 * @param {string} listing
 */
export function webViewStorage(listing) {
    const roots = /(?:^|\/)(?:app_webview|Library\/WebKit|Library\/Caches\/[^/\n]+\/WebKit)\//;
    const stores =
        /\/(?:IndexedDB\/[^\n]+|Local Storage\/leveldb\/\d+\.ldb|Service Worker\/[^\n]+|Cache\/Cache_Data\/[0-9a-f]{16}_\d|Code Cache\/js\/[0-9a-f]{16}_\d|File System\/[^\n]+|databases\/[^/\n]+\/[^\n]+|WebsiteData\/(?:LocalStorage|IndexedDB|ServiceWorkers|CacheStorage)\/[^\n]+|Cookies\.binarycookies)$/;
    return [...new Set(listing.split('\n').filter((line) => roots.test(line) && stores.test(line)))];
}

/**
 * iOS's app-switcher snapshots of the app (CB-356): any file under
 * `Library/SplashBoard/Snapshots/` or `Library/Caches/Snapshots/`. Every wipe,
 * sign-out's included, deletes them (socio-device's `deleteAppSnapshots`), so
 * after a sign-out there must be none, whatever the app showed before it. The
 * switcher's are under `sceneID:<id>-default/`; the launch screen's images,
 * under `<id> - {DEFAULT GROUP}/`, count too: the delete takes them, and iOS
 * draws them again only at the next launch (the iOS 27 simulator).
 * @param {string} listing
 */
export function appSnapshots(listing) {
    const snapshot = /(?:^|\/)Library\/(?:SplashBoard|Caches)\/Snapshots\/[^\n]*\/[^/\n]+\.[A-Za-z0-9]+$/;
    return [...new Set(listing.split('\n').filter((line) => snapshot.test(line)))];
}

/**
 * The URLs in iOS's URL cache (`Cache.db`'s request keys) that belong to a
 * workspace: on one of `origins`, or, with none given, any `/api/` path.
 * @param {string[]} urls
 * @param {string[]} origins
 */
export function workspaceCacheUrls(urls, origins) {
    const wanted = new Set(origins.map((origin) => new URL(origin).origin));
    return urls.filter((key) => {
        let url;
        try {
            url = new URL(key);
        } catch {
            return false;
        }
        return wanted.size > 0 ? wanted.has(url.origin) : url.pathname.startsWith('/api/');
    });
}

/**
 * Why a --no-workspace-left listing fails: a workspace's folder left, an
 * answer left in the system's HTTP cache (Android's entries in the listing,
 * iOS's `workspaceUrls` from Cache.db), a WebView's stored data (`webViewStorage`), an iOS app-switcher
 * snapshot (`appSnapshots`), a listing command that failed, or a
 * listing that doesn't reach the app's files (no `socio/registry.db`, which
 * sign-out keeps). Empty when it passes.
 * @param {string} listing
 * @param {(number | null)[]} statuses the exit status of each command the listing needs
 * @param {string[]} [workspaceUrls] iOS: Cache.db's URLs for a workspace (`workspaceCacheUrls`)
 * @returns {string[]}
 */
export function checkNoWorkspaceLeft(listing, statuses, workspaceUrls = []) {
    const problems = [];
    if (statuses.length === 0 || statuses.some((status) => status !== 0)) {
        problems.push(`a listing command failed (exit ${statuses.join(', ') || 'none'})`);
    }
    if (!/(^|\/)socio\/registry\.db$/m.test(listing)) {
        problems.push('the listing has no socio/registry.db, so it may not cover the container');
    }
    const left = workspaceFolders(listing);
    if (left.length > 0) {
        problems.push(`a workspace's folder is left: ${left.join(', ')}`);
    }
    const cached = httpCacheEntries(listing);
    if (cached.length > 0) {
        problems.push(
            `the HTTP cache holds ${cached.length} entr${cached.length === 1 ? 'y' : 'ies'}: ${cached.join(', ')}`,
        );
    }
    if (workspaceUrls.length > 0) {
        problems.push(`Cache.db holds a workspace's answers: ${workspaceUrls.join(', ')}`);
    }
    const kept = webViewStorage(listing);
    if (kept.length > 0) {
        problems.push(`a WebView kept data: ${kept.join(', ')}`);
    }
    const snapshots = appSnapshots(listing);
    if (snapshots.length > 0) {
        problems.push(`the app switcher's snapshots are left: ${snapshots.join(', ')}`);
    }
    return problems;
}

/**
 * The origins an `adb reverse --list` still carries to the host: a rule whose
 * device side is `tcp:<the origin's port>`.
 * @param {string} reverseList lines of `<serial> tcp:<device port> tcp:<host port>`
 * @param {string[]} origins
 */
export function reversedOrigins(reverseList, origins) {
    const ports = new Set(
        reverseList
            .split('\n')
            .map((line) => line.trim().split(/\s+/)[1])
            .filter(Boolean),
    );
    return origins.filter((origin) => {
        const url = new URL(origin);
        return ports.has(`tcp:${url.port || (url.protocol === 'https:' ? '443' : '80')}`);
    });
}

/**
 * The origins that still answer an HTTP request within the timeout.
 * @param {string[]} origins
 * @param {number} [timeoutMs]
 */
export async function answeringOrigins(origins, timeoutMs = 3000) {
    const answers = await Promise.all(
        origins.map((origin) =>
            fetch(origin, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }).then(
                () => true,
                () => false,
            ),
        ),
    );
    return origins.filter((_, index) => answers[index]);
}

/**
 * The development client's link that opens the app on the bundle at Metro, skipping its onboarding.
 * @param {string} scheme
 * @param {number} metroPort
 */
export function devClientUrl(scheme, metroPort) {
    return `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metroPort}`)}&disableOnboarding=1`;
}

/**
 * Reads the command line. Throws with a message for anything it can't use.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseRunArgs(argv, env = {}) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            platform: { type: 'string', default: 'android' },
            variant: { type: 'string', default: 'development' },
            metro: { type: 'string' },
            device: { type: 'string' },
            out: { type: 'string' },
            credentials: { type: 'string' },
            'no-workspace-left': { type: 'boolean', default: false },
            'servers-down': { type: 'boolean', default: false },
            'proxy-control': { type: 'string', default: String(DEFAULT_PROXY_CONTROL) },
            'servers-control': { type: 'string', default: String(DEFAULT_SERVERS_CONTROL) },
            env: { type: 'string', multiple: true, default: [] },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: USAGE };
    }
    if (values.platform !== 'android' && values.platform !== 'ios') {
        throw new Error(`--platform must be android or ios, not "${values.platform}".`);
    }
    if (!Object.hasOwn(VARIANT_APPS, values.variant)) {
        throw new Error(`--variant must be development, preview or production, not "${values.variant}".`);
    }
    const app = VARIANT_APPS[/** @type {keyof typeof VARIANT_APPS} */ (values.variant)];
    let metro;
    if (values.metro !== undefined) {
        metro = Number(values.metro);
        if (!/^\d+$/.test(values.metro) || metro < 1024 || metro > 65535) {
            throw new Error(`--metro must be a port number from 1024 to 65535, not "${values.metro}".`);
        }
        if (values.variant !== 'development') {
            throw new Error('--metro is for the development variant: preview and production carry their bundle.');
        }
    }
    const controlPort = (/** @type {string} */ value, /** @type {string} */ flag) => {
        const port = Number(value);
        if (!/^\d+$/.test(value) || port < 1024 || port > 65535) {
            throw new Error(`${flag} must be a port number from 1024 to 65535, not "${value}".`);
        }
        return port;
    };
    const proxyControl = controlPort(values['proxy-control'], '--proxy-control');
    const serversControl = controlPort(values['servers-control'], '--servers-control');
    if (values['servers-down'] && values.credentials === undefined) {
        throw new Error('--servers-down needs --credentials: it checks the origins listed there.');
    }
    /** @type {Record<string, string>} */
    const flowEnv = {};
    for (const entry of values.env) {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/s.exec(entry);
        if (!match) {
            throw new Error(`--env takes NAME=value with an upper-case NAME, not "${entry}".`);
        }
        if (RESERVED_ENV.includes(match[1])) {
            throw new Error(`--env can't set ${match[1]}: run.mjs sets it.`);
        }
        flowEnv[match[1]] = match[2];
    }
    return {
        platform: values.platform,
        appId: app.id,
        scheme: app.scheme,
        devClient: metro === undefined ? '' : devClientUrl(app.scheme, metro),
        metro,
        device: values.device ?? (values.platform === 'android' ? env.ANDROID_SERIAL || undefined : undefined),
        out: values.out,
        credentials: values.credentials === undefined ? undefined : resolve(values.credentials),
        noWorkspaceLeft: values['no-workspace-left'],
        serversDown: values['servers-down'],
        proxyControl,
        serversControl,
        env: flowEnv,
        flows: (positionals.length ? positionals : [join(FLOWS, 'launch.yaml')]).map((flow) => resolve(flow)),
    };
}

const say = (/** @type {string} */ line) => console.log(`[run] ${line}`);

async function main() {
    const options = parseRunArgs(process.argv.slice(2), process.env);
    if ('help' in options) {
        console.log(options.help);
        return 0;
    }
    const home = process.env.HOME || homedir();
    const maestro = existsSync(join(home, '.maestro/bin/maestro')) ? join(home, '.maestro/bin/maestro') : 'maestro';
    const sdk = process.env.ANDROID_HOME ?? join(home, 'Android/Sdk');
    const adbPath = existsSync(join(sdk, 'platform-tools/adb')) ? join(sdk, 'platform-tools/adb') : 'adb';
    const adb = (/** @type {string[]} */ args) =>
        spawnSync(adbPath, [...(options.device ? ['-s', options.device] : []), ...args], { encoding: 'utf8' });
    const out = options.out ? resolve(options.out) : mkdtempSync(join(tmpdir(), 'socio-maestro-'));
    mkdirSync(out, { recursive: true });

    const reverse = options.platform === 'android' && options.metro !== undefined;
    if (reverse) {
        const result = adb(['reverse', `tcp:${options.metro}`, `tcp:${options.metro}`]);
        if (result.status !== 0) {
            throw new Error(`adb reverse for Metro failed: ${String(result.stderr).trim()}`);
        }
        process.on('exit', () => adb(['reverse', '--remove', `tcp:${options.metro}`]));
    }

    const credentials = options.credentials ? JSON.parse(readFileSync(options.credentials, 'utf8')) : undefined;
    const refused = roomsRefusal(options.flows, credentials);
    if (refused) {
        throw new Error(refused);
    }
    const extra = credentials
        ? Object.entries(credentialEnv(credentials)).flatMap(([name, value]) => ['-e', `${name}=${value}`])
        : [];
    extra.push(...Object.entries(options.env).flatMap(([name, value]) => ['-e', `${name}=${value}`]));

    if (options.serversDown) {
        const origins = credentials.servers.map((/** @type {{ origin: string }} */ server) => server.origin);
        const answering = await answeringOrigins(origins);
        if (answering.length > 0) {
            throw new Error(
                `--servers-down: ${answering.join(', ')} still answer${answering.length === 1 ? 's' : ''}.`,
            );
        }
        if (options.platform === 'android') {
            const list = adb(['reverse', '--list']);
            if (list.status !== 0) {
                throw new Error(`--servers-down: adb reverse --list failed: ${String(list.stderr).trim()}`);
            }
            const reversed = reversedOrigins(list.stdout ?? '', origins);
            if (reversed.length > 0) {
                throw new Error(`--servers-down: adb reverse still carries ${reversed.join(', ')}.`);
            }
        }
        say(`servers down: none of ${origins.join(', ')} answers`);
    }

    let failed = 0;
    for (const flow of options.flows) {
        const name = basename(flow, '.yaml');
        const args = [
            'test',
            '--platform',
            options.platform,
            ...(options.device ? ['--device', options.device] : []),
            '--no-ansi',
            '--test-output-dir',
            join(out, 'maestro'),
            '--debug-output',
            join(out, 'maestro-debug'),
            '-e',
            `APP_ID=${options.appId}`,
            '-e',
            `APP_SCHEME=${options.scheme}`,
            '-e',
            `DEV_CLIENT_URL=${options.devClient}`,
            '-e',
            `PROXY_CONTROL=${options.proxyControl}`,
            '-e',
            `SERVERS_CONTROL=${options.serversControl}`,
            ...extra,
            flow,
        ];
        const result = spawnSync(maestro, args, { stdio: 'inherit', env: { ...process.env, ...MAESTRO_ENV } });
        say(`${name}: ${result.status === 0 ? 'passed' : `failed (${result.signal ?? result.status})`}`);
        failed ||= result.status === 0 ? 0 : 1;
        if (result.signal) {
            break;
        }

        // The app's whole container, from the host (run-as needs a debuggable build).
        let listing;
        /** @type {(number | null)[]} */
        let statuses;
        /** @type {string[]} */
        let cacheUrls = [];
        if (options.platform === 'android') {
            const found = [
                ['shell', 'run-as', options.appId, 'find', '.'],
                ['shell', 'find', `/sdcard/Android/data/${options.appId}`],
            ].map((command) => ({ command, result: adb(command) }));
            listing = found.map(
                ({ command, result }) => `# adb ${command.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
            );
            // The external folder may never have been made; the private one must list.
            statuses = [found[0].result.status];
        } else {
            const where = spawnSync(
                'xcrun',
                ['simctl', 'get_app_container', options.device ?? 'booted', options.appId, 'data'],
                {
                    encoding: 'utf8',
                },
            );
            const container = (where.stdout ?? '').trim();
            const found = container ? spawnSync('find', [container], { encoding: 'utf8' }) : where;
            listing = [`# find ${container || '(no container)'}\n${found.stdout ?? ''}${found.stderr ?? ''}`];
            statuses = container ? [where.status, found.status] : [where.status, 1];
            // The system's URL cache, which URLSession keeps per app (CB-356).
            const cacheDb = join(container, 'Library/Caches', options.appId, 'Cache.db');
            if (container && existsSync(cacheDb)) {
                const rows = spawnSync('sqlite3', [cacheDb, 'SELECT request_key FROM cfurl_cache_response'], {
                    encoding: 'utf8',
                });
                cacheUrls = (rows.stdout ?? '').split('\n').filter(Boolean);
                listing.push(`# sqlite3 ${cacheDb}\n${rows.stdout ?? ''}${rows.stderr ?? ''}`);
                statuses.push(rows.status);
            }
        }
        const file = join(out, `${name}.${options.platform}.container.txt`);
        writeFileSync(file, `${listing.join('\n')}\n`);
        say(`container listing in ${file}`);
        const left = workspaceFolders(listing.join('\n'));
        say(`${name}: ${left.length} workspace folder(s) in the container`);
        if (options.noWorkspaceLeft) {
            const origins = (credentials?.servers ?? []).map(
                (/** @type {{ origin: string }} */ server) => server.origin,
            );
            const problems = checkNoWorkspaceLeft(listing.join('\n'), statuses, workspaceCacheUrls(cacheUrls, origins));
            for (const problem of problems) {
                say(`${name}: failed, ${problem}`);
            }
            failed ||= problems.length > 0 ? 1 : 0;
        }
    }
    say(`output in ${out}`);
    return failed;
}

if (import.meta.main) {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(`[run] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
