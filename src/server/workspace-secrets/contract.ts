/**
 * What other features may know of Socio Secrets: its
 * tag, the slice of `WorkspaceSecrets` they call, and the plain types around
 * it. It imports only `effect` and `@socio/*` (and other features'
 * contracts, type-only), and holds no logic.
 *
 * The types here moved from `service.ts`, which re-exports them, so every
 * importer keeps compiling until that importer switches to the contract.
 * `WorkspaceSecrets` implements `WorkspaceSecretsShape`.
 *
 * Not here, on purpose:
 * - No `WorkspaceSecretsConfig`: Socio Secrets reads no `PlatformConfig`
 *   field. Its data key (`DataKeyring`) is handed in by the composition.
 * - `SecretError` stays a plain `Error` in `service.ts`: only this folder's
 *   routes catch it, and a `Data.TaggedError` would change its name and
 *   `String()`.
 * - `createSecretInput`, `replaceSecretInput` and `describeSecretInput` (zod
 *   values) stay in `service.ts`: only this folder uses them.
 * - `WORKSPACE_SECRETS_SEALED_SQL` stays in `infra/sqlite/sealed.ts`; the
 *   restore drill should get it from the composition root.
 * - `workspaceSecretsModule`, `workspaceSecretRoutes` and
 *   `workspaceSecretsSchema`: the modules registry's.
 * - `WorkspaceSecrets` itself: `layer.ts` builds it, once, and offers it as
 *   `Secrets` (what other folders read) and `SecretsAdmin` (what this
 *   folder's own routes and module hooks use).
 */
import { Context } from 'effect';

import type { SealState } from '@socio/foundation/keys/secret-box';
import type {
    AppManifestSecret,
    SecretHistory,
    SecretReadFlagView,
    WorkloadSecret,
    WorkspaceSecretsState,
    WorkspaceSecretView,
} from '@socio/shared/workspace-secrets';

import type { WorkspaceAuditEntry } from '../workspace/contract.js';

// ── Plain types ──────────────────────────────────────────────────────────

/** A workspace app or a service plugin as Socio Secrets sees it: a workload. */
export interface SecretApp {
    id: string;
    name: string;
    status: string;
}

/** What the service needs from the rest of the platform. */
export interface WorkspaceSecretsDeps {
    /**
     * Workspace apps: promoted into the workspace app runtime (promoted or
     * unpublished), live. Only these are served: a development app runs on
     * a socio's computer, and socios get no secrets.
     */
    apps: {
        list(): SecretApp[];
        get(id: string): SecretApp | undefined;
        /** The secrets the manifest of the version it runs declares. */
        declared(appId: string): readonly AppManifestSecret[];
    };
    /**
     * Installed service plugins, by plugin id: they read with
     * their own identity token. Bundled plugins run inside Socio and aren't
     * workloads. Unset: no plugin holds secrets.
     */
    plugins?: {
        list(): SecretApp[];
        get(id: string): SecretApp | undefined;
        /** The secrets its installed manifest declares. */
        declared(pluginId: string): readonly AppManifestSecret[];
        /** Its current identity version and when it was issued (a stale one's use is noted). */
        identity?(pluginId: string): { version: number; issuedAt: number } | undefined;
    };
    audit(entry: WorkspaceAuditEntry): void;
    /** Tells every active admin about new read flags. */
    notifyAdmins?(notice: { trigger: string; title: string; message: string; path: string }): Promise<unknown>;
    /** A person's display name, for the admin view. */
    userName(userId: string): string | undefined;
    now?: () => number;
}

/** A workload's read of one secret: the value, or why not (never a value). */
export type ReadOutcome = { ok: true; secret: WorkloadSecret } | { ok: false; status: 403 | 404; error: string };

// ── Tags ─────────────────────────────────────────────────────────────────

/**
 * Socio Secrets as the rest of the server calls it, with the signatures
 * `WorkspaceSecrets` has today: a workload's read (the coding session
 * host's secret provider), the apps' redaction and setup checks, a stale
 * plugin identity's refusal (plugin routes), the data key's counts and
 * re-seal (`DataKeyAdmin`), and the module's tick. Admin writes and views go
 * only through this folder's own routes.
 */
export interface WorkspaceSecretsShape {
    /**
     * A workload's read of one secret: the current version, or a named
     * version still in its overlap window. Audited either way, never the
     * value.
     */
    read(appId: string, name: string, version?: number, identityVersion?: number): ReadOutcome;
    /**
     * A workspace secret Socio itself uses (the plugin registry login): its
     * current value, or undefined. Audited once per version per process.
     */
    platformRead(name: string, reader: string): string | undefined;
    /** A plugin's identity that is no longer accepted, used with its proof: audited, throttled. */
    refuseStaleIdentity(pluginId: string, version: number, names: string): void;
    /** Values to keep out of a workload's logs: what it read here and what it may read now. */
    redactionValues(appId: string): string[];
    /** Required secrets nothing serves (the workload needs setup); empty for others. Takes a workload key. */
    needsSetup(appId: string): string[];
    /** How the stored versions are sealed, for the data key's status. */
    sealStates(): Record<SealState, number>;
    /** Every version again under the current data key. */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
    /** Retires versions past their overlap window and removes removed apps' secrets. */
    sweep(): Promise<void>;
    /** The read-anomaly rules, when due. */
    evaluateFlagsIfDue(): Promise<void>;
}

export class Secrets extends Context.Service<Secrets, WorkspaceSecretsShape>()('socio/workspace-secrets/Secrets') {}

// ── SecretsAdmin ─────────────────────────────────────────────────────────

/**
 * What this folder's own routes (`/api/workspace-secrets`,
 * `/api/workload/secrets`) and module hooks call: `Secrets`, plus the
 * admins' views and writes and a workload's check. Only
 * `workspace-secrets/` uses it; the same `WorkspaceSecrets` as `Secrets`,
 * with the signatures it has today. An input is the request's JSON, which
 * the service parses (`createSecretInput`, ... in `service.ts`); a refusal
 * throws `SecretError` (`service.ts`).
 */
export interface WorkspaceSecretsAdminShape extends WorkspaceSecretsShape {
    /** Every secret and the workloads that may hold them: never a value. */
    state(): WorkspaceSecretsState;
    /** One secret's view. */
    get(id: string): WorkspaceSecretView;
    /** A secret's history, deleted ones too: a page of events. */
    history(id: string, query?: { before?: number; limit?: number }): SecretHistory;
    /** An admin dismisses a read flag. */
    dismissFlag(actor: string, id: string): Promise<SecretReadFlagView>;
    create(actor: string, input: unknown): Promise<WorkspaceSecretView>;
    /** "Replace": a new version. */
    replace(actor: string, id: string, input: unknown): Promise<WorkspaceSecretView>;
    describe(actor: string, id: string, input: unknown): Promise<WorkspaceSecretView>;
    remove(actor: string, id: string): Promise<void>;
    grant(actor: string, id: string, appId: string): Promise<WorkspaceSecretView>;
    revoke(actor: string, id: string, appId: string): Promise<WorkspaceSecretView>;
    /** Whether a workload may read `name` now; a refusal is audited like a read's. */
    check(
        appId: string,
        name: string,
        identityVersion?: number,
    ): { ok: true } | { ok: false; status: 403 | 404; error: string };
}

export class SecretsAdmin extends Context.Service<SecretsAdmin, WorkspaceSecretsAdminShape>()(
    'socio/workspace-secrets/SecretsAdmin',
) {}
