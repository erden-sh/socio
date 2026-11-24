import { defineSecretProviderDriver } from '@t3tools/secret-provider-core/server/driver';
import * as Effect from 'effect/Effect';

import type { WorkspaceSecretsShape } from '../../../workspace-secrets/contract.js';

import { definition } from './definition.js';

/**
 * The `SecretProviderDriver` for Socio Secrets (CB-326 step 2): a driver the T3
 * `SecretResolver` uses to resolve a `SecretReference` whose provider is
 * `socio`. The reference is the secret name; the config names the workload the
 * read is made as (a workspace app or plugin). It calls
 * `WorkspaceSecrets.read`, the same path the workload route uses, so every read
 * (and refusal) is audited exactly once and a value never leaves the platform
 * this driver runs in.
 *
 * The driver is gateway-only: it lives in the session host process, which
 * holds the platform's `WorkspaceSecrets` instance. It is not exported to
 * workloads or socios.
 */
export interface SocioSecretProviderDriverDeps {
    readonly secrets: WorkspaceSecretsShape;
}

export const makeDriver = (deps: SocioSecretProviderDriverDeps) =>
    defineSecretProviderDriver({
        kind: definition.kind,
        definition,
        read: (config, references) =>
            Effect.sync(() =>
                references.map((name) => {
                    const outcome = deps.secrets.read(config.workload, name);
                    return outcome.ok ? outcome.secret.value : undefined;
                }),
            ),
    });
