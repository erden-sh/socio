// wrangler.toml and the Worker's source: every log, trace and metric off in every environment, no
// storage yet, nothing that names the account, the static assets with only the dynamic paths
// running the Worker first, and each environment on its one host. The deploy pipeline passes the
// account when it deploys; nothing here may name it or hold a key.

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ROUTES } from '../src/worker/index.ts';

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

const environments = (): [string, Record<string, unknown>][] => [
    ['top level', config],
    ...Object.entries(config.env ?? {}).map(([name, env]): [string, Record<string, unknown>] => [name, env]),
];

describe('wrangler.toml', () => {
    it('is the local top level, running src/worker/index.ts', () => {
        expect(config.name).toBe('socio-site-local');
        expect(config.main).toBe('src/worker/index.ts');
        expect(config).not.toHaveProperty('compatibility_flags');
        expect(config.send_metrics).toBe(false);
        expect(config.dependencies_instrumentation).toEqual({ enabled: false });
        expect(config).not.toHaveProperty('routes');
        expect(config).not.toHaveProperty('route');
    });

    it('has a staging and a production environment, each on its one host as a custom domain', () => {
        const envs = config.env ?? {};
        expect(Object.keys(envs).sort()).toEqual(['production', 'staging']);
        expect(envs.staging?.name).toBe('socio-site-staging');
        expect(envs.production?.name).toBe('socio-site');
        expect(envs.staging?.routes).toEqual([{ pattern: 'site-staging.socio.sh', custom_domain: true }]);
        expect(envs.production?.routes).toEqual([{ pattern: 'socio.sh', custom_domain: true }]);
        for (const [name, env] of environments()) {
            expect(env, name).not.toHaveProperty('route');
            expect(env.limits, name).toEqual({ cpu_ms: 10 });
        }
    });

    it('builds each environment its own way: staging says noindex', () => {
        expect(config.build).toEqual({ command: 'pnpm run build' });
        expect(config.env?.production?.build).toEqual({ command: 'pnpm run build' });
        expect(config.env?.staging?.build).toEqual({ command: 'pnpm run build:staging' });
        expect(config.vars).toEqual({ SITE_ENV: 'local' });
        expect(config.env?.staging?.vars).toEqual({ SITE_ENV: 'staging' });
        expect(config.env?.production?.vars).toEqual({ SITE_ENV: 'production' });
        const { scripts } = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
        expect(scripts.build).toBe('cross-env SITE_ENV=production vite build');
        expect(scripts['build:staging']).toBe('cross-env SITE_ENV=staging vite build');
    });

    it('serves dist/ as static assets, running the Worker first only for its own paths', () => {
        for (const [name, env] of environments()) {
            expect(env.assets, name).toEqual({
                directory: 'dist',
                binding: 'ASSETS',
                html_handling: 'auto-trailing-slash',
                not_found_handling: '404-page',
                run_worker_first: Object.keys(ROUTES),
            });
        }
        expect(Object.keys(ROUTES)).toEqual(['/forms']);
    });

    it('turns off Workers Logs, invocation logs, traces, Logpush, workers.dev and preview URLs everywhere', () => {
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

    it('binds no storage and no service yet: D1 and the rate limit come with the form handler', () => {
        for (const [name, env] of environments()) {
            for (const binding of [
                'kv_namespaces',
                'd1_databases',
                'r2_buckets',
                'durable_objects',
                'queues',
                'analytics_engine_datasets',
                'services',
                'secrets_store_secrets',
                'secrets',
                'hyperdrive',
                'vectorize',
                'ai',
                'browser',
                'send_email',
                'ratelimits',
                'triggers',
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
    const sources = readdirSync(new URL('../src/worker', import.meta.url).pathname).map((file) => [
        file,
        read(`../src/worker/${file}`),
    ]);

    it('writes no log line and makes no request of its own', () => {
        expect(sources.length).toBe(2);
        for (const [file, source] of sources) {
            expect(source, file).not.toMatch(/console\.|\.log\(/);
            // env.ASSETS.fetch serves the site's own files; a global fetch would be a request out.
            expect(source, file).not.toMatch(/(?<![.\w])fetch\((?!request: Request\): Promise)|connect\(|caches\./);
        }
    });

    it('runs wrangler with its metrics off', () => {
        const { scripts } = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
        for (const [name, script] of Object.entries(scripts)) {
            const at = script.search(/(^|\s)wrangler\s/);
            if (at >= 0) {
                expect(script.slice(0, at), name).toMatch(/cross-env WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1 /);
            }
        }
    });
});
