import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

import {
    ACTOR_ENVELOPE_HEADER,
    ENVELOPE_TTL_MS,
    envelopeKeyFrom,
    newJti,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from './envelope.js';
import {
    APPROVAL_HEADER,
    intentDigest,
    OBO_HEADER,
    PLUGIN_PREFIX,
    PLUGIN_PROOF_HEADER,
    targetOf,
    type ActionTier,
} from './index.js';

/**
 * The contract test kit, `@socio/app-sdk/check` (CB-232): what an
 * app's CI runs to show the app keeps the delegation contract. It drives
 * the app's own fetch handler (or a loopback URL) with envelopes minted by
 * the real codec, for a person and for socios with each scope, and checks
 * the app refuses what it must: no envelope, a forged or foreign one, the
 * wrong audience, time, method or request-target, a replayed `jti`, a
 * public path reached through dot segments or encoded slashes, a socio
 * past its scope (by tier, never by HTTP method), any socio or Space member
 * on an `admin` action, and a consequential action without a consumed
 * approval for these exact parameters.
 *
 * The approval checks need the app to call a fake Socio: `fakeSocio()`
 * answers `/api/apps/actor/approvals` and `…/:id/consume` the way Socio's
 * routes do, in process (`socio.fetch`, `socio.apiUrl`) or on loopback
 * (`socio.listen()`). Point the app's `socioApp({ apiUrl, fetch })` at it.
 *
 * A service plugin is checked the same way with `appId: 'plugin:<id>'`
 * (CB-232): envelopes for that audience, and the fake answers the
 * plugin's routes (`/api/plugins/<id>/actor/approvals`, `…/consume`) and
 * wants its service token and proof.
 *
 * Test-runner agnostic: `checkContract` returns named results;
 * `assertContract` throws with a readable summary when one fails.
 */

export type FetchHandler = (request: Request) => Response | Promise<Response>;

/** Who an envelope is for: a person (by access) or a socio (by scope). */
export type TestActor = 'owner' | 'space' | 'app:read' | 'app:write' | 'app:act';

const SOCIO_SCOPES: Record<string, string[]> = {
    'app:read': ['app:read'],
    'app:write': ['app:write', 'app:read'],
    'app:act': ['app:act', 'app:write', 'app:read'],
};

export interface TestEnvelopeOptions {
    appId: string;
    /** The app's `CB_ACTOR_KEY` in its test environment (base64url), or bytes. */
    key: string | Uint8Array;
    actor: TestActor;
    method: string;
    /** The request-target exactly as the app will see it: path and query. */
    target: string;
    /** Epoch ms; `Date.now()` by default. */
    now?: number;
    /** The `cbob_` the app passes back to Socio; a placeholder by default. */
    obo?: string;
    /** The socio's grant id (socios only). */
    grant?: string;
    /** Claims to override after the defaults (for negative tests). */
    claims?: Partial<EnvelopeClaims>;
}

/** The claims Socio's proxy would put in an envelope for this request. */
export function testClaims(options: Omit<TestEnvelopeOptions, 'key'>): EnvelopeClaims {
    const now = options.now ?? Date.now();
    const socio = SOCIO_SCOPES[options.actor];
    return {
        aud: options.appId,
        sub: options.actor === 'space' ? 'check-member-000001' : 'check-owner-0000001',
        acc: options.actor === 'space' ? 'space' : 'owner',
        ...(socio
            ? {
                  act: {
                      typ: 'socio' as const,
                      id: 'check-socio-0000001',
                      grant: options.grant ?? 'check-grant-0000001',
                  },
                  scp: [...socio],
              }
            : {}),
        sid: 'check-session-000001',
        obo: options.obo ?? 'cbob_check.placeholder',
        req: {
            m: options.method.toUpperCase(),
            p: requestTargetHash(options.target),
        },
        iat: now,
        exp: now + ENVELOPE_TTL_MS,
        jti: newJti(),
        // A plugin's envelope names no app version.
        ver: options.appId.startsWith(PLUGIN_PREFIX) ? null : 1,
        ...options.claims,
    };
}

/**
 * An `x-cb-actor` header for an app's own tests, signed with the real
 * codec: what Socio's proxy sends for that person or socio and request.
 */
export function mintTestEnvelope(options: TestEnvelopeOptions) {
    const key = typeof options.key === 'string' ? envelopeKeyFrom(options.key) : options.key;
    if (!key) {
        throw new Error('mintTestEnvelope: the key is 32 bytes, base64url.');
    }
    return signEnvelope(key, testClaims(options));
}

// ---- the fake Socio ---------------------------------------------------------

export interface FakeApproval {
    id: string;
    action: string;
    params: unknown;
    display?: unknown;
    digest: string;
    grant: string;
    status: 'pending' | 'approved' | 'denied';
    consumed: boolean;
}

export interface FakeSocioCall {
    method: string;
    path: string;
    obo: string | null;
    authorized: boolean;
    body: unknown;
    status: number;
}

export interface FakeSocioOptions {
    /** The app's id, or a plugin's `plugin:<id>`. */
    appId: string;
    /**
     * A plugin's proof (`CB_PLUGIN_PROOF` in its tests): the fake then wants
     * exactly it. Without it, any non-empty proof passes. Plugins only.
     */
    pluginProof?: string;
    /** The manifest's `delegation.actions`, to refuse a non-consequential ask. */
    actions?: Record<string, ActionTier>;
    /** Answers every other call (the data API); 404 by default. */
    data?: FetchHandler;
}

/**
 * The data API of a running data test harness (CB-476, `docs/DATA-TEST-HARNESS.md`)
 * as `fakeSocio({ data })` takes it: each call goes to `origin` with the
 * same method, path, query, headers and body. `origin` is what the harness
 * prints (`http://127.0.0.1:<port>`). In this repository's own tests, pass
 * the in-process harness's `handle` instead.
 */
export function harnessData(origin: string, http: typeof fetch = fetch): FetchHandler {
    const base = new URL(origin);
    return async (request) => {
        const url = new URL(request.url);
        const target = new URL(`${url.pathname}${url.search}`, base);
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        const response = await http(target, { method: request.method, headers: request.headers, body });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    };
}

/** Socio's approvals route for an app, or for a plugin (`plugin:<id>`). */
export function approvalsPath(appId: string) {
    return appId.startsWith(PLUGIN_PREFIX)
        ? `/api/plugins/${encodeURIComponent(appId.slice(PLUGIN_PREFIX.length))}/actor/approvals`
        : '/api/apps/actor/approvals';
}

/**
 * A fake of Socio's approval routes for the contract kit and an app's own
 * tests. For a plugin (`appId: 'plugin:<id>'`) it serves the plugin's
 * routes instead, wants the service token and `x-cb-plugin-proof` (401
 * without them, as Socio), and refuses a `data:` action (400). It answers like Socio (CB-232): `POST
 * /api/apps/actor/approvals` creates or finds the pending approval for the
 * grant and digest and answers 202 `{ approval, status, expiresAt, digest }`;
 * `POST /api/apps/actor/approvals/:id/consume` answers 200 once for an
 * approved approval with the same digest and grant, else 409. The grant
 * comes from the request's `x-cb-obo` (registered with `actor`), never from
 * the body. `approve` and `deny` stand in for the person's click.
 */
export function fakeSocio(options: FakeSocioOptions) {
    let base = 'http://socio.check.invalid';
    const actors = new Map<string, { grant?: string; scopes: string[] }>();
    const approvals = new Map<string, FakeApproval>();
    const calls: FakeSocioCall[] = [];
    let next = 0;

    const answer = (status: number, body: unknown) => Response.json(body, { status });

    const plugin = options.appId.startsWith(PLUGIN_PREFIX);
    const asksAt = approvalsPath(options.appId);
    const route = async (request: Request, record: FakeSocioCall) => {
        const path = new URL(request.url).pathname;
        const consume =
            path.startsWith(`${asksAt}/`) && path.endsWith('/consume')
                ? /^([^/]+)\/consume$/.exec(path.slice(asksAt.length + 1))
                : null;
        if (request.method !== 'POST' || (path !== asksAt && !consume)) {
            if (options.data) {
                return options.data(request);
            }
            return answer(404, { error: 'The fake Socio serves approvals only.' });
        }
        const body = (record.body = await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!record.authorized) {
            return answer(401, {
                error: plugin ? 'The plugin’s service token or proof is missing.' : 'The app’s data token is missing.',
            });
        }
        const actor = record.obo ? actors.get(record.obo) : undefined;
        if (!actor) {
            return answer(403, { error: 'Unknown x-cb-obo.' });
        }
        if (!actor.grant) {
            return answer(400, {
                error: 'A person acts for themselves: approvals are for socios.',
            });
        }
        if (!body || typeof body !== 'object') {
            return answer(400, { error: 'Send JSON.' });
        }
        if (consume) {
            const found = approvals.get(decodeURIComponent(consume[1]));
            const usable =
                found &&
                found.status === 'approved' &&
                !found.consumed &&
                found.grant === actor.grant &&
                found.digest === body.digest;
            if (!found || !usable) {
                return answer(409, { error: 'That approval can’t be used.' });
            }
            found.consumed = true;
            return answer(200, { ok: true, approval: found.id });
        }
        const action = body.action;
        if (typeof action !== 'string') {
            return answer(400, { error: 'Send { action, params, display? }.' });
        }
        if (plugin && action.startsWith('data:')) {
            return answer(400, {
                error: 'data:<op> approvals are for mini apps.',
                reason: 'request_malformed',
            });
        }
        const params = body.params ?? null;
        let digest: string;
        try {
            digest = intentDigest(options.appId, action, params);
        } catch {
            return answer(400, { error: 'The parameters are not JSON.' });
        }
        if (body.digest !== undefined && body.digest !== digest) {
            return answer(400, {
                error: 'The digest doesn’t match the parameters.',
            });
        }
        const consequential =
            action.startsWith('data:') ||
            (Object.hasOwn(options.actions ?? {}, action) && options.actions?.[action] === 'consequential');
        if (!consequential) {
            return answer(400, {
                error: 'Not a consequential action.',
                reason: 'not_consequential',
            });
        }
        if (!actor.scopes.includes('app:act')) {
            return answer(403, { error: 'The grant has no app:act.' });
        }
        let found = [...approvals.values()].find(
            (item) => item.digest === digest && item.grant === actor.grant && item.status === 'pending',
        );
        if (!found) {
            found = {
                id: `check-approval-${++next}`,
                action,
                params,
                ...(body.display === undefined ? {} : { display: body.display }),
                digest,
                grant: actor.grant,
                status: 'pending',
                consumed: false,
            };
            approvals.set(found.id, found);
        }
        return answer(202, {
            approval: found.id,
            status: found.status,
            expiresAt: Date.now() + 15 * 60_000,
            digest,
        });
    };

    const handle = async (request: Request) => {
        const record: FakeSocioCall = {
            method: request.method,
            path: new URL(request.url).pathname,
            obo: request.headers.get(OBO_HEADER),
            authorized:
                /^Bearer \S+$/.test(request.headers.get('authorization') ?? '') &&
                (!plugin ||
                    (options.pluginProof === undefined
                        ? !!request.headers.get(PLUGIN_PROOF_HEADER)
                        : request.headers.get(PLUGIN_PROOF_HEADER) === options.pluginProof)),
            body: undefined,
            status: 0,
        };
        calls.push(record);
        const response = await route(request, record);
        record.status = response.status;
        return response;
    };

    const decide = (id: string, status: 'approved' | 'denied') => {
        const found = approvals.get(id);
        if (!found || found.status !== 'pending') {
            throw new Error(`fakeSocio: no pending approval ${id}.`);
        }
        found.status = status;
    };

    return {
        /** Socio's `/api` base, for `socioApp({ apiUrl })`. */
        get apiUrl() {
            return `${base}/api`;
        },
        /** An in-process `fetch`, for `socioApp({ fetch })`. */
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
            handle(new Request(input, init))) as typeof fetch,
        handle,
        calls,
        approvals,
        /** Says which person or socio grant a `cbob_` stands for. */
        actor(obo: string, actor: { grant?: string; scopes?: string[] }) {
            actors.set(obo, { grant: actor.grant, scopes: actor.scopes ?? [] });
        },
        /** The person clicks Allow. */
        approve: (id: string) => decide(id, 'approved'),
        /** The person clicks Deny. */
        deny: (id: string) => decide(id, 'denied'),
        /**
         * Serves the fake on loopback (for an app the kit reaches by URL);
         * `apiUrl` then names that address.
         */
        async listen() {
            const server = createServer(async (incoming, outgoing) => {
                const response = await handle(await toRequest(incoming, base));
                outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
                outgoing.end(Buffer.from(await response.arrayBuffer()));
            });
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            return {
                apiUrl: `${base}/api`,
                close: () => new Promise<void>((resolve) => server.close(() => resolve())),
            };
        },
    };
}

export type FakeSocio = ReturnType<typeof fakeSocio>;

async function toRequest(incoming: IncomingMessage, base: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
        chunks.push(chunk as Buffer);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') {
            headers.set(name, value);
        }
    }
    return new Request(`${base}${incoming.url ?? '/'}`, {
        method: incoming.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
}

// ---- the checks -------------------------------------------------------------

export interface ContractRoute {
    method: string;
    /** The request-target: path and query, e.g. `/deals/42?view=full`. */
    path: string;
    /** The manifest action this route runs. */
    action: string;
    /** The request body: a string as is, anything else as JSON. */
    body?: unknown;
    /**
     * For a consequential route: a body with other parameters, to show an
     * approval for one set doesn't run another. Derived from `body` when
     * omitted (its first string, number or boolean, changed).
     */
    changedBody?: unknown;
    headers?: Record<string, string>;
    /**
     * How many times the action has run, if the app's tests can tell: the
     * kit then also checks that every refusal ran nothing.
     */
    performed?: () => number | Promise<number>;
}

export interface ContractCheckOptions {
    appId: string;
    /** The app's `CB_ACTOR_KEY` in its test environment (base64url). */
    key: string;
    /** The manifest's `delegation` block (`actions`, `public`). */
    delegation: {
        actions: Record<string, ActionTier>;
        public?: readonly string[];
    };
    /** The app's routes: the kit can't guess which action a route runs. */
    routes: readonly ContractRoute[];
    /** The app: its fetch handler, or the base URL it listens on. */
    app?: FetchHandler | string;
    /**
     * Or a function that makes the app with the kit's fake Socio, so its
     * approvals reach the fake: `socioApp({ apiUrl: socio.apiUrl, fetch:
     * socio.fetch, … })`.
     */
    start?: (socio: FakeSocio) => FetchHandler | string | Promise<FetchHandler | string>;
    /** A fake Socio the app was already pointed at (`fakeSocio()`). */
    socio?: FakeSocio;
    /** The clock the app uses; `Date.now` by default. */
    now?: () => number;
}

export interface CheckResult {
    /** A stable name, e.g. `envelope.replayed`, `tier.admin-socio`. */
    name: string;
    ok: boolean;
    /** `METHOD /path` of the route it ran on, if any. */
    route?: string;
    detail: string;
}

export interface ContractReport {
    ok: boolean;
    results: CheckResult[];
    failed: CheckResult[];
    summary(): string;
}

interface Sent {
    status: number;
    text: string;
}

const allowed = (status: number) => status >= 200 && status < 400;

/** The app's transport: a fetch handler in process, or raw HTTP to a URL. */
function transport(app: FetchHandler | string) {
    if (typeof app !== 'string') {
        const origin = 'http://app.check.invalid';
        return {
            // A fetch Request's URL is parsed, so the app sees the parsed form.
            wire: (target: string) => targetOf(new URL(target, origin).href),
            async send(method: string, target: string, headers: Record<string, string>, body?: string): Promise<Sent> {
                try {
                    const response = await app(
                        new Request(`${origin}${target}`, {
                            method,
                            headers,
                            ...(body === undefined ? {} : { body }),
                        }),
                    );
                    return { status: response.status, text: await response.text() };
                } catch (error) {
                    // What a server answers when its handler throws.
                    return { status: 500, text: String(error) };
                }
            },
        };
    }
    const url = new URL(app);
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return {
        // Over HTTP the kit sends the request-target as written, unparsed.
        wire: (target: string) => target,
        send(method: string, target: string, headers: Record<string, string>, body?: string) {
            return new Promise<Sent>((resolve, reject) => {
                const outgoing = request(
                    {
                        hostname: url.hostname,
                        port: url.port || undefined,
                        method,
                        path: target,
                        headers: {
                            ...headers,
                            ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
                        },
                    },
                    (incoming) => {
                        const chunks: Buffer[] = [];
                        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
                        incoming.on('end', () =>
                            resolve({
                                status: incoming.statusCode ?? 0,
                                text: Buffer.concat(chunks).toString('utf8'),
                            }),
                        );
                        incoming.on('error', reject);
                    },
                );
                outgoing.on('error', reject);
                outgoing.end(body);
            });
        },
    };
}

/** The body with its first primitive changed, or undefined. */
function changed(body: unknown): unknown {
    if (typeof body === 'string') {
        return `${body} (changed)`;
    }
    if (typeof body === 'number') {
        return body + 1;
    }
    if (typeof body === 'boolean') {
        return !body;
    }
    if (Array.isArray(body)) {
        for (const [index, item] of body.entries()) {
            const next = changed(item);
            if (next !== undefined) {
                return body.map((value, i) => (i === index ? next : value));
            }
        }
    } else if (body && typeof body === 'object') {
        for (const [name, item] of Object.entries(body)) {
            const next = changed(item);
            if (next !== undefined) {
                return { ...body, [name]: next };
            }
        }
    }
    return undefined;
}

const label = (route: ContractRoute) => `${route.method.toUpperCase()} ${route.path}`;

/**
 * Runs the contract checks against an app and returns every result. Each
 * check sends real envelopes; the controls (an owner on every route, a
 * socio within its scope) make sure a refusal is the app's judgment, not a
 * route the kit got wrong.
 */
export async function checkContract(options: ContractCheckOptions): Promise<ContractReport> {
    if (!options.app === !options.start) {
        throw new Error('checkContract: give `app` or `start`, not both.');
    }
    if (!options.routes.length) {
        throw new Error('checkContract: list the app’s routes.');
    }
    const key = envelopeKeyFrom(options.key);
    if (!key) {
        throw new Error('checkContract: the key is 32 bytes, base64url.');
    }
    const socio = options.socio ?? fakeSocio({ appId: options.appId, actions: options.delegation.actions });
    const app = options.app ?? (await options.start!(socio));
    const { wire, send } = transport(app);
    const now = options.now ?? Date.now;
    const actions = options.delegation.actions;
    const publicPaths = options.delegation.public ?? [];
    const results: CheckResult[] = [];
    const record = (name: string, ok: boolean, detail: string, route?: ContractRoute) =>
        results.push({
            name,
            ok,
            detail,
            ...(route ? { route: label(route) } : {}),
        });

    let serial = 0;
    /** An envelope for `actor`; its `cbob_` is registered with the fake. */
    const envelope = (
        actor: TestActor,
        method: string,
        target: string,
        over: {
            grant?: string;
            claims?: Partial<EnvelopeClaims>;
            key?: Uint8Array;
        } = {},
    ) => {
        const obo = `cbob_check.${++serial}`;
        const grant = SOCIO_SCOPES[actor] ? (over.grant ?? 'check-grant-0000001') : undefined;
        socio.actor(obo, { grant, scopes: SOCIO_SCOPES[actor] ?? [] });
        return signEnvelope(
            over.key ?? key,
            testClaims({
                appId: options.appId,
                actor,
                method,
                target: wire(target),
                now: now(),
                obo,
                grant,
                claims: over.claims,
            }),
        );
    };
    const body = (route: ContractRoute, value = route.body) =>
        value === undefined || typeof value === 'string' ? (value as string | undefined) : JSON.stringify(value);
    const call = (
        route: ContractRoute,
        header: string | undefined,
        over: {
            method?: string;
            target?: string;
            approval?: string;
            body?: unknown;
        } = {},
    ) => {
        const method = (over.method ?? route.method).toUpperCase();
        const payload =
            method === 'GET' || method === 'HEAD' ? undefined : body(route, 'body' in over ? over.body : route.body);
        return send(
            method,
            over.target ?? route.path,
            {
                ...(payload !== undefined && typeof route.body !== 'string'
                    ? { 'content-type': 'application/json' }
                    : {}),
                ...route.headers,
                ...(header ? { [ACTOR_ENVELOPE_HEADER]: header } : {}),
                ...(over.approval ? { [APPROVAL_HEADER]: over.approval } : {}),
            },
            payload,
        );
    };
    /** One request as `actor` on `route`. */
    const as = (
        actor: TestActor,
        route: ContractRoute,
        over: {
            method?: string;
            approval?: string;
            body?: unknown;
            grant?: string;
        } = {},
    ) =>
        call(
            route,
            envelope(actor, over.method ?? route.method, route.path, {
                grant: over.grant,
            }),
            over,
        );
    const tierOf = (route: ContractRoute) => (Object.hasOwn(actions, route.action) ? actions[route.action] : undefined);
    const count = async (route: ContractRoute) => (route.performed ? await route.performed() : undefined);

    for (const route of options.routes) {
        if (!tierOf(route)) {
            record('routes.declared', false, `"${route.action}" isn’t in delegation.actions.`, route);
        }
    }

    // ---- envelope: every route -------------------------------------------------
    for (const route of options.routes) {
        const owner = await as('owner', route);
        record(
            'control.owner',
            allowed(owner.status),
            `the owner got ${owner.status}; expected the route to serve them (2xx/3xx). Check the route map and body.`,
            route,
        );
        const missing = await call(route, undefined);
        record('envelope.missing', missing.status === 401, `no envelope got ${missing.status}, expected 401.`, route);
        // Signed for a Space member, then the claims swapped for the owner's.
        const signed = envelope('space', route.method, route.path);
        const forged = `v1.${Buffer.from(
            JSON.stringify(
                testClaims({
                    appId: options.appId,
                    actor: 'owner',
                    method: route.method,
                    target: wire(route.path),
                    now: now(),
                }),
            ),
        ).toString('base64url')}.${signed.split('.')[2]}`;
        const tampered = await call(route, forged);
        record(
            'envelope.forged',
            tampered.status === 401,
            `claims changed after signing got ${tampered.status}, expected 401.`,
            route,
        );
    }

    // ---- envelope: one probe route ----------------------------------------------
    const probe = options.routes[0];
    const probeCheck = async (name: string, header: string, what: string, over: { method?: string } = {}) => {
        const sent = await call(probe, header, over);
        record(name, sent.status === 401, `${what} got ${sent.status}, expected 401.`, probe);
    };
    const t = now();
    await probeCheck(
        'envelope.wrong-key',
        envelope('owner', probe.method, probe.path, { key: randomBytes(32) }),
        'an envelope under another key',
    );
    await probeCheck(
        'envelope.wrong-audience',
        envelope('owner', probe.method, probe.path, {
            claims: { aud: `${options.appId}-other` },
        }),
        'an envelope for another app',
    );
    await probeCheck(
        'envelope.expired',
        envelope('owner', probe.method, probe.path, {
            claims: { iat: t - 2 * ENVELOPE_TTL_MS, exp: t - ENVELOPE_TTL_MS },
        }),
        'an envelope that expired a minute ago',
    );
    await probeCheck(
        'envelope.future',
        envelope('owner', probe.method, probe.path, {
            claims: { iat: t + 30_000, exp: t + 30_000 + ENVELOPE_TTL_MS },
        }),
        'an envelope issued 30 s in the future',
    );
    const otherMethod = probe.method.toUpperCase() === 'POST' ? 'PUT' : 'POST';
    await probeCheck(
        'envelope.other-method',
        envelope('owner', otherMethod, probe.path),
        `an envelope for ${otherMethod}`,
    );
    await probeCheck(
        'envelope.other-target',
        envelope('owner', probe.method, '/socio-check/another-target'),
        'an envelope for another request-target',
    );
    const once = envelope('owner', probe.method, probe.path);
    const first = await call(probe, once);
    const second = await call(probe, once);
    record(
        'envelope.replayed',
        allowed(first.status) && second.status === 401,
        allowed(first.status)
            ? `the same jti a second time got ${second.status}, expected 401.`
            : `the first use got ${first.status}, so replay can’t be tested.`,
        probe,
    );

    // ---- public paths -------------------------------------------------------------
    const inside = pathOf(probe.path).replace(/^\//, '');
    for (const entry of publicPaths) {
        const served = await send('GET', entry.endsWith('/') ? `${entry}socio-check` : entry, {});
        record(
            'public.served',
            served.status !== 401 && served.status !== 403,
            `${entry} without an envelope got ${served.status}; a public path is served without one.`,
        );
        const stem = entry.endsWith('/') ? entry : `${entry}/`;
        for (const variant of [
            `${stem}../${inside}`,
            `${stem}%2e%2e/${inside}`,
            `${stem}..%2f${inside}`,
            `${stem}%2E%2E%2F${inside}`,
            `${stem}..%5c${inside}`,
            `${entry.replace(/\/$/, '')}%2f..%2f${inside}`,
        ]) {
            const sent = await send('GET', variant, {});
            record(
                'public.normalised',
                sent.status === 401,
                `${variant} without an envelope got ${sent.status}, expected 401: it isn’t the public path once normalised.`,
            );
        }
    }

    // ---- tiers: by the manifest, never by method --------------------------------
    const expectRefused = async (
        name: string,
        route: ContractRoute,
        actor: TestActor,
        what: string,
        over: { method?: string } = {},
    ) => {
        const before = await count(route);
        const sent = await as(actor, route, over);
        const after = await count(route);
        const ran = before !== undefined && after !== before;
        record(
            name,
            sent.status === 403 && !ran,
            ran ? `${what} ran the action (status ${sent.status}).` : `${what} got ${sent.status}, expected 403.`,
            route,
        );
    };
    for (const route of options.routes) {
        const tier = tierOf(route);
        const method = route.method.toUpperCase();
        if (tier === 'read') {
            const read = await as('app:read', route);
            record(
                'control.socio-read',
                allowed(read.status),
                `a read-only socio got ${read.status} on a read action; expected it served.`,
                route,
            );
        }
        if (tier === 'write') {
            const write = await as('app:write', route);
            record(
                'control.socio-write',
                allowed(write.status),
                `a socio with app:write got ${write.status} on a write action; expected it served.`,
                route,
            );
        }
        if (tier === 'write' || tier === 'consequential') {
            await expectRefused('tier.read-only-socio', route, 'app:read', `a read-only socio on a ${tier} action`);
            if (method !== 'GET') {
                // Reached with GET: an app that authorizes by method lets it by.
                const before = await count(route);
                const sent = await as('app:read', route, { method: 'GET' });
                const after = await count(route);
                const ran = before !== undefined && after !== before;
                record(
                    'tier.read-only-socio-get',
                    !allowed(sent.status) && !ran,
                    `a read-only socio sending GET to a ${tier} route got ${sent.status}${ran ? ' and ran it' : ''}; expected a refusal (403, or 404/405 when the route has no GET).`,
                    route,
                );
            }
        }
        if (tier === 'consequential') {
            await expectRefused(
                'tier.write-socio-consequential',
                route,
                'app:write',
                'a socio without app:act on a consequential action',
            );
        }
        if (tier === 'admin') {
            await expectRefused('tier.admin-socio', route, 'app:act', 'a socio (with every scope) on an admin action');
            await expectRefused('tier.admin-space', route, 'space', 'a Space member on an admin action');
        }
    }

    // ---- approvals ------------------------------------------------------------------
    for (const route of options.routes) {
        if (tierOf(route) !== 'consequential') {
            continue;
        }
        const asked = socio.calls.length;
        const first = await as('app:act', route);
        let approval: string | undefined;
        try {
            const parsed = JSON.parse(first.text) as { approval?: unknown };
            if (typeof parsed.approval === 'string') {
                approval = parsed.approval;
            }
        } catch {
            // Not JSON: no approval id.
        }
        const made = approval ? socio.approvals.get(approval) : undefined;
        const asks = socio.calls.slice(asked).filter((item) => item.path === approvalsPath(options.appId));
        record(
            'approval.requested',
            first.status === 202 && !!made && made.action === route.action,
            first.status !== 202
                ? `a socio with app:act and no approval got ${first.status}, expected 202 { approval }.${asks.length ? '' : ' The app never asked the fake Socio: point socioApp’s apiUrl and fetch at it.'}`
                : !made
                  ? `the 202 named ${JSON.stringify(approval)}, not an approval Socio made.`
                  : `the approval was asked for "${made.action}", not "${route.action}".`,
            route,
        );
        if (!made || !approval) {
            continue;
        }

        const refusedWith = async (name: string, what: string, over: { body?: unknown; grant?: string }) => {
            const before = await count(route);
            const wasConsumed = made.consumed;
            const sent = await as('app:act', route, { approval, ...over });
            const after = await count(route);
            const ran = before !== undefined && after !== before;
            const consumed = !wasConsumed && made.consumed;
            record(
                name,
                !allowed(sent.status) && !ran && !consumed,
                ran || allowed(sent.status)
                    ? `${what} got ${sent.status}${ran ? ' and ran the action' : ''}; expected a refusal.`
                    : consumed
                      ? `${what} consumed the approval.`
                      : `${what} was refused (${sent.status}).`,
                route,
            );
        };
        await refusedWith('approval.pending', 'repeating with an approval the person hasn’t decided', {});
        socio.approve(approval);
        const other = route.changedBody !== undefined ? route.changedBody : changed(route.body);
        if (other === undefined) {
            record(
                'approval.digest-change',
                false,
                'the route has no body the kit can change; give it `changedBody`.',
                route,
            );
        } else {
            await refusedWith('approval.digest-change', 'repeating with the approval and changed parameters', {
                body: other,
            });
        }
        await refusedWith('approval.other-grant', 'repeating with the approval under another grant', {
            grant: 'check-grant-0000002',
        });
        const before = await count(route);
        const used = await as('app:act', route, { approval });
        const after = await count(route);
        record(
            'approval.consumed',
            allowed(used.status) && made.consumed && (before === undefined || after === before + 1),
            !allowed(used.status)
                ? `repeating with the approved approval got ${used.status}; expected the action to run.`
                : !made.consumed
                  ? 'the action ran without consuming the approval at Socio.'
                  : `the action ran ${(after ?? 0) - (before ?? 0)} times, expected once.`,
            route,
        );
        const again = await count(route);
        const reused = await as('app:act', route, { approval });
        const last = await count(route);
        record(
            'approval.single-use',
            !allowed(reused.status) && (again === undefined || last === again),
            `using the approval a second time got ${reused.status}${again !== undefined && last !== again ? ' and ran the action' : ''}; expected a refusal.`,
            route,
        );
    }

    const failed = results.filter((result) => !result.ok);
    return {
        ok: failed.length === 0,
        results,
        failed,
        summary: () =>
            failed.length
                ? [
                      `${failed.length} of ${results.length} contract checks failed:`,
                      ...failed.map(
                          (result) =>
                              `  FAIL ${result.name}${result.route ? ` (${result.route})` : ''}: ${result.detail}`,
                      ),
                  ].join('\n')
                : `All ${results.length} contract checks passed.`,
    };
}

/** Runs `checkContract` and throws with the failures when any check fails. */
export async function assertContract(options: ContractCheckOptions) {
    const report = await checkContract(options);
    if (!report.ok) {
        throw new Error(report.summary());
    }
    return report;
}

const pathOf = (target: string) => target.split(/[?#]/, 1)[0];
