import type { SignInMethods, SignInProvider } from '@socio/shared/auth';
import { type WorkspaceManifest, WORKSPACE_MANIFEST_PATH, workspaceManifestSchema } from '@socio/shared/device-sign-in';

import { type AddressProblem, checkAddress, checkUrl, type WorkspaceAddress } from './address';
import { AbortedError, NetworkError } from './errors';
import type { PublicFetch } from './public-fetch';
import { readJson, readText } from './read-body';

// The address probe: before a
// workspace is added, `GET <origin>/api/auth/session` through publicFetch (no
// cookies, no Origin, redirects handed back) tells whether the address leads
// to a Socio workspace, and gives its name, logo and sign-in methods.
// - One redirect is followed, and only to the same path over https. Its
//   target must pass the build's address rules too, so the workspace's origin
//   is where it ends: the origin every later request is pinned to.
// - Only a 200 JSON answer with a string `provider` and `branding.name` is a
//   workspace, as the server's sign-in view gives it
//   (src/server/auth/sign-in-view.ts). Its edge turns away a Host that isn't
//   its own with a 403 "Unrecognized host." (composition/http/edge.ts).
// - An origin already on the phone is reported as known, before any request
//   to it, so the screen opens that workspace instead of adding it again.
// It asks only the address it was given, and the registry only about that
// origin: nothing lists workspaces, and nothing signs anyone up.
//
// The workspace manifest (`/.well-known/socio/workspace`) is read
// first, at the typed origin, then at the redirect's target if the session
// probe moved there. It gives the workspace's own id, its server's version and
// its lease policy; the session view still gives the sign-in methods the
// screens word ("Forgot password?"), which the manifest hasn't. `signUp` is
// read into the shared type but the app never uses it: no sign-up is offered. A server with no manifest (today's: a 404, or the web's page) is
// probed as before, with `manifest: null`; only no answer at all ends the
// probe there. With a manifest, the version check runs here, before any
// sign-in: a server below this build's minimum is `server-outdated`.
//
// Each request, its answer's body included, has its own time limit
// (`PROBE_TIMEOUT_MS`): on Android expo/fetch's OkHttp client has none of its
// own, so a host that drops packets (an address on a VPN the phone isn't on)
// held the probe for 40-60 s of retries. Past the limit it is `unreachable`, as
// no answer is. The person's own stop (`signal`) still ends it at once.

/** What the probe asks for, on the typed origin and on a redirect's target. */
export const PROBE_PATH = '/api/auth/session';

/**
 * The longest one probe request may take, its body included: the manifest,
 * each session hop. An unreachable host fails after one (the manifest); a probe
 * of one origin takes two at most.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/** The statuses whose Location the probe follows, once. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What Socio's edge answers a request whose Host isn't the server's own. */
const UNRECOGNIZED_HOST = 'Unrecognized host.';

/**
 * Why an address didn't lead to a workspace this build can add. The screen
 * words each: an address problem (the typed address, or a redirect's
 * target) as `checkAddress`'s; `not-socio`, `unrecognized-host` and the
 * redirect problems as "This address doesn't lead to a Socio workspace.".
 */
export type ProbeProblem =
    | AddressProblem
    /** No answer: offline, DNS, TLS (a certificate the phone doesn't trust), a dropped connection, a body cut short, or none within PROBE_TIMEOUT_MS. */
    | 'unreachable'
    /** A 5xx or a 429: the server or a proxy in front of it is failing or busy, so trying again later may work. */
    | 'server-error'
    /** A 403 "Unrecognized host.": a Socio server, but one that doesn't answer on this name (its APP_ORIGIN differs). */
    | 'unrecognized-host'
    /** Any other answer: a 404, HTML, JSON that isn't a sign-in view, a body that isn't JSON, another status. */
    | 'not-socio'
    /** The answer to the followed redirect was another redirect. */
    | 'redirect-twice'
    /** A redirect to another path or query than `/api/auth/session`. */
    | 'redirect-path'
    /** A redirect to anything but https: a downgrade to plain http, in every variant. */
    | 'redirect-insecure'
    /** A redirect with no Location, one that isn't a URL, or one the fetch followed by itself. */
    | 'redirect-invalid'
    /** The manifest's server version is below the lowest this build works with. */
    | 'server-outdated';

/** What the sign-in view says about a workspace. */
export interface WorkspaceInfo {
    /** The server's auth provider: `betterauth`, or `mock` on a developer's server. */
    provider: string;
    /** Its name (`branding.name`). The screens show it beside the host, never instead of it. */
    name: string;
    /** `branding.logo` as the server gives it: a same-origin path (`/favicon.svg` by default) or a data URL; null without one. */
    logo: string | null;
    /** Its sign-in methods (Better Auth's); null when the answer has none, as mock auth's doesn't. */
    methods: SignInMethods | null;
    /** Its manifest, for its id, version and policy; null on a server that has none. */
    manifest: WorkspaceManifest | null;
}

export type ProbeResult =
    /** A workspace this phone doesn't have yet, at `address` (where the redirect, if any, ended). */
    | { kind: 'found'; address: WorkspaceAddress; workspace: WorkspaceInfo; redirectedFrom: string | null }
    /** A workspace already on this phone, which the screen opens instead. */
    | { kind: 'known'; address: WorkspaceAddress }
    /**
     * No workspace this build can add. `origin` is where the problem showed (the
     * typed origin, or a redirect's target), null for a typed address the build
     * refuses; `status` is the HTTP status of the answer it came with, if any.
     */
    | { kind: 'failed'; problem: ProbeProblem; origin: string | null; status: number | null };

export interface ProbeOptions {
    /** The build's variant (`variantFromConfig`): any value but `development` or `preview` gets production's rules. */
    variant: string;
    /** publicFetch (`createPublicFetch`), with the app's one fetch. */
    publicFetch: PublicFetch;
    /** Whether a workspace with exactly this origin is on the phone (the registry), asked once per origin. */
    isKnown: (origin: string) => boolean | Promise<boolean>;
    /** Stops the probe (the screen closing): it then rejects with AbortedError. */
    signal?: AbortSignal;
    /**
     * Whether this build works with a server at `version` (the sync's
     * minimum-version gate, `gateVerdict`): asked of a manifest's version
     * before sign-in. Every version passes without it.
     */
    serverVersionOk?: (version: string) => boolean;
}

type Failed = Extract<ProbeResult, { kind: 'failed' }>;

const failed = (problem: ProbeProblem, origin: string | null, status: number | null): Failed => ({
    kind: 'failed',
    problem,
    origin,
    status,
});

/** A failure rather than an answer or an address. Not `instanceof Response`: expo/fetch's answers aren't the global Response. */
const isFailed = (value: Response | WorkspaceAddress | Failed): value is Failed => 'kind' in value;

/**
 * Probes the address the person typed. Resolves with what it found, or with
 * the problem; rejects only with AbortedError, once `signal` has stopped it,
 * or with what `isKnown` rejects with.
 */
export async function probeWorkspace(text: string, options: ProbeOptions): Promise<ProbeResult> {
    const checked = checkAddress(text, options.variant);
    if (!checked.ok) {
        return failed(checked.problem, null, null);
    }
    const { address } = checked;
    if (await options.isKnown(address.origin)) {
        return { kind: 'known', address };
    }
    const manifest = await readManifest(address.origin, options);
    if (manifest.kind === 'unreachable') {
        return failed('unreachable', address.origin, null);
    }
    const result = await probeSession(address, options);
    if (result.kind !== 'found') {
        return result;
    }
    // A redirect moved the workspace: its manifest is the target's.
    const found =
        result.address.origin === address.origin ? manifest : await readManifest(result.address.origin, options);
    const read = found.kind === 'manifest' ? found.manifest : null;
    if (read !== null && options.serverVersionOk && !options.serverVersionOk(read.serverVersion)) {
        return failed('server-outdated', result.address.origin, null);
    }
    return { ...result, workspace: { ...result.workspace, manifest: read } };
}

/** What asking a workspace for its manifest gave. */
export type ManifestRead =
    /** Its manifest, naming exactly the origin it was asked at. */
    | { readonly kind: 'manifest'; readonly manifest: WorkspaceManifest }
    /** It has none this build can read: a 404, the web's page, another origin's, a redirect, a 5xx. */
    | { readonly kind: 'none'; readonly status: number }
    /** No answer: offline, DNS, TLS, a body cut short, or none within PROBE_TIMEOUT_MS. */
    | { readonly kind: 'unreachable' };

/**
 * `GET <origin>/.well-known/socio/workspace` through publicFetch (no cookies,
 * no Origin, no install id, no redirect followed): the workspace's manifest
 * when it serves one for exactly `origin`. No answer within
 * PROBE_TIMEOUT_MS is `unreachable`. Rejects only with AbortedError once
 * `signal` has stopped it.
 */
export async function readManifest(
    origin: string,
    { publicFetch, signal }: { readonly publicFetch: PublicFetch; readonly signal?: AbortSignal },
): Promise<ManifestRead> {
    const url = `${origin}${WORKSPACE_MANIFEST_PATH}`;
    try {
        return await withinLimit(url, signal, (limited) => askManifest(url, origin, publicFetch, limited));
    } catch (error) {
        if (error instanceof NetworkError) {
            return { kind: 'unreachable' };
        }
        throw error;
    }
}

/** readManifest's request and read, under `signal` (the caller's and the time limit). */
async function askManifest(
    url: string,
    origin: string,
    publicFetch: PublicFetch,
    signal: AbortSignal,
): Promise<ManifestRead> {
    let response: Response;
    try {
        response = await publicFetch(url, {
            headers: { accept: 'application/json' },
            signal,
        });
    } catch (error) {
        if (error instanceof NetworkError) {
            return { kind: 'unreachable' };
        }
        throw error;
    }
    const { status } = response;
    if (
        status !== 200 ||
        followedByItself(response) ||
        (response.url !== '' && originOf(response.url) !== origin) ||
        !isJson(response.headers.get('content-type'))
    ) {
        // Let the connection go; nothing in it counts.
        await readText(response, signal).catch(onlyAbort);
        return { kind: 'none', status };
    }
    let body: unknown;
    try {
        body = await readJson(response, signal);
    } catch (error) {
        if (error instanceof NetworkError) {
            return { kind: 'unreachable' };
        }
        onlyAbort(error);
        return { kind: 'none', status };
    }
    const parsed = workspaceManifestSchema.safeParse(body);
    if (!parsed.success || originOf(parsed.data.origin) !== origin) {
        return { kind: 'none', status };
    }
    return { kind: 'manifest', manifest: parsed.data };
}

/** Swallows a failed read, unless the probe was stopped. */
function onlyAbort(error: unknown): void {
    if (error instanceof AbortedError) {
        throw error;
    }
}

/** The session probe: the sign-in view at the address, after one redirect at most. */
async function probeSession(address: WorkspaceAddress, options: ProbeOptions): Promise<ProbeResult> {
    const first = await hop(address, null, options);
    if (!(first instanceof Redirect)) {
        return first;
    }

    const target = redirectTarget(first.response, address.origin, options.variant);
    if (isFailed(target)) {
        return target;
    }
    if (target.origin !== address.origin && (await options.isKnown(target.origin))) {
        return { kind: 'known', address: target };
    }
    const second = await hop(target, address.origin, options);
    if (second instanceof Redirect) {
        return failed('redirect-twice', target.origin, second.response.status);
    }
    return second;
}

/** A redirect a hop handed back unread, for probeSession to follow or refuse. */
class Redirect {
    constructor(readonly response: Response) {}
}

/**
 * One session request at `address` and the read of its answer, within its own
 * time limit: the redirect's target gets a fresh one. Past it, `unreachable`.
 */
async function hop(
    address: WorkspaceAddress,
    redirectedFrom: string | null,
    options: ProbeOptions,
): Promise<ProbeResult | Redirect> {
    try {
        return await withinLimit(`${address.origin}${PROBE_PATH}`, options.signal, async (signal) => {
            const limited = { ...options, signal };
            const response = await ask(address.origin, limited);
            if (isFailed(response)) {
                return response;
            }
            if (REDIRECTS.has(response.status)) {
                return new Redirect(response);
            }
            return readAnswer(response, address, redirectedFrom, limited);
        });
    } catch (error) {
        if (error instanceof NetworkError) {
            return failed('unreachable', address.origin, null);
        }
        throw error;
    }
}

/**
 * Runs one request, its body read included, under a signal that stops when
 * `signal` does or when PROBE_TIMEOUT_MS has passed, whichever comes first
 * (Hermes has no AbortSignal.any). Settles then even if the fetch underneath
 * doesn't heed its signal. Rejects with AbortedError when `signal` stopped it,
 * NetworkError when the time ran out, or with what `run` rejects with.
 */
async function withinLimit<T>(
    url: string,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    if (signal?.aborted) {
        throw new AbortedError(url, signal.reason);
    }
    const stop = new AbortController();
    const fromCaller = () => stop.abort(signal?.reason);
    signal?.addEventListener('abort', fromCaller, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        stop.abort(new Error(`No answer from ${url} within ${PROBE_TIMEOUT_MS} ms.`));
    }, PROBE_TIMEOUT_MS);
    const stopped = new Promise<never>((_, reject) => {
        stop.signal.addEventListener('abort', () => reject(stop.signal.reason), { once: true });
    });
    const work = run(stop.signal);
    work.catch(() => {});
    stopped.catch(() => {});
    try {
        return await Promise.race([work, stopped]);
    } catch (error) {
        if (signal?.aborted) {
            throw new AbortedError(url, signal.reason);
        }
        if (timedOut) {
            throw new NetworkError(url, error);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', fromCaller);
    }
}

/** The answer to the probe's GET on `origin`, or the problem when there's none it can read. */
async function ask(origin: string, { publicFetch, signal }: ProbeOptions): Promise<Response | Failed> {
    let response: Response;
    try {
        response = await publicFetch(`${origin}${PROBE_PATH}`, { headers: { accept: 'application/json' }, signal });
    } catch (error) {
        if (error instanceof NetworkError) {
            return failed('unreachable', origin, null);
        }
        throw error;
    }
    // A fetch that followed a redirect despite `redirect: 'manual'`: where it
    // went, and through how many hops, is unknown, so nothing it says counts.
    // It shows as an answer from another origin, or as `redirected` on an
    // answer that isn't a 3xx. On a 3xx, `redirected` says nothing: Android's
    // expo/fetch sets it on every 3xx OkHttp counts as a redirect (300, 301,
    // 302, 303, 307, 308), the one it hands back unfollowed included, with the
    // request's own URL; iOS's sets it only after following one.
    if (followedByItself(response) || (response.url !== '' && originOf(response.url) !== origin)) {
        return failed('redirect-invalid', origin, response.status);
    }
    return response;
}

/** `redirected` on an answer the fetch can't have handed back unfollowed: anything but a 3xx. */
function followedByItself(response: Response): boolean {
    return response.redirected && (response.status < 300 || response.status > 399);
}

/** The address a redirect from `from` leads to, if the probe may follow it there. */
function redirectTarget(response: Response, from: string, variant: string): WorkspaceAddress | Failed {
    const location = response.headers.get('location');
    if (location === null || location.trim() === '') {
        return failed('redirect-invalid', from, response.status);
    }
    let url: URL;
    try {
        url = new URL(location, `${from}${PROBE_PATH}`);
    } catch {
        return failed('redirect-invalid', from, response.status);
    }
    if (url.protocol !== 'https:') {
        return failed('redirect-insecure', url.protocol === 'http:' ? url.origin : null, response.status);
    }
    if (url.pathname + url.search !== PROBE_PATH) {
        return failed('redirect-path', url.origin, response.status);
    }
    const checked = checkUrl(url, variant);
    return checked.ok ? checked.address : failed(checked.problem, url.origin, response.status);
}

/** What the answer at `address` says: the workspace, or the problem. */
async function readAnswer(
    response: Response,
    address: WorkspaceAddress,
    redirectedFrom: string | null,
    { signal }: ProbeOptions,
): Promise<ProbeResult> {
    const { status } = response;
    if (status === 200) {
        if (!isJson(response.headers.get('content-type'))) {
            return failed('not-socio', address.origin, status);
        }
        let body: unknown;
        try {
            body = await readJson(response, signal);
        } catch (error) {
            if (error instanceof SyntaxError) {
                return failed('not-socio', address.origin, status);
            }
            if (error instanceof NetworkError) {
                return failed('unreachable', address.origin, status);
            }
            throw error;
        }
        const workspace = signInView(body);
        return workspace === null
            ? failed('not-socio', address.origin, status)
            : { kind: 'found', address, workspace, redirectedFrom };
    }
    if (status === 403 && (await saysUnrecognizedHost(response, signal))) {
        return failed('unrecognized-host', address.origin, status);
    }
    if (status === 429 || status >= 500) {
        return failed('server-error', address.origin, status);
    }
    return failed('not-socio', address.origin, status);
}

/** Whether a 403's body is the edge's "Unrecognized host.", as JSON (`/api`) or as text. */
async function saysUnrecognizedHost(response: Response, signal: AbortSignal | undefined): Promise<boolean> {
    let text: string;
    try {
        text = await readText(response, signal);
    } catch (error) {
        if (error instanceof NetworkError) {
            return false;
        }
        throw error;
    }
    if (text.trim() === UNRECOGNIZED_HOST) {
        return true;
    }
    try {
        const body: unknown = JSON.parse(text);
        return isRecord(body) && body.error === UNRECOGNIZED_HOST;
    } catch {
        return false;
    }
}

/** The sign-in view in a session answer, or null when it isn't one. */
function signInView(body: unknown): WorkspaceInfo | null {
    if (!isRecord(body) || typeof body.provider !== 'string') {
        return null;
    }
    const { branding } = body;
    if (!isRecord(branding) || typeof branding.name !== 'string') {
        return null;
    }
    return {
        provider: body.provider,
        name: branding.name,
        logo: typeof branding.logo === 'string' ? branding.logo : null,
        methods: signInMethods(body.methods),
        manifest: null,
    };
}

/** The sign-in methods, each flag on only when the answer says `true`, and only well-formed providers. */
function signInMethods(value: unknown): SignInMethods | null {
    if (!isRecord(value)) {
        return null;
    }
    const providers: SignInProvider[] = [];
    for (const provider of Array.isArray(value.providers) ? (value.providers as unknown[]) : []) {
        if (isRecord(provider) && typeof provider.id === 'string' && typeof provider.name === 'string') {
            providers.push({ id: provider.id, name: provider.name });
        }
    }
    return {
        passkey: value.passkey === true,
        password: value.password === true,
        signUp: value.signUp === true,
        emailReset: value.emailReset === true,
        signInLink: value.signInLink === true,
        providers,
    };
}

/** Whether a Content-Type is JSON: `application/json` or a `+json` type, with any parameters. */
function isJson(contentType: string | null): boolean {
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}
