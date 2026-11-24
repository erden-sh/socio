import { z } from 'zod';

import { SECRET_NAME, type AppManifestSecret } from '../workspace-secrets.js';

/**
 * A mini app's manifest: what a packaged version is and
 * needs. The Dot writes it with `app_package`; the user reviews it when
 * promoting; the workspace app runtime runs the bundle by it.
 */
export interface AppManifest {
    name: string;
    description: string;
    /** The file the runtime starts, relative to the bundle's root. */
    entry: string;
    runtime: 'bun';
    /** Path prefixes the app serves (informational, shown in review). */
    routes?: string[];
    /**
     * The datasets it reads or writes: an id from data_list, or `scratch`
     * for the Dot's scratch dataset. `tables` narrows what a move copies.
     */
    datasets: AppManifestDataset[];
    /** `host:port` entries it may reach (HTTPS through the egress proxy). */
    egress: string[];
    /** Settings it reads from its environment: name → description. No secrets. */
    env?: Record<string, string>;
    /**
     * Socio Secrets it reads at runtime, by name.
     * Undeclared names can't be granted or read; a missing required one
     * marks the app as needing setup.
     */
    secrets?: AppManifestSecret[];
    /**
     * The socio-access contract (CB-232): only an app that declares it
     * can be opened by a socio acting for a person.
     */
    delegation?: AppDelegation;
}

/** An app action's tier (CB-232); the same list as `ACTION_TIERS`. */
export type AppActionTier = 'read' | 'write' | 'consequential' | 'admin';

/**
 * `delegation` in a manifest (CB-232). `actions` and `alwaysAsk`
 * make the version's `actionSetHash`: a version that changes them suspends
 * grants made under the older one until the person approves again.
 */
export interface AppDelegation {
    contract: 1;
    /** Action name → tier. Apps don't invent scopes; tiers map to them. */
    actions: Record<string, AppActionTier>;
    /** Paths the SDK serves without an envelope (prefixes ending in `/`). */
    public: string[];
    /** Every access request shows the card, whatever the person's policy. */
    alwaysAsk: boolean;
    /**
     * Datasets the app's own jobs may write without an `obo`;
     * `read: false` refuses reads without one too.
     */
    background?: { datasets: string[]; read: boolean };
    /**
     * What a person with `space` access may do per dataset (by id or the
     * manifest's ref) through the app; `read` where unset.
     */
    spaceAccess?: Record<string, 'read' | 'write'>;
    /**
     * What Socio may hand the app beyond requests (CB-239, CB-267):
     * `repo-extract` makes a promoted app eligible for approval-gated
     * repository extractions, read once through the person's `cbob_`. Not
     * part of `actionSetHash`: it changes no socio's grant.
     */
    accepts?: AppDeliveryContract[];
}

/** What an app may declare it accepts in `delegation.accepts`. */
export const APP_DELIVERY_CONTRACTS = ['repo-extract'] as const;
export type AppDeliveryContract = (typeof APP_DELIVERY_CONTRACTS)[number];
export interface AppManifestDataset {
    id: string;
    access: 'read' | 'write';
    tables?: string[];
}

/** Names the runtime sets itself (or that would change how it runs). */
export const RESERVED_ENV = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'PORT',
    'NODE_ENV',
    'NODE_OPTIONS',
    'BUN_OPTIONS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
]);

const ENTRY = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]{1,200}\.(ts|tsx|js|mjs|cjs|jsx)$/;
const HOST_PORT = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+:(\d{1,5})$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ACTION = /^[a-z][A-Za-z0-9_.:-]{0,63}$/;
// oxlint-disable-next-line no-control-regex -- one line of text, no control characters
const LINE = /^[^\u0000-\u001f]*$/;

/**
 * One egress entry: a public DNS name and a port. IP literals, single
 * labels, `localhost` and `.local`/`.internal` names are refused: the
 * proxy also refuses names that resolve to private addresses.
 */
export function egressProblem(entry: string): string | undefined {
    const value = entry.trim().toLowerCase();
    const match = HOST_PORT.exec(value);
    if (!match) {
        return `"${entry}" is not host:port (e.g. api.example.com:443).`;
    }
    const host = value.slice(0, value.lastIndexOf(':'));
    const port = Number(value.slice(value.lastIndexOf(':') + 1));
    if (port < 1 || port > 65535) {
        return `"${entry}" has no valid port.`;
    }
    if (IPV4.test(host)) {
        return `"${entry}": use a host name, not an address.`;
    }
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) {
        return `"${entry}" is not a public host.`;
    }
    return undefined;
}

export const appManifestSchema = z
    .object({
        name: z.string().trim().min(1).max(60).regex(LINE),
        description: z.string().trim().max(500).regex(LINE).default(''),
        entry: z.string().trim().regex(ENTRY, 'entry is a relative .ts/.js file inside the bundle'),
        runtime: z.literal('bun').default('bun'),
        routes: z
            .array(
                z
                    .string()
                    .max(200)
                    .regex(/^\/[^\s]*$/, 'routes start with /'),
            )
            .max(20)
            .optional(),
        datasets: z
            .array(
                z
                    .object({
                        id: z.string().trim().min(1).max(100),
                        access: z.enum(['read', 'write']),
                        tables: z.array(z.string().regex(TABLE)).max(50).optional(),
                    })
                    .strict(),
            )
            .max(20)
            .default([]),
        egress: z
            .array(z.string().max(270))
            .max(20)
            .default([])
            .superRefine((entries, ctx) => {
                for (const entry of entries) {
                    const problem = egressProblem(entry);
                    if (problem) {
                        ctx.addIssue({ code: 'custom', message: problem });
                    }
                }
            })
            .transform((entries) => [...new Set(entries.map((entry) => entry.trim().toLowerCase()))]),
        env: z
            .record(z.string(), z.string().max(300).regex(LINE))
            .optional()
            .superRefine((env, ctx) => {
                const names = Object.keys(env ?? {});
                if (names.length > 20) {
                    ctx.addIssue({ code: 'custom', message: 'At most 20 env settings.' });
                }
                for (const name of names) {
                    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name) || name.startsWith('CB_')) {
                        ctx.addIssue({
                            code: 'custom',
                            message: `env "${name}": use UPPER_CASE names, not CB_* or ${[...RESERVED_ENV].slice(0, 4).join('/')}….`,
                        });
                    }
                }
            }),
        secrets: z
            .array(
                z
                    .object({
                        name: z.string().regex(SECRET_NAME, 'secret names are UPPER_CASE, like STRIPE_API_KEY'),
                        required: z.boolean().default(true),
                        description: z.string().trim().max(300).regex(LINE).optional(),
                    })
                    .strict(),
            )
            .max(50)
            .optional(),
        delegation: z
            .object({
                contract: z.literal(1),
                actions: z
                    .record(
                        z.string().regex(ACTION, 'action names are like deal.update'),
                        z.enum(['read', 'write', 'consequential', 'admin']),
                    )
                    .refine((actions) => Object.keys(actions).length <= 200, {
                        message: 'At most 200 actions.',
                    })
                    // `data:<op>` names Socio's own data operations, whose tier is
                    // the platform's (CB-232): an app can't declare one.
                    .refine((actions) => !Object.keys(actions).some((name) => name.startsWith('data:')), {
                        message: 'Action names starting with data: are reserved for Socio’s data operations.',
                    }),
                public: z
                    .array(
                        z
                            .string()
                            .max(200)
                            .regex(/^\/[^\s?#]*$/, 'public paths start with /'),
                    )
                    .max(50)
                    .default([]),
                alwaysAsk: z.boolean().default(false),
                background: z
                    .object({
                        datasets: z.array(z.string().trim().min(1).max(100)).max(20),
                        read: z.boolean().default(true),
                    })
                    .strict()
                    .optional(),
                spaceAccess: z
                    .record(z.string().trim().min(1).max(100), z.enum(['read', 'write']))
                    .refine((access) => Object.keys(access).length <= 20, {
                        message: 'At most 20 datasets.',
                    })
                    .optional(),
                accepts: z
                    .array(z.enum(APP_DELIVERY_CONTRACTS))
                    .max(APP_DELIVERY_CONTRACTS.length)
                    .transform((list) => [...new Set(list)])
                    .optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

/**
 * Row ownership is later (CB-232): until it ships,
 * a manifest that names `ownerColumn` is refused, so no app relies on a
 * filter that isn't there.
 */
function ownerColumnNamed(input: unknown) {
    if (!input || typeof input !== 'object') {
        return false;
    }
    const raw = input as {
        delegation?: { ownerColumn?: unknown };
        datasets?: unknown;
    };
    return (
        (raw.delegation && typeof raw.delegation === 'object' && 'ownerColumn' in raw.delegation) ||
        (Array.isArray(raw.datasets) &&
            raw.datasets.some((dataset) => !!dataset && typeof dataset === 'object' && 'ownerColumn' in dataset))
    );
}

/** A manifest, checked; the first problems in one line when it isn't. */
export function parseAppManifest(input: unknown): { ok: true; manifest: AppManifest } | { ok: false; error: string } {
    if (ownerColumnNamed(input)) {
        return {
            ok: false,
            error: 'ownerColumn: row ownership is not available yet; filter by the envelope’s sub in the app instead.',
        };
    }
    const parsed = appManifestSchema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            error: parsed.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
                .join('; '),
        };
    }
    const manifest = parsed.data as AppManifest;
    const ids = manifest.datasets.map((dataset) => dataset.id.toLowerCase());
    if (new Set(ids).size !== ids.length) {
        return { ok: false, error: 'datasets: each dataset is listed once.' };
    }
    if (manifest.env && !Object.keys(manifest.env).length) {
        delete manifest.env;
    }
    const secrets = manifest.secrets?.map((secret) => secret.name) ?? [];
    if (new Set(secrets).size !== secrets.length) {
        return { ok: false, error: 'secrets: each secret is listed once.' };
    }
    const clash = secrets.find((name) => manifest.env && Object.hasOwn(manifest.env, name));
    if (clash) {
        return {
            ok: false,
            error: `secrets: ${clash} is also an env setting; a secret is read through Socio Secrets.`,
        };
    }
    if (manifest.secrets && !manifest.secrets.length) {
        delete manifest.secrets;
    }
    return { ok: true, manifest };
}

/** What changed between two manifests, in short lines for an approval. */
export function manifestChanges(before: AppManifest | undefined, after: AppManifest): string[] {
    if (!before) {
        return ['First version.'];
    }
    const lines: string[] = [];
    if (before.entry !== after.entry) {
        lines.push(`Entry: ${before.entry} → ${after.entry}`);
    }
    if (before.description !== after.description) {
        lines.push('New description.');
    }
    const was = new Map(before.datasets.map((d) => [d.id, d]));
    const now = new Map(after.datasets.map((d) => [d.id, d]));
    for (const [id, dataset] of now) {
        const old = was.get(id);
        if (!old) {
            lines.push(`New dataset: ${id} (${dataset.access})`);
        } else if (old.access !== dataset.access) {
            lines.push(`Dataset ${id}: ${old.access} → ${dataset.access}`);
        }
    }
    for (const id of was.keys()) {
        if (!now.has(id)) {
            lines.push(`No longer uses dataset ${id}`);
        }
    }
    const egressBefore = new Set(before.egress);
    const egressAfter = new Set(after.egress);
    for (const host of egressAfter) {
        if (!egressBefore.has(host)) {
            lines.push(`New egress: ${host}`);
        }
    }
    for (const host of egressBefore) {
        if (!egressAfter.has(host)) {
            lines.push(`Egress removed: ${host}`);
        }
    }
    const envBefore = Object.keys(before.env ?? {});
    const envAfter = Object.keys(after.env ?? {});
    for (const name of envAfter) {
        if (!envBefore.includes(name)) {
            lines.push(`New setting: ${name}`);
        }
    }
    for (const name of envBefore) {
        if (!envAfter.includes(name)) {
            lines.push(`Setting removed: ${name}`);
        }
    }
    const secretsBefore = new Map((before.secrets ?? []).map((secret) => [secret.name, secret]));
    const secretsAfter = new Map((after.secrets ?? []).map((secret) => [secret.name, secret]));
    for (const [name, secret] of secretsAfter) {
        const was = secretsBefore.get(name);
        if (!was) {
            lines.push(`New secret: ${name}${secret.required ? ' (required)' : ''}`);
        } else if (was.required !== secret.required) {
            lines.push(`Secret ${name}: ${secret.required ? 'now required' : 'now optional'}`);
        }
    }
    for (const name of secretsBefore.keys()) {
        if (!secretsAfter.has(name)) {
            lines.push(`Secret removed: ${name}`);
        }
    }
    lines.push(...delegationChanges(before.delegation, after.delegation));
    return lines;
}

/** What changed in socio access between two manifests (CB-232). */
function delegationChanges(before: AppDelegation | undefined, after: AppDelegation | undefined): string[] {
    if (!before && !after) {
        return [];
    }
    if (!before) {
        return ['Socio access: adopted (socios can ask to use it).'];
    }
    if (!after) {
        return ['Socio access: dropped (socios can’t use it).'];
    }
    const lines: string[] = [];
    const names = new Set([...Object.keys(before.actions), ...Object.keys(after.actions)]);
    for (const name of [...names].sort()) {
        const was = before.actions[name];
        const now = after.actions[name];
        if (was === now) {
            continue;
        }
        lines.push(
            !was
                ? `New action: ${name} (${now})`
                : !now
                  ? `Action removed: ${name}`
                  : `Action ${name}: ${was} → ${now}`,
        );
    }
    if (before.alwaysAsk !== after.alwaysAsk) {
        lines.push(`Always ask: ${after.alwaysAsk ? 'on' : 'off'}`);
    }
    const accepted = (delegation: AppDelegation) => delegation.accepts?.includes('repo-extract') === true;
    if (accepted(before) !== accepted(after)) {
        lines.push(`Repository extractions: ${accepted(after) ? 'accepted' : 'no longer accepted'}`);
    }
    return lines;
}
