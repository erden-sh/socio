import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { SyntaxKind } from 'typescript/ast';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/ast/is';
import { API } from 'typescript/sync';
import { expect, it } from 'vitest';

import { copilotKitOptions } from '../../packages/client/src/modules/chat/copilotkit-options';
import { PACKAGE_SOURCES } from '../support/package-sources.js';

const run = promisify(execFile);
const OPT_OUT = "import '@socio/foundation/no-vendor-telemetry';";
const optOutUrl = new URL('../../packages/foundation/src/no-vendor-telemetry.ts', import.meta.url).href;
const mainUrl = new URL('../../src/server/main.ts', import.meta.url).href;
const storeUrl = new URL('../helpers/stores.js', import.meta.url).href;
const runnerUrl = new URL('../helpers/runners.js', import.meta.url).href;
const databaseUrl = new URL('../helpers/test-database.ts', import.meta.url).href;
const workspaceUrl = new URL('../helpers/stores.js', import.meta.url).href;
const authUrl = new URL('../helpers/test-auth.ts', import.meta.url).href;
const platformUrl = new URL('../helpers/test-platform.ts', import.meta.url).href;
const tsxUrl = import.meta.resolve('tsx');

// Each probe boots the whole app runtime through tsx in a new process: about 5 s
// on an idle machine, over 15 s on a CI runner sharing 2 cores with the other
// test workers and starting with an empty tsx cache. The subprocess limit sits
// inside the test's, so a real hang reports as the subprocess's failure.
const PROBE_LIMIT = 50_000;
const PROBE_TEST = { timeout: PROBE_LIMIT + 10_000 };

// Boot the app runtime in a fresh process (the SDK telemetry singleton reads
// the environment once, at import) and record every outbound fetch. Requests
// are answered locally; nothing leaves the machine.
// 'opt-out' imports the opt-out first, as the entries do; 'main-only'
// imports the composition root (main.ts) with nothing before it and builds
// the runtime, as a throwaway script would;
// 'sdk-first' loads the SDK before any of our modules (the probe's canary).
// Each mode also builds CopilotKit's TelemetryClient itself with Segment
// sampling at 100%, captures one event and flushes Segment, so a real
// Segment client would post to api.segment.io inside the probe.
type Mode = 'opt-out' | 'main-only' | 'sdk-first';
const probe = (mode: Mode) => `
const requests = [];
globalThis.fetch = async (url) => {
  requests.push(String(url));
  return new Response('{"ok":true}', { status: 202 });
};
${mode === 'opt-out' ? `await import(${JSON.stringify(optOutUrl)});` : ''}
${mode === 'sdk-first' ? `await import('@copilotkit/runtime/v2');` : ''}
const { startAppRuntime } = await import(${JSON.stringify(mainUrl)});
const { Store } = await import(${JSON.stringify(storeUrl)});
const { WorkspaceStore } = await import(${JSON.stringify(workspaceUrl)});
const { LocalAgentRunner } = await import(${JSON.stringify(runnerUrl)});
const { testDatabase } = await import(${JSON.stringify(databaseUrl)});
const { testAuth } = await import(${JSON.stringify(authUrl)});
const { TestPlatform } = await import(${JSON.stringify(platformUrl)});
const store = new Store(testDatabase());
const workspace = new WorkspaceStore(testDatabase());
let runtime;
try {
  const app = await startAppRuntime({
    db: workspace.db, store, workspace,
    config: { baseUrl: '', runtimeUrl: '', voiceName: 'marin' },
    runner: new LocalAgentRunner(testDatabase()), auth: testAuth(),
  });
  runtime = app.runtime;
  // The tests' view of the services it built (start, handle, stop).
  const platform = new TestPlatform(app.services);
  await platform.start();
  await platform.handle(new Request('http://localhost/api/copilotkit/info'), 'fixture-owner');
  const dot = workspace.dots()[0];
  workspace.bindThread('fixture-thread', dot.id, 'Fixture', 'fixture-owner');
  // Reach the SDK request handler, then fail body validation before any agent run.
  const response = await platform.handle(new Request(
    'http://localhost/api/copilotkit/agent/' + dot.id + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'fixture-thread', messages: 'invalid' }),
    },
  ), 'fixture-owner');
  if (response.status !== 400) throw new Error('Expected SDK body validation failure');
  await new Promise(resolve => setTimeout(resolve, 50));
  await platform.stop();
  const { TelemetryClient } = await import('@copilotkit/shared/telemetry');
  const client = new TelemetryClient({
    packageName: 'telemetry-probe', packageVersion: '0.0.0', sampleRate: 1,
  });
  await client.capture('oss.runtime.instance_created', { probe: true });
  await client.segment?.closeAndFlush({ timeout: 1000 });
  console.log(JSON.stringify(requests));
} finally {
  await runtime?.dispose();
  store.close();
  workspace.close();
}
`;

async function outboundRequests(mode: Mode) {
    const env = { ...process.env };
    for (const key of [
        'DO_NOT_TRACK',
        'COPILOTKIT_TELEMETRY_DISABLED',
        'COPILOTKIT_TELEMETRY_SAMPLE_RATE',
        'COPILOTKIT_LICENSE_TOKEN',
        'COPILOTKIT_TELEMETRY_URL',
        'CPK_TELEMETRY_ID',
    ]) {
        delete env[key];
    }
    const { stdout } = await run(process.execPath, ['--import', tsxUrl, '--input-type=module', '--eval', probe(mode)], {
        env,
        timeout: PROBE_LIMIT,
    });
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '[]') as string[];
}

// The canary: without the opt-out, CopilotKit still posts straight to its
// ingest endpoint with fetch, so the probe must see that. Segment is the
// vendor/ stand-in now and must send nothing. Before the stand-in
// (2026-10-11), the same probe also saw https://api.segment.io/v1/batch.
it('the probe detects SDK telemetry when the SDK loads before the opt-out', PROBE_TEST, async () => {
    const requests = await outboundRequests('sdk-first');
    expect(requests).toContain('https://telemetry.copilotkit.ai/ingest');
    expect(requests.filter((url) => /segment\.(io|com)/.test(url))).toEqual([]);
});

it('sends no outbound requests with the opt-out module and no opt-out environment', PROBE_TEST, async () => {
    expect(await outboundRequests('opt-out')).toEqual([]);
});

// 2026-10-10: two throwaway bench scripts built a Platform without the
// opt-out and CopilotKit logged "telemetry enabled". Every module that loads
// a CopilotKit package now imports the opt-out itself.
it('sends no outbound requests when a script imports only main.ts and builds the runtime', PROBE_TEST, async () => {
    expect(await outboundRequests('main-only')).toEqual([]);
});

/**
 * Whether a module loads a CopilotKit package at run time: an `import` or an
 * `export ... from` naming `@copilotkit/...` that TypeScript keeps. Read with
 * TypeScript's parser, as the feature guard reads imports
 * (scripts/check-feature-boundaries.mjs), so the form of the statement (one
 * line or several) doesn't matter. `import type` and `export type ... from`
 * are erased and load nothing. `import { type X }` isn't: the declaration
 * stays (with verbatimModuleSyntax, as `import {}`), so it counts, as the
 * guard counts it.
 */
function loadsCopilotKit(api: API, path: string, source: string) {
    const lease = api.createSourceFile(path, source);
    try {
        return lease.sourceFile.statements.some((node) => {
            const declaration = isImportDeclaration(node)
                ? {
                      specifier: node.moduleSpecifier,
                      typeOnly: node.importClause?.phaseModifier === SyntaxKind.TypeKeyword,
                  }
                : isExportDeclaration(node)
                  ? { specifier: node.moduleSpecifier, typeOnly: node.isTypeOnly }
                  : undefined;
            const specifier = declaration?.specifier;
            return (
                !!declaration &&
                !declaration.typeOnly &&
                !!specifier &&
                isStringLiteral(specifier) &&
                specifier.text.startsWith('@copilotkit/')
            );
        });
    } finally {
        lease.dispose();
    }
}

it('tells a CopilotKit import that loads the SDK from one TypeScript erases', () => {
    const api = new API({ cwd: new URL('../../', import.meta.url).pathname });
    try {
        const loads = (source: string) => loadsCopilotKit(api, '/planted.ts', source);
        // Erased: type-only, on one line or several, imported or re-exported.
        expect(loads("import type { AgentRunner } from '@copilotkit/runtime/v2';\n")).toBe(false);
        expect(
            loads("import type {\n    AgentRunner,\n    AgentRunnerRunRequest,\n} from '@copilotkit/runtime/v2';\n"),
        ).toBe(false);
        expect(loads("export type {\n    AgentRunner,\n} from '@copilotkit/runtime/v2';\n")).toBe(false);
        // Kept: a value import or re-export, on one line or several, a bare
        // import, and `import { type X }`, whose declaration stays.
        expect(loads("import { AgentRunner } from '@copilotkit/runtime/v2';\n")).toBe(true);
        expect(
            loads("import {\n    AgentRunner,\n    type AgentRunnerRunRequest,\n} from '@copilotkit/runtime/v2';\n"),
        ).toBe(true);
        expect(loads("export {\n    AgentRunner,\n} from '@copilotkit/runtime/v2';\n")).toBe(true);
        expect(loads("import '@copilotkit/runtime/v2';\n")).toBe(true);
        expect(loads("import { type AgentRunner } from '@copilotkit/runtime/v2';\n")).toBe(true);
        expect(loads("import type { Message } from '@ag-ui/client';\nimport { z } from 'zod';\n")).toBe(false);
    } finally {
        api.close();
    }
});

it('every module that loads a CopilotKit package imports the opt-out first', async () => {
    const { readdir } = await import('node:fs/promises');
    const roots = [
        new URL('../../src/', import.meta.url),
        ...PACKAGE_SOURCES.map((dir) => new URL(`../../${dir}/`, import.meta.url)),
    ];
    const files = (
        await Promise.all(
            roots.map(async (root) =>
                (await readdir(root, { recursive: true }))
                    .filter((file) => /\.tsx?$/.test(file))
                    .map((file) => new URL(file, root)),
            ),
        )
    ).flat();
    const missing: URL[] = [];
    const api = new API({ cwd: new URL('../../', import.meta.url).pathname });
    try {
        for (const file of files) {
            const source = await readFile(file, 'utf8');
            // A module that never names a CopilotKit package can't import
            // one: only the rest go to the parser (one round trip to
            // TypeScript each, thousands of files, slow on a busy host).
            if (!source.includes('@copilotkit/') || !loadsCopilotKit(api, file.pathname, source)) {
                continue;
            }
            const first = source.match(/^import .+$/m)?.[0] ?? '';
            if (first !== OPT_OUT) {
                missing.push(file);
            }
        }
    } finally {
        api.close();
    }
    expect(missing).toEqual([]);
});

it('loads the opt-out before any other server module', async () => {
    const entry = await readFile(new URL('../../src/server/index.ts', import.meta.url), 'utf8');
    const firstImport = entry.match(/^import .+$/m)?.[0];
    expect(firstImport).toBe(OPT_OUT);
});

it('pins the opt-out in the container images and compose file', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    // The app, browser, apps runtime, and social-strategy plugin images.
    expect(
        dockerfile.match(/DO_NOT_TRACK=1 COPILOTKIT_TELEMETRY_DISABLED=true COPILOTKIT_TELEMETRY_SAMPLE_RATE=0/g),
    ).toHaveLength(4);
    const compose = await readFile(new URL('../../.docker/compose.yml', import.meta.url), 'utf8');
    expect(compose).toContain("DO_NOT_TRACK: '1'");
    expect(compose).toContain("COPILOTKIT_TELEMETRY_DISABLED: 'true'");
    expect(compose).not.toContain('CPK_TELEMETRY_ID');
});

// CopilotKit depends on Scarf, whose postinstall reports each install to
// scarf.sh (platform, Node version, package names) unless the root package
// opts out. Found and turned off on 2026-10-11.
it('opts out of install-time analytics in package.json and the build stage', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
        scarfSettings?: { enabled?: boolean };
    };
    expect(pkg.scarfSettings?.enabled).toBe(false);
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const build = dockerfile.split(/^FROM /m)[1] ?? '';
    expect(build).toMatch(/SCARF_ANALYTICS=false/);
    expect(build).toMatch(/DO_NOT_TRACK=1/);
});

// 2026-10-11: CopilotKit's two senders are replaced with do-nothing packages
// from vendor/ (pnpm overrides, CB-183), so the real ones are never installed.
const senders = ['@scarf/scarf', '@segment/analytics-node'] as const;

it('installs the vendor/ stand-ins instead of Scarf and Segment', async () => {
    const { createRequire } = await import('node:module');
    const { realpath } = await import('node:fs/promises');
    // Resolve each sender from every CopilotKit package that depends on it.
    // The link may point into another checkout's vendor/ (a worktree's
    // node_modules may come from elsewhere), so match the stand-in's path.
    for (const dependent of ['@copilotkit/shared', '@copilotkit/runtime', '@copilotkit/react-core']) {
        const from = createRequire(createRequire(import.meta.url).resolve(`${dependent}/package.json`));
        for (const name of senders) {
            const manifest = await realpath(from.resolve(`${name}/package.json`));
            expect(manifest).toMatch(
                name === '@scarf/scarf'
                    ? /\/vendor\/noop-scarf\/package\.json$/
                    : /\/vendor\/noop-segment\/package\.json$/,
            );
            const pkg = JSON.parse(await readFile(manifest, 'utf8')) as {
                name: string;
                socioNoop?: boolean;
                scripts?: unknown;
            };
            expect(pkg).toMatchObject({ name, socioNoop: true });
            expect(pkg.scripts).toBeUndefined();
        }
    }
    // The lockfile: every mention of either is the link to vendor/, and
    // neither is a package fetched from the registry.
    const lock = await readFile(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8');
    const mentions = lock.split('\n').filter((line) => /@(scarf\/scarf|segment\/analytics-node)\b/.test(line));
    expect(mentions.length).toBeGreaterThan(4);
    for (const line of mentions) {
        expect(line).toMatch(
            /^\s+'@scarf\/scarf': link:vendor\/noop-scarf$|^\s+'@segment\/analytics-node': link:vendor\/noop-segment$|^\s+'@(scarf\/scarf|segment\/analytics-node)':$|^\s+(specifier|version): link:vendor\/noop-(scarf|segment)$/,
        );
    }
    expect(lock).not.toMatch(/^ {2}'@(scarf|segment)\/[^']*@/m);
});

it('the Segment stand-in has the API CopilotKit calls and sends nothing', async () => {
    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(null, { status: 202 });
    }) as typeof fetch;
    try {
        const { Analytics } = await import('@segment/analytics-node');
        const segment = new Analytics({ writeKey: 'probe' });
        let called = 0;
        for (const method of ['alias', 'group', 'identify', 'page', 'screen', 'track'] as const) {
            segment[method]({ userId: 'probe', event: 'probe' }, () => called++);
        }
        await segment.flush();
        await segment.closeAndFlush({ timeout: 10 });
        await segment.register();
        await segment.deregister('probe');
        await segment.ready;
        expect(called).toBe(6);
        expect(requests).toEqual([]);
    } finally {
        globalThis.fetch = realFetch;
    }
});

it('copies vendor/ (and patches/) into every image stage that installs or copies node_modules', async () => {
    const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const installs = stages.filter((stage) => /pnpm install/.test(stage));
    // build, and prod-deps, whose node_modules the app, browser and
    // apps-runtime copy (CB-183).
    expect(installs.map((stage) => stage.split('\n')[0])).toEqual([
        expect.stringMatching(/^node:\S+ AS build$/),
        expect.stringMatching(/^node:\S+ AS prod-deps$/),
    ]);
    for (const stage of installs) {
        const vendor = stage.indexOf('COPY vendor ./vendor');
        expect(vendor).toBeGreaterThan(-1);
        expect(vendor).toBeLessThan(stage.indexOf('pnpm install'));
        expect(stage).toContain('pnpm install --frozen-lockfile');
    }
    // pnpm reads every file patchedDependencies (pnpm-workspace.yaml) lists on each install,
    // so each stage that installs from the root's manifest copies patches/,
    // the coding image's included.
    const coding = await readFile(new URL('../../deployment/coding/coding.Dockerfile', import.meta.url), 'utf8');
    const codingInstalls = coding
        .split(/^FROM /m)
        .slice(1)
        .filter((stage) => /pnpm install --frozen-lockfile/.test(stage));
    expect(codingInstalls).toHaveLength(2);
    for (const stage of [...installs, ...codingInstalls]) {
        const patches = stage.indexOf('COPY patches ./patches');
        expect(patches).toBeGreaterThan(-1);
        expect(patches).toBeLessThan(stage.indexOf('pnpm install'));
    }
    const copies = stages.filter((stage) => stage.includes('/app/node_modules ./node_modules'));
    // app, browser, apps-runtime.
    expect(copies).toHaveLength(3);
    for (const stage of copies) {
        expect(stage).toMatch(/^COPY (--from=build \/app\/)?vendor \.\/vendor$/m);
        expect(stage).toContain('node vendor/check-stubs.cjs');
    }
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
        scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toBe('node vendor/check-stubs.cjs');
});

// CopilotKit's web inspector posts to the ingest endpoint from the browser.
// packages/client/tests/copilotkit-inspector.test.tsx mounts the provider in each build
// mode; these check that the app wires it the same way everywhere.
it('passes the shared options to every CopilotKit provider in the app', async () => {
    const { readdir } = await import('node:fs/promises');
    const root = new URL('../../packages/client/src/', import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((file) => /\.tsx?$/.test(file));
    let providers = 0;
    for (const file of files) {
        const source = await readFile(new URL(file, root), 'utf8');
        // The v1 provider (`<CopilotKit>`, with its dev console) lives in the
        // package root; the app uses only the v2 entry.
        expect(source, file).not.toMatch(/from '@copilotkit\/react-core'/);
        expect(source, file).not.toMatch(/['"]@copilotkit\/web-inspector['"]/);
        expect(source, file).not.toMatch(/\b(showDevConsole|publicApiKey)\b/);
        expect(source, file).not.toMatch(/\bpublicLicenseKey\b/);
        for (const tag of source.match(/<CopilotKit(Provider)?\b[^>]*>/g) ?? []) {
            providers++;
            expect(tag, file).toMatch(/\{\.\.\.copilotKitOptions\}/);
            expect(tag, file).not.toMatch(/enableInspector|runtimeUrl/);
        }
    }
    expect(providers).toBeGreaterThan(0);
    expect(copilotKitOptions.enableInspector).toBe(false);
});

// The stub keeps the inspector out of every build: production, development
// and the dev server's pre-bundled dependencies all resolve through it.
it('aliases the inspector package to the stub in the build config', async () => {
    const { fileURLToPath } = await import('node:url');
    const { default: config } = await import('../../vite.config');
    expect(config.resolve?.alias).toMatchObject({
        '@copilotkit/web-inspector': fileURLToPath(
            new URL('../../packages/client/src/no-web-inspector.ts', import.meta.url),
        ),
    });
    await expect(import('@copilotkit/web-inspector')).rejects.toThrow('not part of Socio');
});
