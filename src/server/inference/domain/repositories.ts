import type { BackendTest, InferenceCapabilities, OpenAICompatibleConfig } from '@socio/shared/inference';

import type { RoundKind } from '../contract.js';

/**
 * The Inference context's repositories (CB-110): shared
 * backends, the workspace's inference settings, people's own connections
 * and response times. Async, taking and returning plain domain types; only
 * `inference/infra` implements them, and nothing else touches the inference
 * tables. Every write works inside or outside a unit of work: outside one
 * it opens its own. Secrets stay sealed here: the service's `SecretBox`
 * seals and opens them, never a repository.
 */

/** A shared backend as stored: its key still sealed. */
export interface StoredBackend {
    id: string;
    kind: string;
    label: string;
    enabled: boolean;
    config: OpenAICompatibleConfig;
    /** The sealed `{ apiKey }`, or null without a key. */
    secrets: string | null;
    capabilities: InferenceCapabilities;
    lastTest: BackendTest | null;
    createdAt: number;
    updatedAt: number;
}

/** A backend's columns that change after it is created. */
export type BackendPatch = Partial<
    Pick<StoredBackend, 'label' | 'enabled' | 'config' | 'secrets' | 'capabilities' | 'lastTest' | 'updatedAt'>
>;

export interface InferenceBackendRepository {
    /** Oldest first (then by id). */
    all(): Promise<StoredBackend[]>;
    /** Whether any backend is stored. */
    any(): Promise<boolean>;
    byId(id: string): Promise<StoredBackend | undefined>;
    insert(backend: StoredBackend): Promise<void>;
    /** Changes the fields given; whether the backend exists. */
    update(id: string, patch: BackendPatch): Promise<boolean>;
    /** Whether it existed. */
    remove(id: string): Promise<boolean>;
    /** Sets the sealed key only while it is still `current`; whether it did. */
    replaceSecrets(id: string, current: string, next: string): Promise<boolean>;
}

/**
 * The workspace's inference settings, key and value: `defaultBackendId`,
 * `allowedByoKinds`, `byoModels` and the sealed `envSeed`.
 */
export interface InferenceSettingsRepository {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    /** Sets `key` to `next` only while it is still `current`; whether it did. */
    replace(key: string, current: string, next: string): Promise<boolean>;
}

/** A person's own connection of one kind, as stored: credentials sealed. */
export interface StoredConnection {
    userId: string;
    kind: string;
    /** The kind's credentials, sealed. */
    credentials: string;
    meta: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
}

export interface ByoConnectionRepository {
    get(userId: string, kind: string): Promise<StoredConnection | undefined>;
    /**
     * Stores or replaces a person's connection of a kind; a replaced one
     * keeps its `createdAt`.
     */
    save(connection: StoredConnection): Promise<void>;
    remove(userId: string, kind: string): Promise<void>;
    /** The kinds a person has a stored connection of, by name. */
    kinds(userId: string): Promise<string[]>;
    /** Every stored connection (re-sealing, CB-62). */
    all(): Promise<StoredConnection[]>;
    /** Sets the sealed credentials only while still `current`; whether it did. */
    replaceCredentials(userId: string, kind: string, current: string, next: string): Promise<boolean>;
    /**
     * Acquire the cross-runtime refresh lease (per-user providers step 5):
     * return whether this runtime acquired it, or another's lease expiry.
     */
    tryLeaseRefresh(
        userId: string,
        kind: string,
        by: string,
        until: number,
        now: number,
    ): Promise<{ acquired: boolean; leasedUntil: number }>;
    /** Release the lease this runtime holds. */
    releaseLease(userId: string, kind: string, by: string): Promise<void>;
}

/** One model round's response time and prompt size: numbers only. */
export interface StoredTiming {
    key: string;
    round: RoundKind;
    at: number;
    promptChars: number | null;
    promptTokens: number;
    uncachedTokens: number;
    ttftMs: number;
}

/** Response times per model, newest kept. */
export interface InferenceTimingRepository {
    /** Adds a sample and keeps only the key's latest `keep`. */
    add(sample: StoredTiming, keep: number): Promise<void>;
    /** A key's latest samples, newest first. */
    latest(key: string, limit: number): Promise<Omit<StoredTiming, 'key' | 'at'>[]>;
}

export interface InferenceRepositories {
    backends: InferenceBackendRepository;
    settings: InferenceSettingsRepository;
    connections: ByoConnectionRepository;
    timings: InferenceTimingRepository;
}
