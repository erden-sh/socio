// wrangler.toml and the Worker's source: every log, trace and metric off in every environment, no
// storage (the Worker keeps nothing), and nothing that names the account. The deploy pipeline passes
// the account when it deploys; nothing here may name the account or hold a key. The staging
// and production environments each serve exactly one link host, and that host serves only its own
// builds: development on staging, production and preview on production.

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LINK_HOST, LINK_STAGING_HOST } from '@socio/shared/device-sign-in';

import { HOST_VARIANTS } from '../src/apps';

const read = (path: string) => readFileSync(new URL(path, import.meta.url).pathname, 'utf8');
const text = read('../wrangler.toml');
/** The settings alone, without the comments. */
const settings = text.replace(/^\s*#.*$/gm, '');

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.DO_NOT_TRACK = '1';
// Wrangler's own reader, offline: it parses the file and nothing else.
const { experimental_readRawConfig: readRawConfig } = await import('wrangler');
const config = readRawConfig({ config: new URL('../wrangler.toml', import.meta.url).pathname }).rawConfig as Record<
    string,
    unknown
> & { env?: Record<string, Record<string, unknown>> };

/** The top level and each environment, by name. */
const environments = (): [string, Record<string, unknown>][] => [
    ['top level', config],
    ...Object.entries(config.env ?? {}).map(([name, env]): [string, Record<string, unknown>] => [name, env]),
];

describe('wrangler.toml', () => {
    it('is the local top level, running src/index.ts', () => {
        expect(config.name).toBe('socio-link-local');
        expect(config.main).toBe('src/index.ts');
        expect(config).not.toHaveProperty('compatibility_flags');
        expect(config.send_metrics).toBe(false);
        expect(config.dependencies_instrumentation).toEqual({ enabled: false });
    });

    it('has a staging and a production environment, each on its one link host as a custom domain', () => {
        const envs = config.env ?? {};
        expect(Object.keys(envs).sort()).toEqual(['production', 'staging']);
        expect(config).not.toHaveProperty('routes');
        expect(config).not.toHaveProperty('route');
        const hosts = { staging: LINK_STAGING_HOST, production: LINK_HOST } as const;
        expect(envs.staging.name).toBe('socio-link-staging');
        expect(envs.production.name).toBe('socio-link');
        for (const env of ['staging', 'production'] as const) {
            expect(envs[env].routes, env).toEqual([{ pattern: hosts[env], custom_domain: true }]);
            expect(envs[env], env).not.toHaveProperty('route');
            expect(envs[env], env).not.toHaveProperty('compatibility_flags');
            expect(envs[env].limits, env).toEqual({ cpu_ms: 10 });
        }
        expect(config.limits).toEqual({ cpu_ms: 10 });
    });

    it("keeps the development builds (the public debug key) on staging's host alone", () => {
        expect(HOST_VARIANTS[LINK_STAGING_HOST]).toEqual(['development']);
        expect(HOST_VARIANTS[LINK_HOST]).toEqual(['production', 'preview']);
        expect(Object.keys(HOST_VARIANTS).sort()).toEqual([LINK_HOST, LINK_STAGING_HOST].sort());
        // The bench's tunnel host comes only from `--var` on wrangler dev, never from the file.
        expect(settings).not.toMatch(/DEV_LINK_HOST/);
    });

    it('turns off Workers Logs, invocation logs, traces and Logpush in every environment', () => {
        for (const [name, env] of environments()) {
            expect(env.logpush, name).toBe(false);
            expect(env.observability, name).toEqual({
                enabled: false,
                logs: { enabled: false, invocation_logs: false },
                traces: { enabled: false },
            });
            expect(env, name).not.toHaveProperty('tail_consumers');
            expect(env, name).not.toHaveProperty('streaming_tail_consumers');
            expect(env.workers_dev, name).toBe(false);
            expect(env.preview_urls, name).toBe(false);
        }
        expect(config.upload_source_maps).toBe(false);
    });

    it('binds no storage and no service: the Worker keeps nothing', () => {
        for (const [name, env] of environments()) {
            for (const binding of [
                'kv_namespaces',
                'd1_databases',
                'r2_buckets',
                'durable_objects',
                'queues',
                'analytics_engine_datasets',
                'services',
                'vars',
                'secrets_store_secrets',
                'hyperdrive',
                'vectorize',
                'ai',
                'browser',
                'send_email',
                'ratelimits',
            ]) {
                expect(env, `${name} ${binding}`).not.toHaveProperty(binding);
            }
        }
    });

    it('names no account, zone, key or token', () => {
        expect(settings).not.toMatch(/account_id|zone_id|zone_name|api_token|api_key|secret/i);
        expect(text).not.toMatch(/[0-9a-f]{32}/i);
        for (const [name, env] of environments()) {
            expect(env, name).not.toHaveProperty('account_id');
        }
    });
});

describe("the Worker's source", () => {
    const sources = readdirSync(new URL('../src', import.meta.url).pathname).map((file) => [
        file,
        read(`../src/${file}`),
    ]);

    it('writes no log line', () => {
        expect(sources.length).toBeGreaterThan(3);
        for (const [file, source] of sources) {
            expect(source, file).not.toMatch(/console\.|\.log\(/);
        }
    });

    it('makes no request of its own', () => {
        for (const [file, source] of sources) {
            expect(source, file).not.toMatch(/\bfetch\(|connect\(|caches\./);
        }
    });

    it('runs wrangler with its metrics off', () => {
        const { scripts } = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
        for (const [name, script] of Object.entries(scripts)) {
            if (/(^|\s)wrangler\s/.test(script)) {
                expect(script, name).toMatch(/^cross-env WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1 /);
            }
        }
    });
});
