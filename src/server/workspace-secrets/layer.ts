/**
 * Socio Secrets' layer: one `WorkspaceSecrets` on the workspace connection,
 * sealed with the data keyring, offered as `Secrets` (what other folders read)
 * and `SecretsAdmin` (what this folder's own routes and module hooks use). Only
 * the composition root (`composition/workspace-secrets.ts`) and tests import
 * this file.
 *
 * What it needs of the features below it in the folder order
 * (scripts/feature-ranks.json) it yields by their contracts' tags: the
 * workspace's `Audit` and `People`. What it needs of the rest it declares
 * here, and the composition root provides:
 *
 * - `SecretsHost`: the workloads (workspace apps and service plugins, both
 *   above it, the plugins late-bound) and `AdminNotices.notifyAdmins`.
 *
 * `workspaceSecrets` makes the service; both the layer and the composition's
 * builder call it (through `composition/workspace-secrets.ts`), so the
 * two build the same service.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { Audit, People, type AuditShape, type PeopleShape } from '../workspace/contract.js';

import { Secrets, SecretsAdmin, type WorkspaceSecretsDeps } from './contract.js';
import { WorkspaceSecretRepository } from './infra/sqlite/repository.js';
import { WorkspaceSecrets } from './service.js';

// ── What the composition root provides ───────────────────────────────────

/** An admin notice (`AdminNotices.notifyAdmins`). */
export type SecretsAdminNotice = { trigger: string; title: string; message: string; path: string };

/**
 * What Socio Secrets asks of the features above it and of the composition, at
 * the moment of use: the workloads that may hold secrets, and the admins'
 * notices.
 */
export interface SecretsHostShape {
    /** Workspace apps in the workspace app runtime. */
    readonly apps: WorkspaceSecretsDeps['apps'];
    /** Installed service plugins. */
    readonly plugins: NonNullable<WorkspaceSecretsDeps['plugins']>;
    /** `AdminNotices.notifyAdmins` (new read flags). */
    notifyAdmins(notice: SecretsAdminNotice): Promise<void>;
}

export class SecretsHost extends Context.Service<SecretsHost, SecretsHostShape>()(
    'socio/workspace-secrets/SecretsHost',
) {}

// ── The service ──────────────────────────────────────────────────────────

/**
 * Socio Secrets: workspace apps and service plugins, by the manifest of the
 * version they run; the workspace's audit and people's names.
 */
export function workspaceSecrets(
    db: DatabaseSync,
    keys: DataKeyring,
    host: SecretsHostShape,
    workspace: Pick<AuditShape, 'audit'> & Pick<PeopleShape, 'users'>,
): WorkspaceSecrets {
    return new WorkspaceSecrets(new WorkspaceSecretRepository(db), keys, {
        apps: host.apps,
        // Installed service plugins, by their installed manifest's
        // `secrets`; they read with their own identity token.
        plugins: host.plugins,
        audit: (entry) => workspace.audit(entry),
        // New read flags reach every active admin.
        notifyAdmins: (notice) => host.notifyAdmins(notice),
        userName: (userId) => workspace.users().find((user) => user.id === userId)?.name,
    });
}

/** `workspaceSecrets` over `SecretsHost`, `Audit` and `People`. */
export const makeWorkspaceSecrets = (db: DatabaseSync, keys: DataKeyring) =>
    Effect.gen(function* () {
        const host = yield* SecretsHost;
        const audit = yield* Audit;
        const people = yield* People;
        return workspaceSecrets(db, keys, host, {
            audit: (entry) => audit.audit(entry),
            users: () => people.users(),
        });
    });

/** One service under both of its tags: the same instance. */
export const secretsContext = (secrets: WorkspaceSecrets) =>
    Context.make(Secrets, secrets).pipe(Context.add(SecretsAdmin, secrets));

/**
 * `Secrets` and `SecretsAdmin`, built once over `db` and `keys`; needs
 * `SecretsHost`, `Audit` and `People`.
 */
export const WorkspaceSecretsLive = (db: DatabaseSync, keys: DataKeyring) =>
    Layer.effectContext(Effect.map(makeWorkspaceSecrets(db, keys), secretsContext));
