// Types for coding-sandbox.mjs (CB-239): the supervisor's fixed-spec
// sandbox API. The request and answer shapes are what Socio's supervisor
// client sends and reads.

export const SANDBOX_USER: '1000:1000';
export const WORK_DIR: '/work';
export const REPO_DIR: '/work/repo';
export const TOKEN_DIR: '/run/socio';
export const TOKEN_FILE: '/run/socio/token';
export const PROXY_PORT: 3128;
export const SANDBOX_DNS: string[];
export const SANDBOX_TOOLS: string;
export const LABELS: {
    owner: string;
    namespace: string;
    session: string;
    volume: string;
    cpus: string;
    memory: string;
    pids: string;
};
export const EGRESS_LABEL: string;

export interface SandboxCeilings {
    cpus: number;
    memoryBytes: number;
    pids: number;
    sandboxes: number;
    promptSeconds: number;
}

export interface SandboxConfig {
    enabled: boolean;
    reason?: string;
    namespace: string;
    image: string;
    runtime?: string;
    mode: string;
    pool: { base: number; bits: number } | undefined;
    ceilings: SandboxCeilings;
}

export interface SandboxNames {
    sessionId: string;
    volumeKey: string;
    container: string;
    network: string;
    volume: string;
}

export interface SandboxResources {
    cpus: number;
    memoryBytes: number;
    pids: number;
}

/** `POST /sandboxes` body. */
export interface CreateSandboxRequest {
    sessionId: string;
    /** HMAC of person, socio and repository, 64 lowercase hex characters. */
    volumeKey: string;
    cpus?: number;
    memoryBytes?: number;
    pids?: number;
}

/** `POST /sandboxes` answer (201, or 200 when the network already exists). */
export interface CreateSandboxAnswer {
    sessionId: string;
    state: 'network-ready';
    /** The network's /28: the proxy credential's `subnet` claim. */
    subnet: string;
    /** `<ip>:3128`, the proxy's address on that network. */
    proxyAddress: string;
}

/** One entry of the `GET /sandboxes` answer, `{ sandboxes: [...] }`. */
export interface SandboxListEntry {
    sessionId: string;
    /** `network-ready`, or the container's Docker state. */
    state: string;
    startedAt?: string;
    /** The container's network is gone: a sandbox for the reaper. */
    networkMissing?: true;
}

/** `POST /sandboxes/:id/start` body: the credential Socio signed for it. */
export interface StartSandboxRequest {
    proxyUser: string;
    proxyPassword: string;
}

/** The coding agents a prompt may run (CB-326). */
export type Harness = 'opencode' | 'codex' | 'claude-code' | 'gemini-cli' | 'grok';
export const HARNESSES: Harness[];
/** The gateway's URL inside a sandbox. */
export const GATEWAY_URL: 'http://gateway.socio.internal';
/** Codex's `-c` overrides for the gateway route. */
export const CODEX_OVERRIDES: string[];
/** Grok Build's home in a sandbox (CB-326). */
export const GROK_HOME: '/tmp/home/.grok';
/** The MCP server allowlist entry that matches none (Gemini CLI). */
export const GEMINI_NO_MCP: string;

export type ExecKind = 'token' | 'setup' | 'prompt' | 'status' | 'diff' | 'changes';

export interface SocioIdentity {
    /** `<socio name> (Socio)`. */
    name: string;
    /** `socio-<opaque id>@users.noreply.<apps host>`. */
    email: string;
}

/** `POST /sandboxes/:id/exec` body. */
export interface ExecRequest {
    /** The prompt run's id (or any unique id): retries re-attach to it. */
    runId: string;
    kind: ExecKind;
    params?:
        | { token: string }
        | {
              repository: string;
              base: string;
              branch: string;
              identity: SocioIdentity;
          }
        | {
              /** The coding agent to run (CB-326); `opencode` by default. */
              harness?: Harness;
              /**
               * The harness's session to continue: required for OpenCode; for
               * the other harnesses a UUID, absent on a session's first prompt.
               */
              session?: string;
              model: string;
              prompt: string;
              seconds?: number;
              identity: SocioIdentity;
              /** The gateway API OpenCode speaks; `chat` by default. OpenCode only. */
              api?: 'chat' | 'responses';
          }
        | { base: string; path?: string }
        | Record<string, never>;
    /** Seconds to wait for the run to end before answering (at most 60). */
    wait?: number;
}

/** A run, as `POST …/exec` and `GET …/exec/:runId` answer it. */
export interface ExecView {
    runId: string;
    kind: ExecKind;
    state: 'running' | 'exited' | 'timed-out' | 'failed';
    exitCode?: number;
    stdout: string;
    stderr: string;
    truncated: { stdout: boolean; stderr: boolean };
    startedAt: string;
    endedAt?: string;
}

export interface SelfTestState {
    ok: boolean;
    mode: string;
    checkedAt?: number;
    failures: string[];
}

export interface ApiAnswer {
    status: number;
    body: any;
}

export function sandboxConfig(env: Record<string, string | undefined>, namespace: string): SandboxConfig;
export function sandboxNames(namespace: string, sessionId: string, volumeKey: string): SandboxNames;
export function allocateSubnet(pool: { base: number; bits: number }, used: Set<string>): string | undefined;
export function parseCreateRequest(
    body: unknown,
    config: SandboxConfig,
):
    | {
          ok: true;
          value: { sessionId: string; volumeKey: string } & SandboxResources;
      }
    | { ok: false; reason: string };
export function parseStartRequest(
    body: unknown,
): { ok: true; value: { user: string; password: string } } | { ok: false; reason: string };
export function sandboxEnvironment(proxyUrl: string): string[];
export function networkSpec(
    config: SandboxConfig,
    names: SandboxNames,
    subnet: string,
    resources: SandboxResources,
): any;
export function containerSpec(
    config: SandboxConfig,
    names: SandboxNames,
    resources: SandboxResources,
    proxy: { address: string; user: string; password: string },
    command?: string[],
): any;
/** The /proc and /sys paths an inspected sandbox must keep masked or read-only. */
export const REQUIRED_MASKED_PATHS: string[];
export const REQUIRED_READONLY_PATHS: string[];
export function specMismatches(
    info: any,
    expected: any,
    imageId: string | undefined,
    /** The pinned image's `Config.Env`, which Docker merges in. */
    imageEnv?: string[],
): string[];
export function networkMismatches(info: any, expected: any, allowedMembers: string[]): string[];
export function execPlan(
    kind: unknown,
    params: unknown,
    config: SandboxConfig,
):
    | {
          ok: true;
          value: {
              argv: string[];
              env: string[];
              stdin?: string;
              workdir?: string;
              seconds: number;
              cap: number;
          };
      }
    | { ok: false; reason: string };
export function demuxLogs(buffer: Buffer): string;
export function probeVerdict(exitCode: number | undefined, output: string): { ok: boolean; failures: string[] };
export function createSandboxApi(options: {
    docker: any;
    config: SandboxConfig;
    log?: (line: string) => void;
    now?: () => number;
}): {
    handle(method: string, path: string, body?: unknown, query?: URLSearchParams): Promise<ApiAnswer>;
    runSelfTest(): Promise<SelfTestState>;
    selfTestState(): SelfTestState;
};
export function mountCodingSandboxes(
    app: any,
    options: {
        docker: any;
        env: Record<string, string | undefined>;
        namespace: string;
        log?: (line: string) => void;
    },
): ReturnType<typeof createSandboxApi>;
