import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    IDENTITY_FILE_ENV,
    PLUGIN_IDENTITY_TOKEN,
    SWARM_IDENTITY_FILE,
    SWARM_IDENTITY_PATH,
    identitySecretLabels,
    identitySecretName,
    type DeliveredIdentity,
    type IdentityDelivery,
    type WorkloadRef,
} from '@socio/shared/identity-delivery';
import { PLUGIN_ID } from '@socio/shared/plugins/plugin-service';

import type { DockerEngine } from './docker.js';
import { RuntimeError } from './supervisor.js';

/**
 * Adapters of the identity delivery port. Socio mints the token; an adapter
 * puts it where the workload reads it and removes the versions it replaced.
 * No adapter logs a token or keeps one in memory past the call.
 */

/** Versions below `keep` that `retire` looks for: enough for a run of failed retires. */
export const RETIRE_SPAN = 16;

function checkRequest(workload: WorkloadRef, token: string, version: number) {
    if (workload.kind !== 'plugin' || !PLUGIN_ID.test(workload.id)) {
        throw new RuntimeError('An identity is for a plugin with a routable id.', 400);
    }
    if (!PLUGIN_IDENTITY_TOKEN.test(token)) {
        throw new RuntimeError('That is not a plugin identity token.', 400);
    }
    if (!Number.isInteger(version) || version < 1 || version > 999_999_999) {
        throw new RuntimeError('An identity version is a positive whole number.', 400);
    }
}

const olderVersions = (keep: number) => {
    const list: number[] = [];
    for (let version = keep - 1; version >= 1 && version >= keep - RETIRE_SPAN; version--) {
        list.push(version);
    }
    return list;
};

/**
 * Swarm: one Docker secret per version, `<PLUGIN_NAME_PREFIX>-wl-<id>-v<n>`,
 * created through the socket proxy and mounted at
 * `/run/secrets/socio_identity`. Rotating it is a new version: the caller
 * updates the service to the new secret, then `retire` deletes the old
 * ones (Swarm refuses to delete a secret a service still references).
 */
export class SwarmIdentityDelivery implements IdentityDelivery {
    readonly platform = 'swarm' as const;
    constructor(private engine: DockerEngine) {}

    async deliver(workload: WorkloadRef, token: string, version: number): Promise<DeliveredIdentity> {
        checkRequest(workload, token, version);
        const name = identitySecretName(workload.id, version);
        // Socio never sends a version twice, so a secret already there is a
        // leftover (a restored database counts versions again): replace it.
        const stale = await this.engine.secretId(name);
        if (stale) {
            await this.engine.removeSecret(stale);
        }
        const secretId = await this.engine.createSecret({
            Name: name,
            Labels: identitySecretLabels(workload.id),
            Data: Buffer.from(token, 'utf8').toString('base64'),
        });
        return {
            fileEnv: IDENTITY_FILE_ENV,
            path: SWARM_IDENTITY_PATH,
            version,
            mount: { kind: 'swarm-secret', secretId, secretName: name, file: SWARM_IDENTITY_FILE },
        };
    }

    async discard(workload: WorkloadRef, version: number) {
        const id = await this.engine.secretId(identitySecretName(workload.id, version));
        if (id) {
            await this.engine.removeSecret(id);
        }
    }

    async retire(workload: WorkloadRef, keep: number) {
        if (workload.kind !== 'plugin' || !PLUGIN_ID.test(workload.id) || !Number.isInteger(keep)) {
            return;
        }
        const failed: string[] = [];
        for (const version of olderVersions(keep)) {
            const name = identitySecretName(workload.id, version);
            try {
                const id = await this.engine.secretId(name);
                if (id) {
                    await this.engine.removeSecret(id);
                }
            } catch {
                failed.push(name);
            }
        }
        if (failed.length) {
            throw new RuntimeError(`Could not remove ${failed.join(', ')} yet; the next rotation tries again.`, 409);
        }
    }
}

/**
 * Local (development and tests): a 0400 file per version in a 0700
 * directory, `<dir>/plugin-<id>/identity-v<n>`. The workload must run
 * where it can read the runtime's files, so this never serves a Swarm
 * service behind the socket proxy (config.ts refuses that pairing).
 */
export class LocalIdentityDelivery implements IdentityDelivery {
    readonly platform = 'local' as const;
    constructor(private dir: string) {}

    private home(workload: WorkloadRef) {
        if (workload.kind !== 'plugin' || !PLUGIN_ID.test(workload.id)) {
            throw new RuntimeError('An identity is for a plugin with a routable id.', 400);
        }
        return join(this.dir, `plugin-${workload.id}`);
    }

    async deliver(workload: WorkloadRef, token: string, version: number): Promise<DeliveredIdentity> {
        checkRequest(workload, token, version);
        const home = this.home(workload);
        mkdirSync(home, { recursive: true, mode: 0o700 });
        chmodSync(home, 0o700);
        const path = join(home, `identity-v${version}`);
        rmSync(path, { force: true });
        writeFileSync(path, token, { mode: 0o400, flag: 'wx' });
        return { fileEnv: IDENTITY_FILE_ENV, path, version };
    }

    async discard(workload: WorkloadRef, version: number) {
        rmSync(join(this.home(workload), `identity-v${version}`), { force: true });
    }

    async retire(workload: WorkloadRef, keep: number) {
        const home = this.home(workload);
        let names: string[];
        try {
            names = readdirSync(home);
        } catch {
            return;
        }
        for (const name of names) {
            const match = /^identity-v(\d+)$/.exec(name);
            if (match && Number(match[1]) < keep) {
                rmSync(join(home, name), { force: true });
            }
        }
    }
}
