import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { retiredSetting } from '@socio/foundation/settings/renamed-setting';
import { PLUGIN_IDENTITY_PREFIX, PLUGIN_IDENTITY_TOKEN } from '@socio/shared/identity-delivery';
import { parseRegistryCredential, PLUGIN_REGISTRY_SECRET } from '@socio/shared/plugins/registry-auth';

import { SqlitePluginIdentities } from './infra/identities.js';
import { pluginHash } from './infra/repository.js';

/**
 * How long a replaced identity stays accepted: long enough for a rolling
 * update's old tasks to drain (they keep the file they mounted).
 */
export const PLUGIN_IDENTITY_OVERLAP_MS = 15 * 60_000;

export interface IssuedIdentity {
    token: string;
    version: number;
}

/**
 * Per-plugin identity tokens: random, 32 bytes, stored hashed, bound to one
 * plugin, versioned.
 * They replace the shared `PLUGIN_SERVICE_TOKEN`. The token itself exists
 * only in the provision that delivers it; this keeps its hash.
 */
export class PluginIdentities {
    private rows: SqlitePluginIdentities;
    constructor(
        private db: DatabaseSync,
        private now: () => number = Date.now,
    ) {
        this.rows = new SqlitePluginIdentities(db);
    }

    /**
     * A new current version for `pluginId`; the one it replaces stays
     * accepted for `PLUGIN_IDENTITY_OVERLAP_MS`, an older one retires. With
     * `onlyIfMissing`, nothing when a current version exists: what the
     * migration of running plugins asks, so two Socio processes don't both
     * rotate.
     */
    async issue(pluginId: string, options: { onlyIfMissing?: boolean } = {}): Promise<IssuedIdentity | undefined> {
        const token = `${PLUGIN_IDENTITY_PREFIX}${randomBytes(32).toString('base64url')}`;
        const now = this.now();
        return transaction(this.db, 'issue plugin identity', () => {
            if (options.onlyIfMissing && this.rows.current(pluginId) !== undefined) {
                return undefined;
            }
            const version = this.rows.topVersion(pluginId) + 1;
            this.rows.rotate(pluginId, version, pluginHash(token), now, now + PLUGIN_IDENTITY_OVERLAP_MS);
            return { token, version };
        });
    }

    /**
     * A version whose provision failed never reached the plugin: it
     * retires, and the version it replaced (which the running service
     * still has) is current again.
     */
    async abandon(pluginId: string, version: number) {
        await transaction(this.db, 'abandon plugin identity', () => {
            const state = this.rows.stateOf(pluginId, version);
            if (!state || state === 'retired') {
                return;
            }
            this.rows.retire(pluginId, version, this.now());
            if (state !== 'current') {
                return;
            }
            const previous = this.rows.latestPrevious(pluginId);
            if (previous !== undefined) {
                this.rows.promote(pluginId, previous);
            }
        });
    }

    /** Whose identity a token is, while it is accepted: current, or previous within its window. */
    verify(token: string | undefined): { pluginId: string; version: number } | undefined {
        if (!token || !PLUGIN_IDENTITY_TOKEN.test(token) || !this.rows.exists()) {
            return undefined;
        }
        const row = this.rows.byHash(pluginHash(token));
        if (!row) {
            return undefined;
        }
        const accepted = row.state === 'current' || (row.state === 'previous' && (row.retireAt ?? 0) > this.now());
        return accepted ? { pluginId: row.pluginId, version: row.version } : undefined;
    }

    /**
     * Whether a version of a plugin's identity is still accepted: current,
     * or previous within its window. A data token exchanged for it lives no
     * longer than that.
     */
    accepts(pluginId: string, version: number): boolean {
        const row = this.rows.exists() ? this.rows.versionOf(pluginId, version) : undefined;
        return !!row && (row.state === 'current' || (row.state === 'previous' && (row.retireAt ?? 0) > this.now()));
    }

    /** Whose identity a token was, in any state (retired too); never says whether it is accepted. */
    lookup(token: string | undefined): { pluginId: string; version: number } | undefined {
        if (!token || !PLUGIN_IDENTITY_TOKEN.test(token) || !this.rows.exists()) {
            return undefined;
        }
        const row = this.rows.byHash(pluginHash(token));
        return row ? { pluginId: row.pluginId, version: row.version } : undefined;
    }

    /** The current version and when it was issued, if the plugin has one. */
    currentIssue(pluginId: string): { version: number; issuedAt: number } | undefined {
        return this.rows.exists() ? this.rows.currentIssue(pluginId) : undefined;
    }

    /** The current version, if the plugin has one. */
    current(pluginId: string): number | undefined {
        return this.rows.exists() ? this.rows.current(pluginId) : undefined;
    }

    /** Every version of an uninstalled plugin retires at once; the rows stay as the record. */
    async revoke(pluginId: string) {
        await transaction(this.db, 'revoke plugin identities', () => this.rows.retireAll(pluginId, this.now()));
    }
}

/**
 * The deprecated shared plugin token (per-plugin identities retired it):
 * `PLUGIN_SERVICE_TOKEN` is still accepted for one release, with a warning
 * at boot, so plugins still running on it keep working until Socio gives
 * them their own identity. `PLUGIN_SERVICE_TOKEN_SECRET` named its Swarm
 * secret in the planner's manifest; nothing reads it now.
 */
export function pluginServiceTokenFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void,
): { serviceToken?: string } {
    const token = retiredSetting(
        env,
        'PLUGIN_SERVICE_TOKEN',
        'each plugin service has its own identity token now (Socio Secrets), delivered without a hand-made secret.',
        warn,
    );
    retiredSetting(
        env,
        'PLUGIN_SERVICE_TOKEN_SECRET',
        'plugin services no longer mount a shared Swarm secret; nothing reads this setting.',
        warn,
    );
    return token ? { serviceToken: token } : {};
}

/**
 * `PLUGIN_REGISTRY_AUTH` (`_FILE`): the deployment's registry login for
 * plugin images, under the workspace secret of the same name. A value that
 * isn't the expected JSON is reported at boot (never quoted) and still
 * kept, so the reconcile reports it too instead of pulling without it
 * silently.
 */
export function pluginRegistryAuthFromEnv(
    env: Record<string, string | undefined>,
    warn: (line: string) => void,
): { registryAuth?: string } {
    const value = env[PLUGIN_REGISTRY_SECRET]?.trim();
    if (!value || value === 'none') {
        return {};
    }
    try {
        parseRegistryCredential(value);
    } catch (error) {
        warn(`${PLUGIN_REGISTRY_SECRET}: ${error instanceof Error ? error.message : 'not valid'}`);
    }
    return { registryAuth: value };
}
