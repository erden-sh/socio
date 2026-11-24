import { SecretProviderKind } from '@t3tools/contracts';
import { defineSecretProvider } from '@t3tools/secret-provider-core/shared/definition';
import * as Schema from 'effect/Schema';

import { PLUGIN_WORKLOAD_PREFIX, SECRET_NAME, workloadKey, type WorkloadKind } from '@socio/shared/workspace-secrets';

/**
 * The config a `socio` secret provider carries: which workload owns the
 * reads (a workspace app by id, a plugin as `plugin:<id>`). The driver reads
 * with this identity; the `reference` is the secret name. Socio Secrets
 * already audits every read and refusal, so the driver adds no audit of its
 * own — it is one workload, like the workload route.
 */
export const SocioSecretProviderConfig = Schema.Struct({
    /** The workload key the reads are made as: an app id, or `plugin:<id>`. */
    workload: Schema.String.check(
        Schema.makeFilter((value: string) => (value.length > 0 && isWorkloadKey(value) ? true : 'a workload key')),
    ).pipe(Schema.brand('SocioWorkload')),
});
export type SocioSecretProviderConfig = typeof SocioSecretProviderConfig.Type;

/** `true` for the two workload keys Socio Secrets knows: an app id, or `plugin:<id>`. */
export const isWorkloadKey = (value: string): boolean =>
    value.length > 0 && value.startsWith(PLUGIN_WORKLOAD_PREFIX) ? true : !value.includes(':');

export const kind = SecretProviderKind.make('socio');

/**
 * The `SecretProviderDefinition` for Socio Secrets. A reference is a secret
 * name (the same `SECRET_NAME` the workload route checks), so a settings
 * secret pointed at Socio looks like `{ provider: 'socio', reference: 'API_KEY' }`.
 */
export const definition = defineSecretProvider({
    kind,
    label: 'Socio Secrets',
    configSchema: SocioSecretProviderConfig,
    isReference: (reference) => reference.length <= 64 && SECRET_NAME.test(reference),
    referencePlaceholder: 'API_KEY (a Socio secret name)',
    invalidReferenceMessage: 'Use a Socio secret name: UPPER_CASE letters, digits and _, starting with a letter.',
});

/** The workload kind and id a `SocioSecretProviderConfig.workload` decodes to. */
export const parseWorkload = (key: string): { kind: WorkloadKind; id: string } =>
    key.startsWith(PLUGIN_WORKLOAD_PREFIX)
        ? { kind: 'plugin', id: key.slice(PLUGIN_WORKLOAD_PREFIX.length) }
        : { kind: 'app', id: key };

export const workloadKeyOf = (kind: WorkloadKind, id: string) => workloadKey(kind, id);
