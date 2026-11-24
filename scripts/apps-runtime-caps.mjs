// The apps runtime's start path as production runs it (CB-148): run inside
// the apps runtime image by scripts/apps-runtime-caps.sh, as node (uid
// 1000) with only CHOWN, KILL, SETGID and SETUID, umask 007, a uid per app.
// It deploys versions, starts one with a data token, checks it answers 200
// on its socket and reads its token, replaces the token, then stops it and
// rolls back to an older version that has to be deployed again while
// nothing runs. Exits 1 on the first step that fails.
//
// Without SRC it uses tiny Bun apps (Bun.serve on CB_SOCKET). With SRC (a
// directory of v<N>/ sources) and MANIFESTS (a JSON file of manifests by
// version) it uses those; VERSIONS is the deploy order, START the version
// started first, ROLLBACK the one rolled back to, PATHS the paths to GET.
//
// Then two tiny apps run side by side, and one replaces its socket with a
// link to the other's: the ingress must not follow it (SWAP_ONLY=1 runs
// just that, without data tokens, so it runs on older builds too).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';

const dist = process.env.DIST || '/app/dist/server';
const { AppsSupervisor } = await import(`${dist}/apps-runtime/supervisor.js`);
const { runtimeConfigFromEnv } = await import(`${dist}/apps-runtime/config.js`);
const { encodeBundle } = await import(`${dist}/node_modules/@socio/foundation/dist/apps/bundle.js`);
const { ingressServer } = await import(`${dist}/apps-runtime/ingress.js`);
const { ingressKey } = await import(`${dist}/apps-runtime/keys.js`);

process.umask(0o007); // as src/apps-runtime/index.ts
const TOKEN = 'caps-check-token-0123456789abcdef';
const config = runtimeConfigFromEnv({
    APPS_RUNTIME_TOKEN: TOKEN,
    ...process.env,
});
// A proxy that takes connections and nothing else, for installs that copy.
if (process.env.STAND_IN_PROXY === '1') {
    await new Promise((resolve) =>
        createServer((socket) => socket.destroy()).listen(
            Number(new URL(config.egressProxy).port),
            '127.0.0.1',
            resolve,
        ),
    );
}
const supervisor = new AppsSupervisor(config, (line) => console.log(line));
supervisor.init();
const id = process.env.APP_ID || 'caps--dot-ab12cd';
console.log(
    `uid ${process.getuid()} gid ${process.getgid()} umask ${process.umask().toString(8)}; command ${config.command.join(' ')}; apps from uid ${config.isolate?.uidBase ?? 'none'}`,
);

const src = process.env.SRC;
const manifests = src ? JSON.parse(readFileSync(process.env.MANIFESTS, 'utf8')) : {};
const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
const tiny = (version) =>
    `import { symlinkSync, unlinkSync } from 'node:fs';
Bun.serve({ unix: process.env.CB_SOCKET, fetch: async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/token') return new Response(await Bun.file(process.env.CB_DATA_TOKEN_FILE).text());
  if (url.pathname === '/swap') { unlinkSync(process.env.CB_SOCKET); symlinkSync(url.searchParams.get('to'), process.env.CB_SOCKET); return Response.json({ swapped: true }); }
  return Response.json({ app: process.env.CB_APP_ID, version: ${version}, bun: Bun.version });
} });`;
const bundleOf = (version, tinyOnly = false) => {
    if (!src || tinyOnly) {
        return encodeBundle({
            manifest: {
                name: 'Caps',
                description: '',
                entry: 'server.ts',
                runtime: 'bun',
                datasets: [],
                egress: [],
            },
            files: [{ path: 'server.ts', data: Buffer.from(tiny(version)) }],
        });
    }
    const root = join(src, `v${version}`);
    return encodeBundle({
        manifest: manifests[version],
        files: walk(root).map((path) => ({
            path: relative(root, path),
            data: readFileSync(path),
        })),
    });
};
const get = (path, app = id) =>
    new Promise((resolve) => {
        const req = request(
            {
                socketPath: supervisor.socketPath(app),
                path,
                timeout: 5000,
                // Its own connection: the old ingress shares this process's agent.
                agent: false,
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ status: res.statusCode, body }));
            },
        );
        req.on('error', (error) => resolve({ status: 0, body: error.message }));
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
    });
const describe = (error) => `${error?.code ?? error?.name ?? 'Error'}: ${error?.message}`;
const fail = async (step, error) => {
    console.log(`FAIL ${step}: ${describe(error)}`);
    console.log(supervisor.logs(id, 40).join('\n'));
    await supervisor.stopAll();
    process.exit(1);
};
const deploy = async (version) => {
    const packed = bundleOf(version);
    try {
        await supervisor.deploy(id, version, packed.bytes, packed.sha256);
    } catch (error) {
        await fail(`deploy v${version}`, error);
    }
    console.log(`deployed v${version}; versions here: ${supervisor.status(id).versions.join(', ')}`);
};
const startRequest = (version, token) => ({
    version,
    token,
    dataUrl: 'http://app:4310/api/data',
    appUrl: `http://${id}.apps.localhost:4310`,
    env: {},
});
const startAndCheck = async (version, token) => {
    try {
        const status = await supervisor.start(id, startRequest(version, token));
        console.log(`started v${version}: ${JSON.stringify(status)}`);
    } catch (error) {
        await fail(`start v${version}`, error);
    }
    for (const path of (process.env.PATHS || '/').split(',')) {
        const { status, body } = await get(path);
        console.log(`GET ${path} -> ${status} ${body.slice(0, 80)}`);
        if (status !== 200) {
            await fail(`GET ${path}`, new Error(String(status)));
        }
    }
};
const tokenFile = (path) => {
    const stat = statSync(path);
    return `${stat.uid}:${stat.gid} ${(stat.mode & 0o7777).toString(8)}`;
};

async function rollout() {
    const versions = (process.env.VERSIONS || '1,2,3').split(',').map(Number);
    const first = Number(process.env.START || versions.at(-1));
    const back = Number(process.env.ROLLBACK || versions[0]);
    for (const version of versions) {
        await deploy(version);
    }
    await startAndCheck(first, 'cbdt_caps-token-1');
    const file = join(config.dir, id, 'run', 'data-token');
    console.log(`data token file: ${tokenFile(file)}`);
    if (!src) {
        const { body } = await get('/token');
        if (body.trim() !== 'cbdt_caps-token-1') {
            await fail('the app reads its token', new Error(body));
        }
        console.log('the app reads its token file');
    }
    try {
        supervisor.setToken(id, 'cbdt_caps-token-2');
    } catch (error) {
        await fail('replace the token', error);
    }
    console.log(`token replaced; file: ${tokenFile(file)}`);
    // Nothing runs while the older version is deployed again (as when no
    // version could start): it must stay deployed.
    await supervisor.stop(id);
    if (!supervisor.status(id).versions.includes(back)) {
        await deploy(back);
    }
    await startAndCheck(back, 'cbdt_caps-token-3');
    console.log(`rolled back to v${back}: ${JSON.stringify(supervisor.status(id))}`);
    await supervisor.stop(id);
}

// One app links its socket's name to another's: requests for it must not
// reach the other app.
async function swap() {
    const ingress = ingressServer(supervisor, TOKEN);
    await new Promise((resolve) => ingress.listen(0, '127.0.0.1', resolve));
    const via = (app) =>
        new Promise((resolve) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port: ingress.address().port,
                    path: '/',
                    headers: {
                        'x-cb-runtime-app': app,
                        'x-cb-runtime-key': ingressKey(TOKEN),
                    },
                    timeout: 5000,
                },
                (res) => {
                    let body = '';
                    res.on('data', (chunk) => (body += chunk));
                    res.on('end', () => resolve(`${res.statusCode} ${body.slice(0, 80)}`));
                },
            );
            req.on('error', (error) => resolve(`error ${error.message}`));
            req.end();
        });
    const [a, b] = ['swap-a--dot-ab12cd', 'swap-b--dot-ab12cd'];
    for (const app of [a, b]) {
        const packed = bundleOf(1, true);
        await supervisor.deploy(app, 1, packed.bytes, packed.sha256);
        await supervisor.start(app, { ...startRequest(1, null), dataUrl: null });
    }
    // A directly, not through the ingress: a kept-alive connection there
    // would hide what a new one does.
    const direct = await get('/', a);
    console.log(`${a} on its socket -> ${direct.status} ${direct.body}`);
    console.log(`ingress ${b} -> ${await via(b)}`);
    const swapped = await get(`/swap?to=${encodeURIComponent(supervisor.socketPath(b))}`, a);
    console.log(`${a} links its socket to ${b}'s: ${swapped.status} ${swapped.body}`);
    const after = await via(a);
    console.log(`ingress ${a} after the swap -> ${after}`);
    console.log(`ingress ${b} after the swap -> ${await via(b)}`);
    ingress.close();
    if (after.includes(b)) {
        await fail('the swap', new Error(`reached ${b}`));
    }
    console.log('the ingress refused the link');
}

if (process.env.SWAP_ONLY !== '1') {
    await rollout();
}
await swap();
await supervisor.stopAll();
console.log('OK');
process.exit(0);
