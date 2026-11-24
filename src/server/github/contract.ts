/**
 * What other features may know of the GitHub App (CB-32, CB-239, CB-325):
 * its tags, the slices of `GitHubAppSettings`, `GitHubApp` and
 * `GitHubRepository` they call, plain types, constants and its error. It
 * imports only `effect` and `@socio/*`, and holds no logic.
 *
 * Moved here, re-exported at their old paths:
 * - `GitHubHosts`, `GITHUB_HOSTS`, `GitHubOptions`, `INSTALLATION_PERMISSIONS`,
 *   `InstallationPermissions`, `GitHubError`, `PACK_LIMIT` and
 *   `ConvertedApp` (`api.ts`).
 * - `GitHubAppEnv`, `GitHubAppCredentials`, `GitHubAppConfig` and
 *   `FlowPhase` (`settings.ts`).
 *
 * Moved into a package, re-exported at `api.ts`:
 * - `pktLine` and `readPktLines`: `@socio/foundation/github/pkt-lines`.
 *
 * Not here, on purpose:
 * - `GitHubAppSettings`, `GitHubApp` and `GitHubRepository` themselves: the
 *   composition builds the settings (`composition/github.ts`), and other
 *   folders get the `GitHubSettings` and `GitHubClients` tags below.
 * - `GitHubError` stays a plain `Error` (the gateway checks it with
 *   `instanceof` and shows its message). So do `SealedAppError` and
 *   `FlowStateError`, which only github uses.
 * - `GITHUB_SEALED_SQL` stays in `infra/sealed.ts`: SQL on the App's rows
 *   stays inside its infra, as inference's and notifications' do. Backup's
 *   recovery drill should get it from the composition root.
 * - `gitHubAppFromEnv` reads the environment for `PlatformConfig`; only the
 *   entry (`index.ts`) calls it, and the composition builds `GitHubConfig`
 *   with it.
 * - `appJwt`, `GitHubApp.convertManifest` and `GitHubApp.accountType`: only
 *   github's connect flow and its tests use them.
 * - `githubModule`, `githubRoutes` and the connect flow: the modules
 *   registry's and github's own. They read the settings as `GitHubAdmin`.
 *
 * `layer.ts` implements `GitHubSettings`, `GitHubAdmin` and
 * `GitHubClients`; the composition builds `GitHubConfig`. `GitHubError`
 * stays a plain `Error`: the gateway checks it with `instanceof`, and a
 * tagged error would change what it shows.
 */
import { Context } from 'effect';

import type { SealState } from '@socio/foundation/keys/secret-box';
import type { GitHubAppInput, GitHubAppView } from '@socio/shared/github-types';

// ── Plain types and constants ────────────────────────────────────────────

/** Where GitHub is; tests point all three at loopback. */
export interface GitHubHosts {
    /** Pages: creating and installing the App. */
    web: string;
    /** Git's smart HTTP: `<git>/<owner>/<name>.git/...`. */
    git: string;
    api: string;
}
export const GITHUB_HOSTS: GitHubHosts = {
    web: 'https://github.com',
    git: 'https://github.com',
    api: 'https://api.github.com',
};

/** How GitHub is reached: the hosts, `fetch` and a stop signal. */
export interface GitHubOptions {
    hosts?: GitHubHosts;
    transport?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/**
 * What an installation token may do by default: contents and pull requests
 * write. Never `workflows`: without it GitHub refuses any push that changes
 * `.github/workflows/`, so a coding agent's branch can't change what CI
 * runs. A token GitHub grants anything more is revoked unused.
 */
export const INSTALLATION_PERMISSIONS = {
    contents: 'write',
    pull_requests: 'write',
} as const;

/**
 * The permissions a caller may ask an installation token for (CB-239):
 * contents and pull requests only, each read or write; never `workflows`
 * or anything else, so no token Socio mints can change what CI runs.
 */
export type InstallationPermissions = Partial<Record<'contents' | 'pull_requests', 'read' | 'write'>>;

/** The most a pushed pack may be; GitHub's own push limit is far above. */
export const PACK_LIMIT = 100 * 1024 * 1024;

/** What converting a manifest gives: the new App, with its private key. */
export interface ConvertedApp {
    id: string;
    slug: string;
    owner: string;
    privateKey: string;
}

/** The environment's values: the starting ones under an admin's. */
export interface GitHubAppEnv {
    /** `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. */
    app?: { id: string; privateKey: string };
    installationId?: string;
    repository?: string;
}

/** A GitHub App's credentials; the key signs its JWTs and nothing else. */
export interface GitHubAppCredentials {
    id: string;
    privateKey: string;
}

/** What the coding gateway uses now. */
export interface GitHubAppConfig {
    app?: GitHubAppCredentials;
    /** Undefined: found from each repository. */
    installationId?: string;
    repository?: string;
}

/** The connect flow's two steps: make the App, then install it. */
export type FlowPhase = 'create' | 'install';

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A failure whose message is safe to show on the issue. A plain `Error`
 * (callers check it with `instanceof`).
 */
export class GitHubError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'GitHubError';
    }
}

// ── GitHubSettings ───────────────────────────────────────────────────────

/**
 * What other features read of the GitHub App's settings, with the
 * signatures `GitHubAppSettings` has today: the values in force (the coding
 * gateway) and the data key's re-seal and counts (`DataKeyAdmin`). The admin
 * routes and the connect flow are github's own.
 */
export interface GitHubSettingsShape {
    /**
     * The values in force, the key opened: the App connected here, else the
     * environment's. Rejects with `SealedAppError` when the saved App can't
     * be opened.
     */
    inForce(): Promise<GitHubAppConfig>;
    /** The saved App sealed again under the current data key (CB-62). */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
    /** The saved App's seal, for the data key's counts (CB-62). */
    sealStates(): Promise<Record<SealState, number>>;
}

export class GitHubSettings extends Context.Service<GitHubSettings, GitHubSettingsShape>()(
    'socio/github/GitHubSettings',
) {}

// ── GitHubAdmin ──────────────────────────────────────────────────────────

/**
 * What github's own admin routes and connect flow call on the App's settings,
 * with the signatures `GitHubAppSettings` has today. No other folder uses it.
 */
export interface GitHubAdminShape extends GitHubSettingsShape {
    /** What admins see; never the key. `canConnect` is the caller's. */
    view(canConnect: boolean): Promise<GitHubAppView>;
    /** The repository; validated by the route. */
    save(input: GitHubAppInput): Promise<void>;
    /** The App GitHub made from the manifest; any installation is forgotten. */
    saveApp(app: ConvertedApp): Promise<void>;
    saveInstallation(id: string): Promise<void>;
    /** The App connected here; the environment's is used again. */
    forgetApp(): Promise<void>;
    /** Whether an App is saved here that can't be opened. */
    appUnreadable(): Promise<boolean>;
    /** The saved App's credentials, for the install step. */
    connectedApp(): Promise<GitHubAppCredentials & { owner: string }>;
    /** Starts a connect step for one admin; the state, kept only as its hash. */
    startFlow(userId: string, phase: FlowPhase, owner: string): Promise<string>;
    /** The step `state` belongs to; `consume` ends it. Rejects with `FlowStateError`. */
    checkFlow(state: string, userId: string, phase: FlowPhase, consume: boolean): Promise<{ owner: string }>;
}

export class GitHubAdmin extends Context.Service<GitHubAdmin, GitHubAdminShape>()('socio/github/GitHubAdmin') {}

// ── GitHubClients ────────────────────────────────────────────────────────

/** An installation token for one repository; `revoke` ends it. */
export interface InstallationToken {
    token: string;
    revoke: () => Promise<void>;
}

/** The slice of `GitHubApp` other features call: its installations and their tokens. */
export interface GitHubAppShape {
    /**
     * The installation of this App that covers `repository` and is on its
     * owner's account (CB-239 8.2).
     */
    ownedInstallation(repository: string): Promise<string>;
    /**
     * A token for one repository with `permissions` (contents and pull
     * requests write by default), valid for an hour at most: use it once,
     * then `revoke` it.
     */
    installationToken(
        installationId: string,
        repository: string,
        permissions?: InstallationPermissions,
    ): Promise<InstallationToken>;
}

/** What a `GitHubRepository` is made with: the reach, the repository and a token. */
export type GitHubRepositoryOptions = GitHubOptions & { repository: string; token: string };

/** The slice of `GitHubRepository` other features call. */
export interface GitHubRepositoryShape {
    /** The commit a branch, tag or commit id names now (CB-267). */
    resolveCommit(ref: string): Promise<string>;
    /**
     * One request of git's smart HTTP (CB-239 8.2), the answer returned
     * unread; never follows a redirect.
     */
    smartHttp(
        path: string,
        init: {
            method: 'GET' | 'POST';
            headers?: Record<string, string>;
            body?: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>;
            signal?: AbortSignal;
        },
    ): Promise<Response>;
    /** A draft pull request from `head` into `base`, or the one already there for `head`. */
    draftPullRequest(input: {
        head: string;
        base: string;
        title: string;
        body: string;
        draftOnly?: boolean;
    }): Promise<{ number: number; url: string; draft: boolean }>;
}

/**
 * How other features reach GitHub: an App by its credentials, and a
 * repository by an installation token. Today the coding gateway calls
 * `new GitHubApp(...)` and `new GitHubRepository(...)`; `gitHubClients`
 * (`api.ts`) does the same behind this tag.
 */
export interface GitHubClientsShape {
    app(credentials: GitHubAppCredentials, options?: GitHubOptions): GitHubAppShape;
    repository(options: GitHubRepositoryOptions): GitHubRepositoryShape;
}

export class GitHubClients extends Context.Service<GitHubClients, GitHubClientsShape>()('socio/github/GitHubClients') {}

// ── GitHubConfig ─────────────────────────────────────────────────────────

/**
 * What github reads of the platform's configuration: the environment's App
 * (`config.github`), how GitHub is reached (`config.githubAccess`) and the
 * app's origin for the connect flow's links (`config.appOrigin`).
 */
export interface GitHubConfigShape {
    /** `config.github ?? {}`. */
    readonly env: GitHubAppEnv;
    /** `config.githubAccess`. */
    readonly access?: GitHubOptions;
    /** `config.appOrigin`. */
    readonly appOrigin?: string;
}

export class GitHubConfig extends Context.Service<GitHubConfig, GitHubConfigShape>()('socio/github/GitHubConfig') {}
