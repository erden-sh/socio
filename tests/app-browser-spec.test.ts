import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
    APP_BROWSER_CMD,
    APP_BROWSER_UID_BASE,
    APP_BROWSER_USERS,
    SECCOMP_DENIED,
    appBrowserComposeAppEnvironment,
    appBrowserComposeNetwork,
    appBrowserComposeService,
    appBrowserOverlay,
    chromiumSeccompProfile,
} from '../src/app-browser/deploy-spec.js';
import {
    CHROMIUM_ARGS,
    DEAD_PROXY,
    FORBIDDEN_ARGS,
    chromiumLaunchOptions,
    contextOptions,
} from '../src/app-browser/launch.js';
import { appsInternalConfigFromEnv, sourceAllowed } from '../src/server/apps/internal-listener.js';

// CB-232: the app browser's image, stack and sandbox specs, as
// generated (src/app-browser/deploy-spec.ts, launch.ts) and, for compose,
// the seccomp profile and the Dockerfile, as checked in.
// Nothing here runs a container.

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
// Compose reads 0400 as octal, as YAML 1.1 does.
const yaml = (path: string, version: '1.1' | '1.2' = '1.1') =>
    // oxlint-disable-next-line typescript/no-explicit-any -- parsed YAML
    parse(read(path), { version }) as Record<string, any>;
// `${NAME:-default}` as Compose and Swarm resolve it with NAME unset.
const unset = (value: string) => value.replace(/\$\{\w+:-([^}]*)\}/g, (_match, fallback: string) => fallback);
const cidr = (subnet: string) => {
    const [base, bits] = subnet.split('/');
    const value = base.split('.').reduce((sum, part) => ((sum << 8) | Number(part)) >>> 0, 0);
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return { start: (value & mask) >>> 0, end: ((value & mask) | ~mask) >>> 0 };
};
const overlaps = (a: string, b: string) => {
    const [x, y] = [cidr(a), cidr(b)];
    return x.start <= y.end && y.start <= x.end;
};

describe('Chromium’s launch', () => {
    it('runs with its sandbox on and nothing that turns a protection off', () => {
        const options = chromiumLaunchOptions('/tmp/ctx');
        expect(options.chromiumSandbox).toBe(true);
        expect(options.headless).toBe(true);
        for (const arg of options.args ?? []) {
            for (const forbidden of FORBIDDEN_ARGS) {
                expect(arg).not.toMatch(forbidden);
            }
        }
        expect(options.ignoreDefaultArgs).toBeUndefined();
        expect(options.executablePath).toBeUndefined();
        // Only these reach Chromium's environment.
        expect(Object.keys(options.env ?? {}).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']);
        expect(options.env).toMatchObject({ HOME: '/tmp/ctx', TMPDIR: '/tmp/ctx' });
    });

    it('resolves no name and proxies every connection it makes itself to nowhere, loopback included', () => {
        expect(CHROMIUM_ARGS).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
        expect(CHROMIUM_ARGS).toContain(`--proxy-server=${DEAD_PROXY}`);
        expect(CHROMIUM_ARGS).toContain('--proxy-bypass-list=<-loopback>');
        expect(CHROMIUM_ARGS).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
        expect(CHROMIUM_ARGS.some((arg) => arg.startsWith('--js-flags=--max-old-space-size='))).toBe(true);
    });

    it('gives pages JavaScript but no service workers, downloads, permissions or relaxed security', () => {
        expect(contextOptions()).toEqual({
            javaScriptEnabled: true,
            serviceWorkers: 'block',
            acceptDownloads: false,
            permissions: [],
            bypassCSP: false,
            ignoreHTTPSErrors: false,
            viewport: { width: 1280, height: 800 },
        });
    });

    it('never asks for an unsandboxed Chromium anywhere in the service', () => {
        const dir = new URL('../src/app-browser/', import.meta.url);
        for (const name of readdirSync(dir)) {
            const text = readFileSync(new URL(name, dir), 'utf8');
            expect(text).not.toMatch(/chromiumSandbox:\s*false/);
            const lines = text
                .split('\n')
                .filter((line) => line.includes('--no-sandbox'))
                .filter((line) => !/^\s*(\/\^--no-sandbox\$\/,|\*|\/\/)/.test(line));
            expect(lines).toEqual([]);
        }
    });
});

describe('the swarm overlay spec (not deployed)', () => {
    const overlay = appBrowserOverlay();

    it('puts the service on one internal network shared with the app alone, with no ports or volumes', () => {
        const service = overlay.services['app-browser'];
        expect(Object.keys(service.networks)).toEqual(['app_browser']);
        expect(overlay.networks.app_browser).toEqual({
            driver: 'overlay',
            internal: true,
            attachable: false,
            ipam: { config: [{ subnet: '${APP_BROWSER_SUBNET:-10.212.0.0/24}' }] },
        });
        expect(service).not.toHaveProperty('ports');
        expect(service).not.toHaveProperty('volumes');
        expect(Object.keys(overlay.services)).toEqual(['app', 'app-browser']);
        expect(overlay.services.app.networks).toEqual({
            app_browser: { aliases: ['company-brain-apps-internal'] },
        });
        // The upstream is the app on that network, never a public name.
        expect(service.environment.APP_BROWSER_UPSTREAM).toBe('http://company-brain-apps-internal:4312');
    });

    it('gives app_browser a fixed private subnet, and the app’s internal listener that subnet alone', () => {
        const subnet = overlay.networks.app_browser.ipam.config[0].subnet;
        const app = overlay.services.app.environment;
        // One value, overridable as one: the listener's subnet is the network's.
        expect(app.APPS_INTERNAL_SUBNET).toBe(subnet);
        expect(app.APPS_INTERNAL_PORT).toBe(
            new URL(overlay.services['app-browser'].environment.APP_BROWSER_UPSTREAM).port,
        );
        const config = appsInternalConfigFromEnv(
            Object.fromEntries(Object.entries(app).map(([key, value]) => [key, unset(String(value))])),
        );
        expect(config).toEqual({
            port: 4312,
            host: '0.0.0.0',
            subnets: ['10.212.0.0/24'],
        });
        // Other networks the app is on, a coding sandbox, the host: refused.
        for (const outside of [
            '10.0.1.5',
            '10.212.1.5',
            '10.213.0.18',
            '172.18.0.2',
            '192.168.1.10',
            '127.0.0.1',
            '::1',
            'fd00::1',
        ]) {
            expect(sourceAllowed(outside, config!.subnets)).toBe(false);
        }
        expect(sourceAllowed('10.212.0.9', config!.subnets)).toBe(true);
        expect(sourceAllowed('::ffff:10.212.0.9', config!.subnets)).toBe(true);
        // Clear of the ranges the repository already uses: the coding
        // sandboxes', the local compose network's, the swarm's first overlays
        // and Docker's bridge pools.
        const sandboxes = yaml('.docker/compose.computers.yml').services['computer-supervisor'].environment
            .CODING_SANDBOX_SUBNETS as string;
        for (const used of [
            unset(sandboxes),
            unset(appBrowserComposeNetwork().ipam.config[0].subnet),
            '10.0.0.0/16',
            '172.16.0.0/12',
            '192.168.0.0/16',
        ]) {
            expect(overlaps(unset(subnet), used)).toBe(false);
        }
    });

    it('drops every capability but those to run workers as their users, with its own secret and seccomp profile', () => {
        const service = overlay.services['app-browser'];
        expect(service.cap_drop).toEqual(['ALL']);
        expect(service.cap_add).toEqual(['SETUID', 'SETGID', 'KILL']);
        expect(service.read_only).toBe(true);
        expect(service.security_opt).toEqual([
            'no-new-privileges:true',
            expect.stringMatching(/^seccomp=\$\{APP_BROWSER_SECCOMP_PROFILE:\?/),
        ]);
        expect(service.environment.APP_BROWSER_UID_BASE).toBe(String(APP_BROWSER_UID_BASE));
        expect(service.environment.NODE_ENV).toBe('production');
        expect(service.secrets).toEqual([
            {
                source: 'company_brain_app_browser_secret',
                target: 'company_brain_app_browser_secret',
                uid: '1000',
                gid: '1000',
                mode: 0o400,
            },
        ]);
        // Its own secret: never the socio browser's.
        expect(JSON.stringify(overlay)).not.toContain('BROWSER_SECRET:');
        expect(JSON.stringify(overlay)).not.toMatch(/browser_secret[^"]*"[^"]*BROWSER_SECRET\b/);
    });
});

describe('the local compose service', () => {
    const compose = yaml('.docker/compose.yml', '1.2');

    it('is exactly the generated spec, behind its own profile', () => {
        expect(compose.services['app-browser']).toEqual(appBrowserComposeService());
    });

    it('reaches the app alone, on an internal network, and never the browser’s egress', () => {
        expect(compose.networks['app-browser-link']).toEqual(appBrowserComposeNetwork());
        expect(compose.networks['app-browser-link'].internal).toBe(true);
        expect(compose.services['app-browser'].networks).toEqual(['app-browser-link']);
        expect(compose.services.app.networks).toContain('app-browser-link');
        expect(compose.services.app.environment.APP_BROWSER_URL).toBe('${APP_BROWSER_URL:-}');
    });

    it('gives the app’s internal listener the network’s subnet alone', () => {
        const subnet = compose.networks['app-browser-link'].ipam.config[0].subnet;
        expect(compose.services.app.environment).toMatchObject(appBrowserComposeAppEnvironment());
        expect(compose.services.app.environment.APPS_INTERNAL_SUBNET).toBe(subnet);
        expect(compose.services.app.environment.APPS_INTERNAL_PORT).toBe(
            new URL(compose.services['app-browser'].environment.APP_BROWSER_UPSTREAM).port,
        );
        expect(unset(subnet)).toBe('10.212.1.0/24');
    });
});

describe('the seccomp profile', () => {
    const profile = JSON.parse(read('deployment/app-browser/seccomp.json'));

    it('is exactly the generated one', () => {
        expect(profile).toEqual(chromiumSeccompProfile());
    });

    it('lets Chromium make its sandbox’s namespaces and refuses the kernel surface around it', () => {
        const denied = new Set<string>(profile.syscalls.flatMap((rule: { names: string[] }) => rule.names));
        for (const needed of ['clone', 'clone3', 'unshare', 'chroot', 'seccomp', 'prctl', 'setresuid']) {
            expect(denied.has(needed)).toBe(false);
        }
        for (const refused of [
            'keyctl',
            'bpf',
            'userfaultfd',
            'perf_event_open',
            'io_uring_setup',
            'ptrace',
            'mount',
            'kexec_load',
            'init_module',
            'open_by_handle_at',
        ]) {
            expect(denied.has(refused)).toBe(true);
        }
        expect(profile.syscalls.every((rule: { action: string }) => rule.action === 'SCMP_ACT_ERRNO')).toBe(true);
        expect(new Set(SECCOMP_DENIED).size).toBe(SECCOMP_DENIED.length);
    });
});

describe('the image stage', () => {
    const dockerfile = read('Dockerfile');
    const stage = dockerfile.split(/^FROM /m).find((text) => text.startsWith('chromium AS app-browser'))!;

    it('builds on the chromium stage (its Node pin and Chromium) and runs the router as node with three capabilities', () => {
        expect(stage).toBeTruthy();
        const cmd = /^CMD (\[[\s\S]*?\])$/m.exec(stage.replace(/\\\n\s*/g, ''))?.[1];
        expect(JSON.parse(cmd!)).toEqual(APP_BROWSER_CMD);
        expect(stage).toMatch(/^ENV APP_BROWSER_HOST=0\.0\.0\.0 APP_BROWSER_PORT=4360 APP_BROWSER_UID_BASE=21000$/m);
        expect(stage).toContain('EXPOSE 4360');
        expect(stage).not.toMatch(/--no-sandbox|SYS_ADMIN|privileged/);
    });

    it('creates a user for every worker slot and the self-test’s', () => {
        expect(stage).toContain(`$(seq 0 ${APP_BROWSER_USERS - 1})`);
        expect(stage).toContain('--uid $((21000 + slot))');
        expect(stage).toContain('--shell /usr/sbin/nologin');
    });
});
