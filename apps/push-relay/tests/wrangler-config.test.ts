// wrangler.toml: the relay's custom domains, the same hosts the servers allow, the same
// bindings in every environment, and every log and metric off. The deploy pipeline fills in the account's
// values when it deploys; nothing here may name the account or hold a key or token.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { QUOTAS } from '../src/quotas';
import { writeBudgetFrom } from '../src/write-budget';

const text = readFileSync(new URL('../wrangler.toml', import.meta.url).pathname, 'utf8');
/** The server's notifications contract, read as text: the relay's tsconfig has the Workers types, not the server's. */
const contract = readFileSync(
    new URL('../../../src/server/notifications/contract.ts', import.meta.url).pathname,
    'utf8',
);
/** The settings alone, without the comments. */
const settings = text.replace(/^\s*#.*$/gm, '');

type Value = string | number | boolean | Value[] | Table;
interface Table {
    [key: string]: Value;
}

/** The subset of TOML wrangler.toml uses: tables, arrays of tables, strings, numbers, booleans, arrays and inline tables. */
function parse(source: string): Table {
    const root: Table = {};
    let current = root;
    const at = (path: string[], array: boolean) => {
        let table = root;
        path.forEach((key, i) => {
            const last = i === path.length - 1;
            if (last && array) {
                const list = (table[key] ??= []) as Table[];
                list.push({});
                table = list[list.length - 1];
                return;
            }
            const next = table[key] ?? (table[key] = {});
            table = (Array.isArray(next) ? next[next.length - 1] : next) as Table;
        });
        return table;
    };
    const value = (raw: string): Value => {
        const v = raw.trim();
        if (v.startsWith('"')) {
            return JSON.parse(v) as string;
        }
        if (v === 'true' || v === 'false') {
            return v === 'true';
        }
        if (v.startsWith('[')) {
            return split(v.slice(1, -1)).map(value);
        }
        if (v.startsWith('{')) {
            const table: Table = {};
            for (const pair of split(v.slice(1, -1))) {
                const [k, ...rest] = pair.split('=');
                table[k.trim()] = value(rest.join('='));
            }
            return table;
        }
        if (/^-?\d+$/.test(v)) {
            return Number(v);
        }
        throw new Error(`unsupported value: ${v}`);
    };
    for (const line of source.split('\n')) {
        const t = line.replace(/^\s*#.*$/, '').trim();
        if (!t) {
            continue;
        }
        const header = /^(\[\[?)([^\]]+)\]\]?$/.exec(t);
        if (header) {
            current = at(
                header[2].split('.').map((part) => part.trim()),
                header[1] === '[[',
            );
            continue;
        }
        const eq = t.indexOf('=');
        current[t.slice(0, eq).trim()] = value(t.slice(eq + 1));
    }
    return root;
}

/** Splits on top-level commas. */
function split(list: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === '"' && list[i - 1] !== '\\') {
            quoted = !quoted;
        } else if (!quoted && (c === '{' || c === '[')) {
            depth++;
        } else if (!quoted && (c === '}' || c === ']')) {
            depth--;
        } else if (!quoted && depth === 0 && c === ',') {
            out.push(list.slice(start, i));
            start = i + 1;
        }
    }
    out.push(list.slice(start));
    return out.map((part) => part.trim()).filter(Boolean);
}

const config = parse(text);
const envs = config.env as Record<string, Table>;
const sections: [string, Table][] = [
    ['local', config],
    ['staging', envs.staging],
    ['production', envs.production],
];

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
/** Each deployed environment's custom domain. */
const HOSTS = { production: 'push.socio.sh', staging: 'push-staging.socio.sh' };

/** `DEFAULT_PUSH_HOSTS`' exact names (its other entries are the browsers' `*.` services), in order. */
function defaultRelayHosts(): string[] {
    const list = /export const DEFAULT_PUSH_HOSTS = \[([^\]]*)\]/.exec(contract);
    if (!list) {
        throw new Error('DEFAULT_PUSH_HOSTS not found in contract.ts');
    }
    const hosts = [...list[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    return hosts.filter((host) => !host.startsWith('*.'));
}
const SECRETS = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'FCM_SERVICE_ACCOUNT_JSON'];

describe('wrangler.toml', () => {
    it('holds no account id, zone, key or token', () => {
        expect(settings).not.toMatch(/account_id|zone_/m);
        // Cloudflare account and zone ids, API tokens: 32 or more hex or token characters in a row.
        expect(text.replaceAll(PLACEHOLDER_ID, '')).not.toMatch(/[0-9a-f]{32}/i);
        expect(settings).not.toMatch(/[A-Za-z0-9_]{40,}/);
        expect(text).not.toMatch(/BEGIN|PRIVATE KEY|private_key|"type"\s*:/);
        for (const [, section] of sections) {
            const vars = section.vars as Table;
            expect(Object.keys(vars).filter((name) => SECRETS.includes(name))).toEqual([]);
            for (const db of section.d1_databases as Table[]) {
                expect(db.database_id).toBe(PLACEHOLDER_ID);
            }
        }
    });

    it('serves each Worker on its custom domain alone, with that origin as RELAY_ORIGIN', () => {
        expect(config.name).toBe('socio-push-local');
        expect(config.workers_dev).toBe(false);
        expect(config.routes).toBeUndefined();
        expect((config.vars as Table).RELAY_ORIGIN).toBe('http://127.0.0.1:8787');
        expect(Object.keys(envs).sort()).toEqual(['production', 'staging']);
        expect(envs.staging.name).toBe('socio-push-staging');
        expect(envs.production.name).toBe('socio-push');
        for (const env of ['production', 'staging'] as const) {
            expect(envs[env].routes, env).toEqual([{ pattern: HOSTS[env], custom_domain: true }]);
            expect((envs[env].vars as Table).RELAY_ORIGIN, env).toBe(`https://${HOSTS[env]}`);
            // A second host would be a second origin: VAPID's aud and the servers' list allow one.
            expect(envs[env].workers_dev, env).toBe(false);
            expect(envs[env].route, env).toBeUndefined();
        }
    });

    it("uses exactly the relay hosts the servers allow (DEFAULT_PUSH_HOSTS), so they can't drift", () => {
        expect(defaultRelayHosts()).toEqual([HOSTS.production, HOSTS.staging]);
        const origins = (['production', 'staging'] as const).map(
            (env) => new URL((envs[env].vars as Table).RELAY_ORIGIN as string).host,
        );
        expect(origins).toEqual(defaultRelayHosts());
    });

    it.each(sections)(
        '%s: binds D1, the five quotas from QUOTAS, the daily cron and the write budget',
        (_, section) => {
            expect(section.d1_databases).toEqual([
                expect.objectContaining({ binding: 'DB', migrations_dir: 'migrations' }),
            ]);
            const limits = Object.fromEntries(
                (section.ratelimits as Table[]).map((rule) => [rule.name, rule.simple as Table]),
            );
            expect(limits).toEqual(
                Object.fromEntries(
                    Object.values(QUOTAS).map((quota) => [quota.binding, { limit: quota.limit, period: quota.period }]),
                ),
            );
            expect((section.triggers as Table).crons).toEqual(['17 3 * * *']);
            const budget = (section.vars as Table).REGISTRATION_WRITE_BUDGET;
            expect(writeBudgetFrom(budget)).toBe(Number(budget));
            expect(section.limits).toEqual({ cpu_ms: 50 });
        },
    );

    it('gives every rate limiter its own namespace', () => {
        const ids = sections.flatMap(([, section]) => (section.ratelimits as Table[]).map((rule) => rule.namespace_id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it.each(sections)('%s: keeps every log, trace, Logpush and preview URL off', (_, section) => {
        expect(section.observability).toEqual({
            enabled: false,
            logs: { enabled: false, invocation_logs: false },
            traces: { enabled: false },
        });
        expect(section.logpush).toBe(false);
        expect(section.preview_urls).toBe(false);
        expect(section.tail_consumers).toBeUndefined();
        expect(section.streaming_tail_consumers).toBeUndefined();
    });

    it("turns wrangler's own reporting off and adds no compatibility flags", () => {
        expect(config.send_metrics).toBe(false);
        expect(config.dependencies_instrumentation).toEqual({ enabled: false });
        expect(config.upload_source_maps).toBe(false);
        expect(settings).not.toMatch(/compatibility_flags|nodejs_compat/);
    });
});
