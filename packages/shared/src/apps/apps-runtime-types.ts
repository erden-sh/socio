/**
 * The workspace app runtime's internal API: the `apps` service runs
 * promoted mini apps, one process each. Only the app calls it, over the
 * internal apps network, with the shared `APPS_RUNTIME_TOKEN`.
 *
 * - `PUT /v1/apps/:id/versions/:version` (body: the bundle, header
 *   `x-bundle-sha256`): unpack (and install its locked dependencies).
 * - `POST /v1/apps/:id/start` (`RuntimeStartRequest`): run that version.
 * - `POST /v1/apps/:id/stop`, `DELETE /v1/apps/:id` (stop and forget).
 * - `PUT /v1/apps/:id/token` (`{ token }`): the app's data token, renewed.
 * - `GET /v1/apps`, `GET /v1/apps/:id`: `RuntimeAppStatus`.
 * - `GET /v1/apps/:id/logs?tail=`: `{ lines }` (every attempt, mixed).
 * - `GET /v1/apps/:id/attempts?tail=`: `{ boot, attempts }`, each build and
 *   start attempt with its own output and how it ended (CB-146), oldest
 *   first, at most 512 KB; `boot` names this run of the runtime.
 *
 * Requests to an app go to the ingress port with `x-cb-runtime-app` and
 * `x-cb-runtime-key` (derived from the token), never to the app directly:
 * apps listen on unix sockets only their process and the runtime can open.
 *
 * Plugin services, when `APPS_RUNTIME_DOCKER=on` (off on the default stack):
 * - `PUT /v1/services/:id` (`{ spec, identity?, registry? }`): create or update the swarm service;
 *   `registry` is the image's registry login, which Swarm keeps for every task's pull.
 * - `POST /v1/services/:id/networks` (`{ egress }`): re-attach the infra services to its network.
 * - `POST /v1/services/:id/scale` (`{ replicas }`): including 0, which keeps the service.
 * - `DELETE /v1/services/:id`: remove the service and the volumes it created.
 * - `GET /v1/services/:id`: `RuntimeServiceStatus`.
 * The ingress reaches a plugin the same way, then round-robins task addresses
 * and adds `x-cb-plugin-proof`. No host ports are published.
 */
export type RuntimeProcessState = 'running' | 'starting' | 'stopped' | 'failed' | 'not_deployed';

export interface RuntimeAppStatus {
    id: string;
    state: RuntimeProcessState;
    /** The version running (or last asked for). */
    version: number | null;
    /** Versions unpacked here. */
    versions: number[];
    startedAt: number | null;
    /** Restarts after crashes in the last ten minutes. */
    restarts: number;
    /** Why it failed or stopped, in a line (never the app's output). */
    error: string | null;
    /** The newest attempt (CB-146): the app syncs attempts when it changes. */
    attempt?: { id: string; state: RuntimeAttemptState } | null;
}

/**
 * How an attempt ended. `exit`: the process exited by itself (code);
 * `signal`: a signal the runtime didn't send; `oom`: above the memory
 * limit; `health_check`: never opened its socket in time; `spawn`: the
 * command couldn't run; `build`: unpacking or installing failed;
 * `stopped`: stopped on purpose (stop, a newer start, a shutdown).
 */
export type RuntimeExitReason = 'exit' | 'signal' | 'oom' | 'health_check' | 'spawn' | 'build' | 'stopped';
export type RuntimeAttemptState = 'running' | 'succeeded' | 'failed' | 'stopped';

/**
 * One attempt (CB-146): a `build` (unpack and install a version) or a
 * `start` (one process of a version, crash restarts included, each its
 * own), with its own output, redacted and bounded.
 */
export interface RuntimeAttempt {
    /** `<boot>:<random>`: the runtime keeps nothing across restarts. */
    id: string;
    version: number;
    kind: 'build' | 'start';
    state: RuntimeAttemptState;
    startedAt: number;
    /** A start: when its socket answered. */
    upAt: number | null;
    endedAt: number | null;
    exit: {
        reason: RuntimeExitReason;
        code: number | null;
        signal: string | null;
        message: string;
    } | null;
    /** Its last lines (`<ISO time> <out|err|runtime> <text>`). */
    lines: string[];
    /** Lines it wrote that were dropped from the start (bounded). */
    dropped: number;
}

export interface RuntimeStartRequest {
    version: number;
    /** The app's data token (purpose `app`, its granted datasets). */
    token: string | null;
    /** `<DATA_API_URL>/api/data`, as the runtime's apps reach it. */
    dataUrl: string | null;
    /** The app's public origin (for links it builds). */
    appUrl: string;
    /**
     * The owner's values for the manifest's `env` names, and the app's
     * envelope keys under `RUNTIME_ACTOR_ENV` names (CB-232).
     */
    env: Record<string, string>;
}

export const RUNTIME_APP_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const RUNTIME_HEADER_APP = 'x-cb-runtime-app';
export const RUNTIME_HEADER_KEY = 'x-cb-runtime-key';
/** The ingress proves to a plugin task that the request came through it. */
export const RUNTIME_HEADER_PLUGIN_PROOF = 'x-cb-plugin-proof';
/**
 * The apps proxy's signature over the identity headers it adds
 * (CB-232): `v1.<names>.<mac>`. The ingress passes `x-cb-*` headers on only
 * when they are signed (legacy ones from an older proxy aside).
 */
export const RUNTIME_HEADER_SIG = 'x-cb-runtime-sig';
/**
 * The install revision a request must reach (CB-370), 64 hex digits: the
 * ingress sends it only to a running task of the plugin service's current
 * container revision, and only while that service runs exactly this install
 * revision (its `socio.plugin.revision` label). The apps proxy sets it on
 * public webhook requests from the install as the database has it, so a
 * path is answered only by the code of the manifest that declared it: never
 * by a task an update is replacing, nor by a service provisioned from
 * another manifest (an update in flight, or a stale change racing one).
 */
export const RUNTIME_HEADER_CURRENT = 'x-cb-runtime-current';
/**
 * The one task a host request must reach (CB-458): a running task's id,
 * from `RuntimeServiceStatus.tasks`. The ingress honors it on `/__cb/`
 * only, sends such a request to that task and no other, and answers 502
 * when it isn't running, so every request of one snapshot reaches the task
 * that holds it. Only Socio's server sets it; the apps proxy strips it,
 * with every client `x-cb-*` header.
 */
export const RUNTIME_HEADER_TASK = 'x-cb-runtime-task';
/** A task id as the ingress takes it in `x-cb-runtime-task`. */
export const RUNTIME_TASK_ID = /^[a-z0-9]{1,64}$/;
/**
 * The envelope keys a start request carries in `env` (CB-232). They
 * travel in `env`, not a field of their own, so a runtime older than
 * CB-232 ignores them (it injects only the manifest's names, and a
 * manifest can't declare a `CB_` name) instead of refusing the start.
 */
export const RUNTIME_ACTOR_ENV = ['CB_ACTOR_KEY', 'CB_ACTOR_KEY_PREVIOUS', 'CB_ACTOR_KEY_PREVIOUS_UNTIL'] as const;

export interface RuntimeServiceStatus {
    id: string;
    service: string;
    image: string;
    replicas: number;
    running: number;
    state: 'running' | 'starting' | 'stopped';
    /** The install revision the service was last provisioned with (`socio.plugin.revision`, CB-370). */
    revision?: string;
    /** The identity version it runs (`socio.identity`): the one Socio issued last, unless a slower provision overwrote it. */
    identity?: number;
    /** The fingerprint of the registry login it was last given (`socio.registry`). */
    registry?: string;
    /** Its running tasks' ids, for `x-cb-runtime-task` (CB-458); absent from an older runtime. */
    tasks?: string[];
}

/** A registry login sent with a plugin service's provision, with its fingerprint. */
export interface RuntimeRegistryGrant {
    registry: string;
    username: string;
    password: string;
    fingerprint: string;
}
