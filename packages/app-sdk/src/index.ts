import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { backupSide, isBackupRoute, sendWebResponse, toWebRequest, type BackupServer } from './backup.js';
import {
    ACTOR_ENVELOPE_HEADER,
    ENVELOPE_SKEW_MS,
    envelopeKeyFrom,
    isReservedTarget,
    openEnvelope,
    openHostEnvelope,
} from './envelope.js';
import { canonicalJson } from './jcs.js';
import { secretsClient } from './secrets.js';

/**
 * The Socio mini app SDK (CB-232). An app verifies on every
 * request who it is for, from the `x-cb-actor` envelope the apps proxy
 * signs with the app's own key; it authorizes each action by the tier its
 * manifest declares; it asks the person to approve a consequential
 * action and consumes that approval once; and it calls Socio's data API
 * on behalf of the request (`x-cb-obo`), never with more than the person
 * (or the socio acting for them) may do.
 *
 * A service plugin uses it the same way with `CB_APP_ID=plugin:<id>`
 * (CB-232): its calls go to `/api/plugins/<id>/…` with its service
 * token and proof.
 *
 * The core is fetch-level (`verify`); `fetchHandler`, `hono`, `express`
 * and `node` adapt it. Every adapter refuses a request without a valid
 * envelope with 401, on every path but the ones the app lists as public.
 *
 * The reserved `/__cb/` prefix (CB-458) takes only Socio's own host
 * envelope (`acc: "host"`), never a person's or a socio's, and is never
 * public; a host envelope opens nothing else.
 */

export {
    ACTOR_ENVELOPE_HEADER,
    HOST_PATH_PREFIX,
    isHostTarget,
    isReservedTarget,
    openEnvelope,
    openHostEnvelope,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
    type EnvelopeFailure,
    type HostEnvelopeClaims,
} from './envelope.js';
export {
    BACKUP_PATH,
    DEFAULT_EXCLUDES,
    defaultBackupHandler,
    globMatcher,
    QUIESCE_LEASE_MS,
    RESTORE_PATH,
    SNAPSHOT_LEASE_MS,
    SNAPSHOT_REASONS,
    type BackupDraft,
    type BackupHandler,
    type BackupItemDraft,
    type BackupServeOptions,
    type BackupServer,
    type ItemBytes,
    type RestoredState,
    type SnapshotReason,
    type SocioBackup,
} from './backup.js';
export { canonicalJson } from './jcs.js';
export type {
    DataBatchExpectationError,
    DataBatchResponse,
    DataBatchStatement,
    DataBatchStatementResult,
    DataCell,
    DataPluginBudget,
    DataQueryResult,
    DataReadBatchRequest,
    DataReadBatchResponse,
    DataValue,
} from './data-api.js';
export {
    SecretReadError,
    secretsClient,
    type RotateListener,
    type SecretsClient,
    type SecretValue,
} from './secrets.js';

export type ActionTier = 'read' | 'write' | 'consequential' | 'admin';

/** The header a socio's repeated request names its approval in. */
export const APPROVAL_HEADER = 'x-cb-approval';
/** The header Socio's data API reads the request's `obo` from. */
export const OBO_HEADER = 'x-cb-obo';
/** The header a plugin's calls back into Socio prove its id with. */
export const PLUGIN_PROOF_HEADER = 'x-cb-plugin-proof';
/** A plugin's `CB_APP_ID` (its audience) starts with this. */
export const PLUGIN_PREFIX = 'plugin:';

/** Who a request is for, from a verified envelope. Ids are opaque per app. */
export interface Principal {
    /** The person: the same value as the legacy `x-cb-user`; `host` for Socio itself. */
    person: string;
    /**
     * Their access to the app. `host` is Socio itself (CB-458), on the
     * reserved `/__cb/` prefix only: it runs no declared action.
     */
    access: 'owner' | 'space' | 'host';
    /** Set when a socio acts for the person. */
    socio?: { id: string; grant: string; scopes: readonly string[] };
    /** The request's on-behalf-of token, for the data API. */
    obo?: string;
    /** An opaque session id, for logs. */
    sessionId: string;
    /** The app version Socio routed to; null for a development app. */
    version: number | null;
    /** The approval a socio's repeated request names. */
    approval?: string;
}

/** An extraction's id, as Socio names it to the socio and the app. */
const EXTRACTION_ID = /^[0-9a-f-]{36}$/;

/** A repository extraction (`socio-repo-extract/1`), as Socio delivers it. */
export interface RepoExtraction {
    format: 'socio-repo-extract/1';
    repository: string;
    commit: string;
    paths: string[];
    files: Array<{
        path: string;
        executable: boolean;
        size: number;
        /** `utf8` text as is; anything else base64. */
        encoding: 'utf8' | 'base64';
        content: string;
    }>;
}

export type Verdict = { ok: true; principal: Principal } | { ok: false; status: 401 | 403; reason: string };

/**
 * Seen `jti`s, so a captured envelope can't be replayed within its
 * minute. The default is per process: an app with several replicas
 * passes a shared one (threat model, "Envelope replayed").
 */
export interface ReplayCache {
    /** Records `jti` until `until`; true when it was already there. */
    seen(jti: string, until: number, now: number): boolean;
}

export class MemoryReplayCache implements ReplayCache {
    private entries = new Map<string, number>();
    constructor(private max = 100_000) {}
    seen(jti: string, until: number, now: number) {
        if (this.entries.size >= this.max) {
            for (const [key, expires] of this.entries) {
                if (expires <= now) {
                    this.entries.delete(key);
                }
            }
        }
        const known = this.entries.get(jti);
        if (known !== undefined && known > now) {
            return true;
        }
        // Full of live entries: refuse rather than forget one (fail closed).
        if (this.entries.size >= this.max) {
            return true;
        }
        this.entries.set(jti, until);
        return false;
    }
}

export interface SocioAppOptions {
    /**
     * The app's id; `CB_APP_ID` by default. A service plugin's is
     * `plugin:<id>` (its tasks get that `CB_APP_ID`): the SDK then calls
     * the plugin's routes (`/api/plugins/<id>/…`) with the plugin's
     * identity token and proof instead of an app data token.
     */
    appId?: string;
    /** The envelope key (base64url); `CB_ACTOR_KEY` by default. */
    key?: string;
    /** The previous key after a rotation, and until when it is accepted. */
    previousKey?: string;
    previousUntil?: number;
    /** The manifest's `delegation.actions`: action name → tier. */
    actions?: Record<string, ActionTier>;
    /** The manifest's `delegation.public`: paths served without an envelope. */
    publicPaths?: readonly string[];
    /**
     * Socio's `/api` base; derived from `CB_DATA_URL` (`…/api/data`), or for
     * a plugin `SOCIO_API_URL` (Socio's origin) plus `/api`.
     */
    apiUrl?: string;
    /** The app's data token; `CB_DATA_TOKEN_FILE`, else `CB_DATA_TOKEN`. */
    dataToken?: () => string | undefined;
    /**
     * A plugin's token: its own identity, the file `SOCIO_IDENTITY_FILE`
     * that the runtime delivers (Socio Secrets phase 2), read again on
     * every call so a rotation is picked up; else, deprecated, the shared
     * `PLUGIN_SERVICE_TOKEN` from `SOCIO_API_TOKEN_FILE` or
     * `SOCIO_API_TOKEN`. Plugins only.
     */
    serviceToken?: () => string | undefined;
    /** A plugin's proof of its id; `CB_PLUGIN_PROOF`. Plugins only. */
    pluginProof?: string;
    replay?: ReplayCache;
    now?: () => number;
    fetch?: typeof fetch;
    /** Where the defaults are read from; `process.env` by default. */
    env?: Record<string, string | undefined>;
}

const SCOPE_FOR: Record<Exclude<ActionTier, 'admin'>, string> = {
    read: 'app:read',
    write: 'app:write',
    consequential: 'app:act',
};
const IMPLIED: Record<string, readonly string[]> = {
    'app:act': ['app:act', 'app:write', 'app:read'],
    'app:write': ['app:write', 'app:read'],
    'app:read': ['app:read'],
};
const APPROVAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Socio's data operations that need the person's approval when a socio
 * asks for them, and each one's parameters: exactly what Socio's
 * data API recomputes from the call, so build them with
 * `dataApprovalParams` from the values the call sends.
 */
export interface DataApprovalInputs {
    /** `DELETE /data/files?path=…`: the exact `path` sent. */
    'files.delete': { path: string };
    deleteRows: { dataset: string; table: string; rowids: number[] };
    dropTable: { dataset: string; table: string };
    deleteDataset: { dataset: string };
}
export type DataApprovalOperation = keyof DataApprovalInputs;

const DATA_APPROVAL_KEYS: {
    [K in DataApprovalOperation]: ReadonlyArray<keyof DataApprovalInputs[K]>;
} = {
    'files.delete': ['path'],
    deleteRows: ['dataset', 'table', 'rowids'],
    dropTable: ['dataset', 'table'],
    deleteDataset: ['dataset'],
};

/** A data operation's approval parameters: only its own keys. */
export function dataApprovalParams<K extends DataApprovalOperation>(
    op: K,
    input: DataApprovalInputs[K],
): DataApprovalInputs[K] {
    if (!Object.hasOwn(DATA_APPROVAL_KEYS, op)) {
        throw new Error(`${op} needs no approval.`);
    }
    const keys = DATA_APPROVAL_KEYS[op] as ReadonlyArray<keyof DataApprovalInputs[K]>;
    return Object.fromEntries(keys.map((key) => [key, input[key]])) as unknown as DataApprovalInputs[K];
}

/** The path of a request-target, without its query. */
const pathOf = (target: string) => target.split(/[?#]/, 1)[0];

/** A fetch `Request`'s request-target (path and query) from its URL. */
export function targetOf(url: string) {
    const parsed = new URL(url, 'http://app.invalid');
    return `${parsed.pathname}${parsed.search}`;
}

/** SHA-256 of JCS({appId, action, params}), hex: the intent digest. */
export function intentDigest(appId: string, action: string, params: unknown) {
    return createHash('sha256').update(canonicalJson({ appId, action, params })).digest('hex');
}

/** The SDK for one app. */
export function socioApp(options: SocioAppOptions = {}) {
    const env =
        options.env ?? (typeof process === 'undefined' ? {} : (process.env as Record<string, string | undefined>));
    const appId = options.appId ?? env.CB_APP_ID ?? '';
    // A service plugin (CB-232): its own routes, token and proof.
    const pluginId = appId.startsWith(PLUGIN_PREFIX) ? appId.slice(PLUGIN_PREFIX.length) : undefined;
    const now = options.now ?? Date.now;
    const replay = options.replay ?? new MemoryReplayCache();
    const current = envelopeKeyFrom(options.key ?? env.CB_ACTOR_KEY);
    const previous = envelopeKeyFrom(options.previousKey ?? env.CB_ACTOR_KEY_PREVIOUS);
    const previousUntil = options.previousUntil ?? Number(env.CB_ACTOR_KEY_PREVIOUS_UNTIL ?? 0);
    const actions = options.actions ?? {};
    const publicPaths = options.publicPaths ?? [];
    const apiUrl = (
        options.apiUrl ??
        (pluginId === undefined
            ? env.CB_DATA_URL?.replace(/\/data\/?$/, '')
            : env.SOCIO_API_URL && `${env.SOCIO_API_URL.replace(/\/$/, '')}/api`) ??
        ''
    ).replace(/\/$/, '');
    /** A token from a file, else from the environment. */
    const fromFile = (file: string | undefined, value: string | undefined) => {
        if (file) {
            try {
                const token = readFileSync(file, 'utf8').trim();
                if (token) {
                    return token;
                }
            } catch {
                // The file comes with the first renewal; the env has the first token.
            }
        }
        return value;
    };
    const dataToken = options.dataToken ?? (() => fromFile(env.CB_DATA_TOKEN_FILE, env.CB_DATA_TOKEN));
    const serviceToken =
        options.serviceToken ??
        (() => fromFile(env.SOCIO_IDENTITY_FILE, undefined) ?? fromFile(env.SOCIO_API_TOKEN_FILE, env.SOCIO_API_TOKEN));
    const pluginProof = options.pluginProof ?? env.CB_PLUGIN_PROOF;
    const http = options.fetch ?? fetch;
    /**
     * How this app or plugin authenticates its own calls back into Socio:
     * an app's data token; a plugin's identity token and the proof of its id.
     */
    const credentials = (): Record<string, string> | undefined => {
        if (pluginId === undefined) {
            const token = dataToken();
            return token ? { authorization: `Bearer ${token}` } : undefined;
        }
        const token = serviceToken();
        return token && pluginProof
            ? { authorization: `Bearer ${token}`, [PLUGIN_PROOF_HEADER]: pluginProof }
            : undefined;
    };
    /** Socio's socio-access routes for this app or plugin. */
    const actorPath = (path: string) =>
        pluginId === undefined ? `/apps/actor${path}` : `/plugins/${encodeURIComponent(pluginId)}/actor${path}`;

    const keys = () => {
        const list: Uint8Array[] = [];
        if (current) {
            list.push(current);
        }
        if (previous && previousUntil > now()) {
            list.push(previous);
        }
        return list;
    };

    /**
     * Whether a path is one the app serves without an envelope. A path with
     * dot segments or encoded dots and slashes is never public: a router
     * that normalizes it could land somewhere that isn't.
     */
    const isPublic = (target: string) => {
        const path = pathOf(target);
        if (/(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i.test(path) || isReservedTarget(path)) {
            return false;
        }
        return publicPaths.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
    };

    /**
     * Verifies one request: the envelope's version, MAC (current or
     * previous key), audience, time, method and raw request-target, and an
     * unseen `jti`. `target` must be the request-target as it came on the
     * request line, never a decoded or normalized form. A
     * target that could reach `/__cb/` takes only a host envelope, and a
     * host envelope opens nothing else (CB-458).
     */
    const verify = (request: {
        method: string;
        target: string;
        header: string | null | undefined;
        approval?: string | null;
    }): Verdict => {
        const list = keys();
        if (!appId || !list.length) {
            return { ok: false, status: 401, reason: 'not_configured' };
        }
        const expect = {
            aud: appId,
            method: request.method,
            target: request.target,
            now: now(),
        };
        if (isReservedTarget(request.target)) {
            const host = openHostEnvelope(list, request.header, expect);
            if (!host.ok) {
                return { ok: false, status: 401, reason: host.reason };
            }
            if (replay.seen(host.claims.jti, host.claims.exp + ENVELOPE_SKEW_MS, now())) {
                return { ok: false, status: 401, reason: 'replayed' };
            }
            return { ok: true, principal: { person: 'host', access: 'host', sessionId: 'host', version: null } };
        }
        const opened = openEnvelope(list, request.header, expect);
        if (!opened.ok) {
            return { ok: false, status: 401, reason: opened.reason };
        }
        const claims = opened.claims;
        if (replay.seen(claims.jti, claims.exp + ENVELOPE_SKEW_MS, now())) {
            return { ok: false, status: 401, reason: 'replayed' };
        }
        const approval =
            claims.act && request.approval && APPROVAL_ID.test(request.approval) ? request.approval : undefined;
        return {
            ok: true,
            principal: {
                person: claims.sub,
                access: claims.acc,
                ...(claims.act
                    ? {
                          socio: {
                              id: claims.act.id,
                              grant: claims.act.grant,
                              scopes: claims.scp ?? [],
                          },
                      }
                    : {}),
                ...(claims.obo ? { obo: claims.obo } : {}),
                sessionId: claims.sid,
                version: claims.ver,
                ...(approval ? { approval } : {}),
            },
        };
    };

    /**
     * Whether the principal may run `action`: by the tier the app's
     * manifest declares, never by HTTP method. Undeclared actions are
     * refused; `admin` is never a socio's, nor a Space member's; a socio
     * needs the tier's scope.
     */
    const authorize = (
        principal: Principal,
        action: string,
    ): { ok: true; tier: ActionTier } | { ok: false; status: 403; reason: string } => {
        // The host's calls are the SDK's own `/__cb/` routes, never an action.
        if (principal.access === 'host') {
            return { ok: false, status: 403, reason: 'host_envelope' };
        }
        const tier = Object.hasOwn(actions, action) ? actions[action] : undefined;
        if (!tier) {
            return { ok: false, status: 403, reason: 'action_undeclared' };
        }
        if (tier === 'admin') {
            return principal.socio || principal.access !== 'owner'
                ? { ok: false, status: 403, reason: 'admin_tier' }
                : { ok: true, tier };
        }
        if (principal.socio) {
            const held = new Set(principal.socio.scopes.flatMap((scope) => IMPLIED[scope] ?? []));
            if (!held.has(SCOPE_FOR[tier])) {
                return { ok: false, status: 403, reason: 'scope_insufficient' };
            }
        }
        return { ok: true, tier };
    };

    const call = async (path: string, principal: Principal, body: unknown) => {
        const auth = credentials();
        if (!apiUrl || !auth || !principal.obo) {
            throw new Error('Socio’s API is not configured for this app.');
        }
        return http(`${apiUrl}${actorPath(path)}`, {
            method: 'POST',
            headers: {
                ...auth,
                [OBO_HEADER]: principal.obo,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
    };

    /**
     * A consequential action's approval. A person acting for
     * themselves needs none. A socio's first request makes (or finds) the
     * pending approval: answer the socio 202 with `{ approval }`. Its
     * repeated request names the approval; it is consumed here, once, for
     * these exact parameters, and its id is the action's idempotency key.
     */
    const requireApproval = async (
        principal: Principal,
        action: string,
        params: unknown,
        display?: unknown,
    ): Promise<
        | { ok: true; approval?: string }
        | { ok: false; status: 202; approval: string }
        | { ok: false; status: 403 | 409 | 503; reason: string }
    > => {
        const allowed = authorize(principal, action);
        if (!allowed.ok) {
            return allowed;
        }
        if (!principal.socio) {
            return { ok: true };
        }
        const digest = intentDigest(appId, action, params);
        if (principal.approval) {
            const answer = await call(`/approvals/${encodeURIComponent(principal.approval)}/consume`, principal, {
                digest,
            });
            return answer.ok
                ? { ok: true, approval: principal.approval }
                : {
                      ok: false,
                      status: answer.status === 403 ? 403 : 409,
                      reason: 'approval_unusable',
                  };
        }
        const answer = await call('/approvals', principal, {
            action,
            params,
            ...(display === undefined ? {} : { display }),
            digest,
        });
        if (answer.status !== 202) {
            return {
                ok: false,
                status: answer.status === 503 ? 503 : 403,
                reason: 'approval_refused',
            };
        }
        const { approval } = (await answer.json()) as { approval: string };
        return { ok: false, status: 202, approval };
    };

    /**
     * A Socio data operation's approval: deleting through the data API
     * for a socio needs the person's approval of that exact call. A person
     * acting for themselves needs none. A socio's repeated request names
     * the approval: pass it, unused, to `dataClient(…).fetch` as
     * `approval`; Socio's data API consumes it once, for this call only.
     * Otherwise this makes (or finds) the pending approval: answer the
     * socio 202 with `{ approval }`. Mini apps only: a plugin's data routes
     * are its own, and take no approvals (it throws for a plugin).
     */
    const requestDataApproval = async <K extends DataApprovalOperation>(
        principal: Principal,
        op: K,
        params: DataApprovalInputs[K],
        display?: unknown,
    ): Promise<
        | { ok: true; approval?: string }
        | { ok: false; status: 202; approval: string }
        | { ok: false; status: 400 | 403 | 409 | 413 | 503; reason: string }
    > => {
        if (pluginId !== undefined) {
            throw new Error('A plugin’s data routes take no approvals: requestDataApproval is for mini apps.');
        }
        if (!principal.socio) {
            return { ok: true };
        }
        const held = new Set(principal.socio.scopes.flatMap((scope) => IMPLIED[scope] ?? []));
        if (!held.has('app:act')) {
            return { ok: false, status: 403, reason: 'scope_insufficient' };
        }
        if (principal.approval) {
            return { ok: true, approval: principal.approval };
        }
        const action = `data:${op}`;
        const shaped = dataApprovalParams(op, params);
        const answer = await call('/approvals', principal, {
            action,
            params: shaped,
            ...(display === undefined ? {} : { display }),
            digest: intentDigest(appId, action, shaped),
        });
        if (answer.status === 202) {
            const { approval } = (await answer.json()) as { approval: string };
            return { ok: false, status: 202, approval };
        }
        const reason = ((await answer.json().catch(() => ({}))) as { reason?: string }).reason ?? 'approval_refused';
        const status = [400, 409, 413, 503].includes(answer.status) ? (answer.status as 400 | 409 | 413 | 503) : 403;
        return { ok: false, status, reason };
    };

    /**
     * The data API with the app's token and the request's `x-cb-obo`, so
     * Socio grants the intersection of the app's and the actor's rights.
     * `approval` names a socio's approval of this very call (a delete,
     * `requestDataApproval`); the data API consumes it. For a plugin, its
     * own data routes (`/api/plugins/<id>/data/…`) with its service token
     * and proof: the person, or the socio's grant at the call's tier.
     */
    const dataClient = (principal: Principal) => ({
        fetch(path: string, init: RequestInit & { approval?: string } = {}) {
            const auth = credentials();
            if (!apiUrl || !auth) {
                throw new Error('Socio’s data API is not configured for this app.');
            }
            const { approval, ...rest } = init;
            const headers = new Headers(rest.headers);
            for (const [name, value] of Object.entries(auth)) {
                headers.set(name, value);
            }
            if (principal.obo) {
                headers.set(OBO_HEADER, principal.obo);
            }
            if (approval !== undefined) {
                if (pluginId !== undefined) {
                    throw new Error('A plugin’s data routes take no approvals.');
                }
                if (!APPROVAL_ID.test(approval)) {
                    throw new Error('That is not an approval id.');
                }
                headers.set(APPROVAL_HEADER, approval);
            }
            const base =
                pluginId === undefined ? `${apiUrl}/data` : `${apiUrl}/plugins/${encodeURIComponent(pluginId)}/data`;
            return http(`${base}${path.startsWith('/') ? '' : '/'}${path}`, {
                ...rest,
                headers,
            });
        },
    });

    /**
     * Exchanges the request's `obo` for one that lasts `minutes` (never past
     * the grant), for work that outlives the request.
     */
    const continuation = async (principal: Principal, minutes: number) => {
        const answer = await call('/continuations', principal, {
            minutes,
        });
        if (!answer.ok) {
            throw new Error('Socio refused the continuation.');
        }
        return ((await answer.json()) as { continuation: string }).continuation;
    };

    /**
     * A repository extraction the person approved for this app (Socio's
     * CB-267): the files of a repository's paths at one commit, as
     * `socio-repo-extract/1` JSON. Read it during the request it was named
     * in (the principal's `obo`); a retry works for 10 minutes after the
     * first read, then never again. Mini apps only, and only with
     * `"accepts": ["repo-extract"]` in the manifest's `delegation`. The
     * contents are the repository's: treat them as untrusted input.
     */
    const extraction = async (
        principal: Principal,
        id: string,
    ): Promise<{ ok: true; extraction: RepoExtraction } | { ok: false; status: number; error: string }> => {
        if (pluginId !== undefined) {
            throw new Error('Repository extractions go to mini apps only.');
        }
        const auth = credentials();
        if (!apiUrl || !auth || !principal.obo) {
            throw new Error('Socio’s API is not configured for this app.');
        }
        if (!EXTRACTION_ID.test(id)) {
            throw new Error('That is not an extraction id.');
        }
        const answer = await http(`${apiUrl}/apps/actor/extractions/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: { ...auth, [OBO_HEADER]: principal.obo },
        });
        if (!answer.ok) {
            const body = (await answer.json().catch(() => ({}))) as {
                error?: unknown;
            };
            return {
                ok: false,
                status: answer.status,
                error: typeof body.error === 'string' ? body.error : 'Socio refused the read.',
            };
        }
        return { ok: true, extraction: (await answer.json()) as RepoExtraction };
    };

    /**
     * The backup side (CB-458): `serve` answers the host's snapshot and
     * restore protocol; the adapters below route the host's `/__cb/backup/*`
     * and `/__cb/restore/*` requests to it, and hold writes while a
     * snapshot asks them to.
     */
    const backup = backupSide({ pluginId, verify, apiUrl, credentials, fetch: http, now, env });

    const refusal = (status: number) =>
        status === 401 ? 'Sign in through Socio to use this app.' : 'This access doesn’t allow that.';
    const HELD_TEXT = {
        writes_held: 'This plugin is taking a backup. Try again in a few seconds.',
        restoring: 'This plugin is restoring a backup.',
    };
    /** The backup side's answer before the app sees a request, if it has one. */
    const backupRefusal = (server: BackupServer | undefined, method: string, target: string) =>
        server?.refusal(method, target, isPublic(target));
    /** Whether a verified request is the host's call to the SDK's own routes. */
    const isHostRoute = (server: BackupServer | undefined, principal: Principal | undefined, target: string) =>
        !!server && principal?.access === 'host' && isBackupRoute(pathOf(target));

    // ---- adapters ------------------------------------------------------------
    /** A fetch handler (Bun.serve, Deno, workers) behind the envelope. */
    const fetchHandler =
        (handler: (request: Request, principal: Principal | undefined) => Response | Promise<Response>) =>
        async (request: Request) => {
            const target = targetOf(request.url);
            const server = backup.server;
            const held = backupRefusal(server, request.method, target);
            if (held) {
                return new Response(HELD_TEXT[held.reason], {
                    status: held.status,
                    headers: { 'retry-after': String(held.retryAfter) },
                });
            }
            let principal: Principal | undefined;
            if (!isPublic(target)) {
                const verdict = verify({
                    method: request.method,
                    target,
                    header: request.headers.get(ACTOR_ENVELOPE_HEADER),
                    approval: request.headers.get(APPROVAL_HEADER),
                });
                if (!verdict.ok) {
                    return new Response(refusal(verdict.status), {
                        status: verdict.status,
                    });
                }
                principal = verdict.principal;
                if (server && isHostRoute(server, principal, target)) {
                    return server.route(request);
                }
            }
            const leave = server?.enter(request.method, target);
            try {
                return await handler(request, principal);
            } finally {
                leave?.();
            }
        };

    interface HonoLike {
        req: { raw: Request };
        set(key: 'actor', value: Principal): void;
        get(key: 'actor'): Principal | undefined;
        text(body: string, status: number): Response;
    }
    /** Hono: `requirePrincipal()` sets `c.get('actor')`; `authorize(action)`. */
    const hono = () => ({
        requirePrincipal: () => async (c: HonoLike, next: () => Promise<void>) => {
            const target = targetOf(c.req.raw.url);
            const server = backup.server;
            const held = backupRefusal(server, c.req.raw.method, target);
            if (held) {
                return new Response(HELD_TEXT[held.reason], {
                    status: held.status,
                    headers: { 'retry-after': String(held.retryAfter) },
                });
            }
            if (!isPublic(target)) {
                const verdict = verify({
                    method: c.req.raw.method,
                    target,
                    header: c.req.raw.headers.get(ACTOR_ENVELOPE_HEADER),
                    approval: c.req.raw.headers.get(APPROVAL_HEADER),
                });
                if (!verdict.ok) {
                    return c.text(refusal(verdict.status), verdict.status);
                }
                if (server && isHostRoute(server, verdict.principal, target)) {
                    return server.route(c.req.raw);
                }
                c.set('actor', verdict.principal);
            }
            const leave = server?.enter(c.req.raw.method, target);
            try {
                await next();
            } finally {
                leave?.();
            }
        },
        authorize: (action: string) => async (c: HonoLike, next: () => Promise<void>) => {
            const principal = c.get('actor');
            if (!principal) {
                return c.text(refusal(401), 401);
            }
            const allowed = authorize(principal, action);
            if (!allowed.ok) {
                return c.text(refusal(403), 403);
            }
            await next();
        },
    });

    interface NodeRequestLike {
        method?: string;
        url?: string;
        originalUrl?: string;
        headers: Record<string, string | string[] | undefined>;
        actor?: Principal;
    }
    interface NodeResponseLike {
        writeHead(status: number, headers?: Record<string, string>): unknown;
        end(body?: string): unknown;
        /** A real `ServerResponse` has it: the SDK counts a write in flight until `close`. */
        once?(event: 'close', listener: () => void): unknown;
    }
    const header = (request: NodeRequestLike, name: string) => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : undefined;
    };
    /** Verifies a Node request by its raw request-target (`originalUrl` in Express). */
    const verifyNode = (request: NodeRequestLike) => {
        const target = request.originalUrl ?? request.url ?? '/';
        if (isPublic(target)) {
            return undefined;
        }
        return verify({
            method: request.method ?? 'GET',
            target,
            header: header(request, ACTOR_ENVELOPE_HEADER),
            approval: header(request, APPROVAL_HEADER),
        });
    };
    const refuse = (response: NodeResponseLike, status: number) => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(refusal(status));
    };
    /**
     * The backup side's part of a Node request (CB-458): true when it
     * answered (held writes, restore mode, or the host's own route), else
     * it counts a writing request in flight and lets it through.
     */
    const backupNode = (request: NodeRequestLike, response: NodeResponseLike, principal: Principal | undefined) => {
        const server = backup.server;
        if (!server) {
            return false;
        }
        const method = request.method ?? 'GET';
        const target = request.originalUrl ?? request.url ?? '/';
        if (isHostRoute(server, principal, target)) {
            void server
                .route(toWebRequest(request as unknown as IncomingMessage, target))
                .then((answer) => sendWebResponse(response as unknown as ServerResponse, answer))
                .catch(() => response.end());
            return true;
        }
        const leave = server.enter(method, target);
        if (response.once) {
            response.once('close', leave);
        } else {
            leave();
        }
        return false;
    };
    /** 503 before verifying, while writes are held or a restore runs. */
    const heldNode = (request: NodeRequestLike, response: NodeResponseLike) => {
        const held = backupRefusal(backup.server, request.method ?? 'GET', request.originalUrl ?? request.url ?? '/');
        if (!held) {
            return false;
        }
        response.writeHead(held.status, {
            'content-type': 'text/plain; charset=utf-8',
            'retry-after': String(held.retryAfter),
        });
        response.end(HELD_TEXT[held.reason]);
        return true;
    };
    /** Express: `requirePrincipal` sets `req.actor`; `authorize(action)`. */
    const express = () => ({
        requirePrincipal: (request: NodeRequestLike, response: NodeResponseLike, next: () => void) => {
            if (heldNode(request, response)) {
                return;
            }
            const verdict = verifyNode(request);
            if (verdict && !verdict.ok) {
                return refuse(response, verdict.status);
            }
            if (backupNode(request, response, verdict?.principal)) {
                return;
            }
            if (verdict) {
                request.actor = verdict.principal;
            }
            next();
        },
        authorize: (action: string) => (request: NodeRequestLike, response: NodeResponseLike, next: () => void) => {
            if (!request.actor) {
                return refuse(response, 401);
            }
            if (!authorize(request.actor, action).ok) {
                return refuse(response, 403);
            }
            next();
        },
    });
    /** Plain `node:http`: the handler gets the principal (undefined on public paths). */
    const node =
        <Req extends NodeRequestLike, Res extends NodeResponseLike>(
            handler: (request: Req, response: Res, principal?: Principal) => unknown,
        ) =>
        (request: Req, response: Res) => {
            if (heldNode(request, response)) {
                return;
            }
            const verdict = verifyNode(request);
            if (verdict && !verdict.ok) {
                return refuse(response, verdict.status);
            }
            if (backupNode(request, response, verdict?.principal)) {
                return;
            }
            return handler(request, response, verdict?.principal);
        };

    /**
     * Socio Secrets (phase 1, workspace apps): `get`, `require` and
     * `onRotate`, cached in memory until each value's `expiresAt`.
     */
    const secrets = secretsClient({ apiUrl, credentials, fetch: http, now, pluginId });

    return {
        appId,
        secrets,
        /**
         * Workspace backups (CB-458): `serve({ volumes, schemaVersion })`,
         * `request({ reason })`, `restored` and `onRelease`. See the README,
         * "Backups".
         */
        backup,
        /** The plugin's id when `appId` is `plugin:<id>`. */
        pluginId,
        isPublic,
        verify,
        authorize,
        requireApproval,
        requestDataApproval,
        dataClient,
        continuation,
        extraction,
        intentDigest: (action: string, params: unknown) => intentDigest(appId, action, params),
        fetchHandler,
        hono,
        express,
        node,
    };
}

export type SocioApp = ReturnType<typeof socioApp>;
