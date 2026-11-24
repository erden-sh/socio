import { randomUUID } from 'node:crypto';

import { nextTurn } from '@socio/data/events';
import type { UnitOfWork } from '@socio/data/uow';
import { RESEAL_BATCH, type SecretBox } from '@socio/foundation/keys/secret-box';
import type { BackendTest, InferenceCapabilities, OpenAICompatibleConfig } from '@socio/shared/inference';

import type { BackendRecord, ByoConnection, InferenceStoreShape } from './contract.js';
import type { InferenceRepositories, StoredBackend, StoredConnection } from './domain/repositories.js';

export interface BackendFields {
    kind: string;
    label: string;
    enabled: boolean;
    config: OpenAICompatibleConfig;
    capabilities: InferenceCapabilities;
    /** Undefined keeps the stored key (on update), null removes it. */
    apiKey?: string | null;
}

/**
 * The inference tables through the Inference repositories (CB-110), with
 * every secret sealed and opened by the `SecretBox` here; nothing here
 * logs. Changes that belong together run in one unit of work.
 */
export class InferenceStore implements InferenceStoreShape {
    constructor(
        private uow: UnitOfWork,
        private repos: InferenceRepositories,
        private box: SecretBox,
    ) {}

    private backendOf(row: StoredBackend): BackendRecord {
        let apiKey: string | undefined;
        let keyUnreadable = false;
        if (row.secrets) {
            try {
                const secrets = this.box.open(row.secrets) as { apiKey?: unknown };
                if (typeof secrets.apiKey === 'string' && secrets.apiKey) {
                    apiKey = secrets.apiKey;
                }
            } catch {
                keyUnreadable = true;
            }
        }
        return {
            id: row.id,
            kind: row.kind,
            label: row.label,
            enabled: row.enabled,
            config: row.config,
            capabilities: row.capabilities,
            lastTest: row.lastTest,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            apiKey,
            keyUnreadable,
            hasApiKey: !!row.secrets,
        };
    }

    async backends(): Promise<BackendRecord[]> {
        return (await this.repos.backends.all()).map((row) => this.backendOf(row));
    }
    /** Whether any backend is stored. */
    hasBackends() {
        return this.repos.backends.any();
    }
    async backend(id: string): Promise<BackendRecord | undefined> {
        const row = await this.repos.backends.byId(id);
        return row && this.backendOf(row);
    }
    async createBackend(fields: BackendFields): Promise<BackendRecord> {
        const id = randomUUID();
        const now = Date.now();
        return this.uow.run(
            async () => {
                await this.repos.backends.insert({
                    id,
                    kind: fields.kind,
                    label: fields.label,
                    enabled: fields.enabled,
                    config: fields.config,
                    secrets: fields.apiKey ? this.box.seal({ apiKey: fields.apiKey }) : null,
                    capabilities: fields.capabilities,
                    lastTest: null,
                    createdAt: now,
                    updatedAt: now,
                });
                return (await this.backend(id))!;
            },
            { label: 'add inference backend' },
        );
    }
    updateBackend(id: string, fields: BackendFields): Promise<BackendRecord | undefined> {
        return this.uow.run(
            async () => {
                const changed = await this.repos.backends.update(id, {
                    label: fields.label,
                    enabled: fields.enabled,
                    config: fields.config,
                    capabilities: fields.capabilities,
                    updatedAt: Date.now(),
                    ...(fields.apiKey !== undefined
                        ? {
                              secrets: fields.apiKey ? this.box.seal({ apiKey: fields.apiKey }) : null,
                          }
                        : {}),
                });
                return changed ? this.backend(id) : undefined;
            },
            { label: 'change inference backend' },
        );
    }
    async setEnabled(id: string, enabled: boolean) {
        await this.repos.backends.update(id, { enabled, updatedAt: Date.now() });
    }
    async recordTest(id: string, test: BackendTest) {
        await this.repos.backends.update(id, { lastTest: test });
    }
    deleteBackend(id: string) {
        return this.repos.backends.remove(id);
    }

    private setting(key: string) {
        return this.repos.settings.get(key);
    }
    private async setSetting(key: string, value: string | null) {
        if (value === null) {
            await this.repos.settings.remove(key);
        } else {
            await this.repos.settings.set(key, value);
        }
    }
    async defaultBackendId(): Promise<string | null> {
        return (await this.setting('defaultBackendId')) ?? null;
    }
    setDefaultBackendId(id: string | null) {
        return this.setSetting('defaultBackendId', id);
    }
    async allowedByoKinds(): Promise<string[]> {
        const value = await this.setting('allowedByoKinds');
        return value ? (JSON.parse(value) as string[]) : [];
    }
    setAllowedByoKinds(kinds: readonly string[]) {
        return this.setSetting('allowedByoKinds', JSON.stringify([...new Set(kinds)]));
    }
    /** The operator's model per bring-your-own kind (kinds with `models`). */
    async byoModels(): Promise<Record<string, string>> {
        const value = await this.setting('byoModels');
        return value ? (JSON.parse(value) as Record<string, string>) : {};
    }
    setByoModel(kind: string, model: string | null) {
        return this.uow.run(
            async () => {
                const models = await this.byoModels();
                if (model) {
                    models[kind] = model;
                } else {
                    delete models[kind];
                }
                await this.setSetting('byoModels', JSON.stringify(models));
            },
            { label: 'save inference model' },
        );
    }
    /**
     * The model settings the first backend was seeded with from the
     * environment (sealed: it holds the key), or `{}` when the database took
     * over without a seed. Absent until then.
     */
    async envSeed(): Promise<Record<string, unknown> | undefined> {
        const value = await this.setting('envSeed');
        if (value === undefined) {
            return undefined;
        }
        try {
            return this.box.open(value) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    setEnvSeed(seed: Record<string, unknown>) {
        return this.setSetting('envSeed', this.box.seal(seed));
    }

    private connectionOf(row: StoredConnection): ByoConnection | undefined {
        try {
            return {
                userId: row.userId,
                kind: row.kind,
                credentials: this.box.open(row.credentials),
                meta: row.meta,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
            };
        } catch {
            // Sealed under a key this server doesn't have: the user connects again.
            return undefined;
        }
    }
    async connection(userId: string, kind: string): Promise<ByoConnection | undefined> {
        const row = await this.repos.connections.get(userId, kind);
        return row && this.connectionOf(row);
    }
    /**
     * Seals and stores (or replaces) a person's connection, in one unit of
     * work. `whileConnected` drops the save when there is no stored
     * connection any more (the person disconnected meanwhile).
     */
    saveConnection(
        userId: string,
        kind: string,
        credentials: unknown,
        meta: Record<string, unknown> = {},
        { whileConnected = false } = {},
    ): Promise<ByoConnection | undefined> {
        const now = Date.now();
        const sealed = this.box.seal(credentials);
        return this.uow.run(
            async () => {
                if (whileConnected && !(await this.repos.connections.get(userId, kind))) {
                    return undefined;
                }
                await this.repos.connections.save({
                    userId,
                    kind,
                    credentials: sealed,
                    meta,
                    createdAt: now,
                    updatedAt: now,
                });
                return this.connection(userId, kind);
            },
            { label: 'save inference connection' },
        );
    }
    deleteConnection(userId: string, kind: string) {
        return this.repos.connections.remove(userId, kind);
    }
    /** The kinds a user has a stored connection of (readable or not). */
    connectedKinds(userId: string) {
        return this.repos.connections.kinds(userId);
    }
    /** Acquire the cross-runtime refresh lease (per-user providers step 5). */
    tryLeaseRefresh(
        userId: string,
        kind: string,
        by: string,
        until: number,
        now: number,
    ): Promise<{ acquired: boolean; leasedUntil: number }> {
        return this.repos.connections.tryLeaseRefresh(userId, kind, by, until, now);
    }
    /** Release the refresh lease this runtime holds. */
    releaseLease(userId: string, kind: string, by: string): Promise<void> {
        return this.repos.connections.releaseLease(userId, kind, by);
    }

    /** Every sealed value: where it is, and the value. */
    private async sealedValues() {
        const { backends, connections, settings } = this.repos;
        const seed = await settings.get('envSeed');
        return [
            ...(await backends.all())
                .filter((row) => row.secrets !== null)
                .map((row) => ({
                    value: row.secrets!,
                    update: (next: string) => backends.replaceSecrets(row.id, row.secrets!, next),
                })),
            ...(await connections.all()).map((row) => ({
                value: row.credentials,
                update: (next: string) => connections.replaceCredentials(row.userId, row.kind, row.credentials, next),
            })),
            ...(seed === undefined
                ? []
                : [
                      {
                          value: seed,
                          update: (next: string) => settings.replace('envSeed', seed, next),
                      },
                  ]),
        ];
    }
    /** How many stored secrets each key state seals (CB-62). */
    async sealStates() {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        for (const { value } of await this.sealedValues()) {
            counts[this.box.state(this.box.valueKey(value))]++;
        }
        return counts;
    }
    /**
     * Seals every stored secret again under the current key (CB-62), each
     * only if it is unchanged meanwhile. Idempotent: values already under it
     * are skipped. Unreadable ones (a key this server doesn't have) stay as
     * they are and are counted.
     */
    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        let done = 0;
        for (const { value, update } of await this.sealedValues()) {
            if (++done % RESEAL_BATCH === 0) {
                await nextTurn();
            }
            let next: string | undefined;
            try {
                next = this.box.reseal(value);
            } catch {
                result.unreadable++;
                continue;
            }
            if (next && (await update(next))) {
                result.resealed++;
            }
        }
        return result;
    }
}
