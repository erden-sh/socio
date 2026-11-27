/**
 * The deployment's side of the cloud connection (protocol §2 and §3.1):
 * enrollment with provisioning's token, the sealed key, the access tokens
 * it exchanges signed assertions for, and the daily sync.
 *
 * Nothing here calls out unless the deployment holds an identity for the
 * configured issuer, or an enrollment token it hasn't tried to an end. A
 * deployment with neither, or with `SOCIO_CLOUD=off`, sends nothing.
 *
 * The identity is one sealed record (`CLOUD_IDENTITY_SETTING`). Every
 * runtime reads it; only the leader enrolls and syncs (`work`, the module's
 * tick). Each change is written against the sealed text it was read as, so
 * two runtimes can't write over each other.
 */
import { createHash, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';

import type { SealState, SecretBox } from '@socio/foundation/keys/secret-box';

import type { SecretSetting } from '../settings/contract.js';

import {
    CLOUD_IDENTITY_SETTING,
    type CloudEnvironment,
    type CloudShape,
    type CloudStatus,
    type DeploymentMode,
} from './contract.js';
import { CloudRequestError, IssuerClient, type IssuerMetadata } from './issuer-client.js';
import { newDeploymentKey, type DeploymentKey } from './key.js';
import { issuerOrigin } from './settings.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Waits after a failed try: enrollment's and sync's, then every 6 hours. */
const BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 360 * MINUTE];
/** The issuer's metadata is read again after this long. */
const METADATA_MS = 60 * MINUTE;
/** A token isn't asked for again this soon after a failure, however many callers want one. */
const RETRY_MS = 30_000;
/** While the issuer holds tokens back or refuses an audience, it is asked again this often. */
const HELD_MS = 5 * MINUTE;
/** The issuer's signing keys are kept this long (§2.5), and read again at most this often for an unknown `kid`. */
const KEYS_MS = 60 * MINUTE;
const KEYS_REREAD_MS = MINUTE;

/** The identity as kept: who the issuer says the deployment is, and the key that proves it. */
interface StoredIdentity {
    issuer: string;
    /** The deployment id (`client_id`). */
    clientId: string;
    key: DeploymentKey;
    deploymentMode: DeploymentMode;
    scopes: string[];
    enrolledAt: number;
    /** The terms the issuer said the enrollment accepted, when it said. */
    termsVersion?: string;
    /** When the issuer refused the key; nothing is sent for this identity after. */
    revokedAt?: number;
}

/** The sealed record. */
interface CloudRecord {
    v: 1;
    /** Made once; with the origin it is the fingerprint sync reports (§2.7, clone detection). */
    instanceId: string;
    identity?: StoredIdentity;
    /** The enrollment token last tried to an end: its hash, never the token. */
    enrollment?: { tokenHash: string; outcome: 'used' | 'refused'; at: number };
    /**
     * The issuer's last answer to a sync, for the Cloud connection card:
     * kept here, not only in the leader's memory, so every runtime shows it.
     */
    lastSync?: { at: number; paused: boolean };
}

function isRecord(value: unknown): value is CloudRecord {
    const record = value as CloudRecord | undefined;
    if (!record || typeof record !== 'object' || record.v !== 1 || typeof record.instanceId !== 'string') {
        return false;
    }
    const identity = record.identity;
    return (
        identity === undefined ||
        (typeof identity === 'object' &&
            typeof identity.issuer === 'string' &&
            typeof identity.clientId === 'string' &&
            typeof identity.key?.kid === 'string' &&
            typeof identity.key.privateJwk?.d === 'string' &&
            Array.isArray(identity.scopes))
    );
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('base64url');

export interface CloudServiceOptions {
    config: CloudEnvironment;
    store: {
        secretSetting(name: string): SecretSetting | undefined;
        /** Replaces the sealed value if it still is `previous`. */
        replaceSecretSetting(name: string, previous: string, next: string): Promise<boolean>;
        /** Adds the sealed value if there is none yet. */
        addSecretSetting(name: string, value: string): Promise<boolean>;
    };
    box: Pick<SecretBox, 'seal' | 'open' | 'reseal' | 'state' | 'valueKey'>;
    /** The app's public origin (`APP_ORIGIN`), when it has one. */
    origin: () => string | undefined;
    /** The running build's version. */
    version: () => string;
    /** Tells every active admin. */
    notifyAdmins: (notice: { trigger: string; title: string; message: string; path: string }) => Promise<unknown>;
    /** Operational lines only: never a token, a key or an answer's body. */
    log: (line: string) => void;
    /** The issuer's transport (tests: a fake issuer). */
    transport?: typeof fetch;
    now?: () => number;
}

interface CachedToken {
    token: string;
    /** Renewed from here on (80% of its life), and not used at all after `expiresAt`. */
    renewAt: number;
    expiresAt: number;
}

export class CloudService implements CloudShape {
    private readonly client: IssuerClient;
    private readonly now: () => number;
    /** The record as last opened, by its sealed text. */
    private opened?: { sealed: string; record?: CloudRecord };
    private metadata?: { value: IssuerMetadata; at: number };
    /** The issuer's signing keys, by `kid`, as last read. */
    private signingKeys?: { byKid: Map<string, KeyObject>; at: number };
    private readingKeys?: Promise<void>;
    private keysNotBefore = 0;
    /** Access tokens in memory only, per identity and audience (§2.4). */
    private tokens = new Map<string, CachedToken>();
    private minting = new Map<string, Promise<string | undefined>>();
    private notBefore = new Map<string, number>();
    /** A key the issuer refused, should writing that down have failed. */
    private refusedKid?: string;
    /** An enrollment token refused in this process, when that couldn't or shouldn't be written down. */
    private refusedToken?: string;
    private pausedUntil = 0;
    /** When this runtime last got a token: a stored "paused" sync older than that is over. */
    private tokenAt = 0;
    private lastSyncAt?: number;
    private nextEnrollAt = 0;
    private enrollFailures = 0;
    private nextSyncAt = 0;
    private syncFailures = 0;
    private working?: Promise<void>;
    private draining = false;
    private saidLost = false;
    private saidHeld = false;

    constructor(private readonly options: CloudServiceOptions) {
        this.client = new IssuerClient(options.config.issuer, options.transport);
        this.now = options.now ?? Date.now;
    }

    // ── The record ───────────────────────────────────────────────────────

    /** The record now: `sealed` when one is stored, `record` when it could be opened. */
    private read(): { sealed?: string; record?: CloudRecord } {
        const sealed = this.options.store.secretSetting(CLOUD_IDENTITY_SETTING)?.value;
        if (!sealed) {
            this.opened = undefined;
            return {};
        }
        if (this.opened?.sealed !== sealed) {
            let record: CloudRecord | undefined;
            try {
                const value = this.options.box.open(sealed);
                record = isRecord(value) ? value : undefined;
            } catch {
                record = undefined;
            }
            this.opened = { sealed, record };
            if (!record && !this.saidLost) {
                this.saidLost = true;
                this.options.log(
                    'Cloud connection lost: the stored identity can’t be opened with this data key. Nothing is sent until the server enrolls again.',
                );
            }
        }
        return { sealed, record: this.opened.record };
    }

    /** Writes the record against the sealed text it was read as; false if that changed meanwhile. */
    private async save(previous: string | undefined, record: CloudRecord): Promise<boolean> {
        const sealed = this.options.box.seal(record);
        const saved = previous
            ? await this.options.store.replaceSecretSetting(CLOUD_IDENTITY_SETTING, previous, sealed)
            : await this.options.store.addSecretSetting(CLOUD_IDENTITY_SETTING, sealed);
        if (saved) {
            this.opened = { sealed, record };
        }
        return saved;
    }

    /** The identity requests may be made with: this issuer's, and not refused. */
    private usable(): StoredIdentity | undefined {
        if (this.options.config.off) {
            return undefined;
        }
        const identity = this.read().record?.identity;
        if (
            !identity ||
            identity.issuer !== this.options.config.issuer ||
            identity.revokedAt !== undefined ||
            identity.key.kid === this.refusedKid
        ) {
            return undefined;
        }
        return identity;
    }

    status(): CloudStatus {
        const issuer = this.options.config.issuer;
        if (this.options.config.off) {
            return { connection: 'off', issuer, scopes: [] };
        }
        const { sealed, record } = this.read();
        if (sealed && !record) {
            return { connection: 'lost', issuer, scopes: [] };
        }
        const identity = record?.identity;
        if (!identity || identity.issuer !== issuer) {
            return { connection: 'not-connected', issuer, scopes: [] };
        }
        const revoked = identity.revokedAt !== undefined || identity.key.kid === this.refusedKid;
        const lastSync = record.lastSync;
        const paused = this.now() < this.pausedUntil || (!!lastSync?.paused && lastSync.at >= this.tokenAt);
        return {
            connection: revoked ? 'revoked' : paused ? 'paused' : 'connected',
            issuer,
            deploymentId: identity.clientId,
            deploymentMode: identity.deploymentMode,
            scopes: revoked ? [] : [...identity.scopes],
            enrolledAt: identity.enrolledAt,
            lastSyncAt: Math.max(this.lastSyncAt ?? 0, lastSync?.at ?? 0) || undefined,
        };
    }

    // ── Tokens ───────────────────────────────────────────────────────────

    private async issuerMetadata(): Promise<IssuerMetadata> {
        const now = this.now();
        if (!this.metadata || now - this.metadata.at >= METADATA_MS) {
            this.metadata = { value: await this.client.discover(), at: now };
        }
        return this.metadata.value;
    }

    /**
     * One of the issuer's signing keys (§2.5), by `kid`: kept an hour, and
     * read again for a `kid` it doesn't know, at most once a minute (the
     * issuer publishes its next key before it signs with it). Undefined for
     * a key the issuer doesn't publish; throws `CloudRequestError` when the
     * keys can't be read and none are kept.
     */
    async issuerKey(kid: string): Promise<KeyObject | undefined> {
        const now = this.now();
        const kept = this.signingKeys;
        const due = !kept || now - kept.at >= KEYS_MS || (!kept.byKid.has(kid) && now - kept.at >= KEYS_REREAD_MS);
        if (due && (this.readingKeys || now >= this.keysNotBefore)) {
            this.readingKeys ??= this.readKeys().finally(() => {
                this.readingKeys = undefined;
            });
            try {
                await this.readingKeys;
            } catch (error) {
                // A set read before still answers for the keys it has.
                if (!this.signingKeys) {
                    throw error;
                }
            }
        } else if (!kept) {
            throw new CloudRequestError('unreachable', 'issuer keys');
        }
        return this.signingKeys?.byKid.get(kid);
    }

    private async readKeys() {
        const at = this.now();
        // Read at most once a minute, whoever asks and however it ends.
        this.keysNotBefore = at + KEYS_REREAD_MS;
        const keys = await this.client.keys(await this.issuerMetadata());
        const byKid = new Map<string, KeyObject>();
        for (const jwk of keys) {
            try {
                byKid.set(jwk.kid, createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }));
            } catch {
                // A key node:crypto can't read is no key.
            }
        }
        this.signingKeys = { byKid, at };
    }

    async token(audience: string, options: { renew?: boolean } = {}): Promise<string | undefined> {
        let resource: string;
        try {
            // A service is named by its origin (§2.3), under the issuer's own rules for one.
            resource = issuerOrigin(audience, 'audience');
        } catch {
            return undefined;
        }
        const identity = this.usable();
        if (!identity) {
            return undefined;
        }
        const slot = `${identity.clientId}\n${identity.key.kid}\n${resource}`;
        const now = this.now();
        if (options.renew) {
            // The service refused it: never offered again, whatever its age.
            this.tokens.delete(slot);
        }
        const cached = this.tokens.get(slot);
        if (cached && now < cached.renewAt) {
            return cached.token;
        }
        if (now >= (this.notBefore.get(slot) ?? 0) && now >= this.pausedUntil) {
            let minting = this.minting.get(slot);
            if (!minting) {
                minting = this.mint(identity, resource, slot).finally(() => this.minting.delete(slot));
                this.minting.set(slot, minting);
            }
            const fresh = await minting;
            if (fresh) {
                return fresh;
            }
        }
        // The one it had, while that is still good: unless the issuer just refused the key, which emptied the cache.
        const kept = this.tokens.get(slot);
        return kept && this.now() < kept.expiresAt ? kept.token : undefined;
    }

    private async mint(identity: StoredIdentity, resource: string, slot: string): Promise<string | undefined> {
        const started = this.now();
        try {
            const issued = await this.client.token(
                await this.issuerMetadata(),
                identity.clientId,
                identity.key,
                resource,
                started,
            );
            // The identity may have been refused or replaced while this was in flight.
            if (this.usable()?.key.kid !== identity.key.kid) {
                return undefined;
            }
            const life = Math.min(issued.expiresIn, 24 * 3600) * 1000;
            this.tokens.set(slot, {
                token: issued.accessToken,
                renewAt: started + life * 0.8,
                // A minute short, for the clocks' difference.
                expiresAt: started + life - MINUTE,
            });
            this.pausedUntil = 0;
            this.tokenAt = this.now();
            return issued.accessToken;
        } catch (error) {
            const failure = error instanceof CloudRequestError ? error : undefined;
            if (failure?.kind === 'refused' && failure.code === 'invalid_client') {
                await this.refused(identity);
            } else if (failure?.kind === 'refused' && failure.code === 'unauthorized_client') {
                // The issuer holds tokens back until its staff confirm a changed origin (T4).
                if (this.now() >= this.pausedUntil) {
                    this.options.log('Cloud connection paused: the issuer is holding tokens back for this deployment.');
                }
                this.pausedUntil = this.now() + HELD_MS;
            } else {
                this.notBefore.set(slot, this.now() + (failure?.kind === 'unreachable' ? RETRY_MS : HELD_MS));
                this.options.log(`Cloud connection: no token (${failure?.message ?? 'unexpected error'}).`);
            }
            return undefined;
        }
    }

    /** §3.1, on `invalid_client`: forget the tokens, stop calling, and tell admins once. */
    private async refused(identity: StoredIdentity) {
        this.tokens.clear();
        this.refusedKid = identity.key.kid;
        for (let attempt = 0; attempt < 3; attempt++) {
            const { sealed, record } = this.read();
            const current = record?.identity;
            // Replaced by a new enrollment meanwhile, or already written down by another runtime.
            if (
                !sealed ||
                !record ||
                !current ||
                current.key.kid !== identity.key.kid ||
                current.revokedAt !== undefined
            ) {
                return;
            }
            if (await this.save(sealed, { ...record, identity: { ...current, revokedAt: this.now() } })) {
                this.options.log(
                    'Cloud connection revoked: the issuer refused this deployment’s key. Nothing more is sent.',
                );
                await this.options
                    .notifyAdmins({
                        trigger: 'cloud_revoked',
                        title: 'Cloud connection revoked',
                        message:
                            'The cloud services no longer accept this server’s key, so the server has stopped calling them. What depends on them is off until the server is enrolled again.',
                        path: '/settings',
                    })
                    .catch(() => undefined);
                return;
            }
        }
    }

    // ── The leader's work: enrollment and sync ───────────────────────────

    /**
     * What is due now: enrollment, when there is a token not yet tried to an
     * end, and the daily sync. The module's tick calls it, on the leader
     * only; a call while one runs joins it. It never throws.
     */
    work(): Promise<void> {
        if (this.options.config.off || this.draining) {
            return Promise.resolve();
        }
        this.working ??= this.dueWork()
            .catch((error: unknown) => {
                this.options.log(
                    `Cloud connection: ${error instanceof CloudRequestError ? error.message : 'unexpected error'}.`,
                );
            })
            .finally(() => {
                this.working = undefined;
            });
        return this.working;
    }

    async drain(): Promise<void> {
        this.draining = true;
        await this.working;
    }

    resume(): void {
        this.draining = false;
    }

    private async dueWork() {
        const token = this.options.config.enrollmentToken;
        if (token && this.now() >= this.nextEnrollAt && !this.settled(token) && !this.heldByLoss()) {
            try {
                await this.enroll(token);
                this.enrollFailures = 0;
                // The new identity syncs at once.
                this.nextSyncAt = 0;
                this.syncFailures = 0;
            } catch (error) {
                await this.enrollmentFailed(token, error);
            }
        }
        if (this.now() >= this.nextSyncAt && this.usable()) {
            try {
                await this.sync();
                this.syncFailures = 0;
                this.nextSyncAt = this.now() + DAY;
            } catch (error) {
                this.nextSyncAt = this.now() + BACKOFF[Math.min(this.syncFailures++, BACKOFF.length - 1)]!;
                throw error;
            }
        }
    }

    /**
     * Whether a lost identity holds enrollment back: the record that says
     * which token was spent can't be opened, so the token still mounted may
     * well be that one. Only `SOCIO_CLOUD_REPLACE_LOST=true` lets it through.
     */
    private heldByLoss(): boolean {
        const { sealed, record } = this.read();
        if (!sealed || record || this.options.config.replaceLost) {
            return false;
        }
        if (!this.saidHeld) {
            this.saidHeld = true;
            this.options.log(
                'Cloud connection: not enrolling over the lost identity. Set SOCIO_CLOUD_REPLACE_LOST=true with a new enrollment token to replace it.',
            );
        }
        return true;
    }

    /** Whether this enrollment token was already tried to an end: used, or refused for good. */
    private settled(token: string): boolean {
        const hash = tokenHash(token);
        return this.refusedToken === hash || this.read().record?.enrollment?.tokenHash === hash;
    }

    /**
     * §2.2: makes a keypair, registers its public half with the token, and
     * keeps the identity the issuer answers with. A token for a deployment
     * that already has an identity enrolls it again: the new key replaces
     * the old one, there and here (§2.5).
     *
     * The token is spent when the issuer answers. If the process dies before
     * the answer is stored, the key is lost with it, and provisioning issues
     * a new token: the issuer never hands the same identity out twice.
     */
    private async enroll(token: string) {
        const metadata = await this.issuerMetadata();
        const key = newDeploymentKey();
        const registration = await this.client.register(metadata, token, key, this.options.version());
        const now = this.now();
        const identity: StoredIdentity = {
            issuer: metadata.issuer,
            clientId: registration.clientId,
            key,
            deploymentMode: registration.deploymentMode,
            scopes: registration.scopes,
            enrolledAt: now,
            ...(registration.termsVersion ? { termsVersion: registration.termsVersion } : {}),
        };
        // The issuer now knows only this key, so this record wins over whatever was written meanwhile.
        for (let attempt = 0; ; attempt++) {
            const { sealed, record } = this.read();
            const saved = await this.save(sealed, {
                v: 1,
                instanceId: record?.instanceId ?? randomUUID(),
                identity,
                enrollment: { tokenHash: tokenHash(token), outcome: 'used', at: now },
            });
            if (saved) {
                break;
            }
            if (attempt === 4) {
                throw new Error('could not store the identity');
            }
        }
        this.tokens.clear();
        this.notBefore.clear();
        this.refusedKid = undefined;
        this.pausedUntil = 0;
        this.options.log(
            `Cloud connection: enrolled as ${registration.clientId} (${registration.deploymentMode}) at ${metadata.issuer}.`,
        );
    }

    private async enrollmentFailed(token: string, error: unknown) {
        const failure = error instanceof CloudRequestError ? error : undefined;
        // Only the registration carries the token: a refusal of discovery says nothing about it.
        if (failure?.kind === 'refused' && failure.what === 'registration') {
            // Not tried again in this process. A 401 is the token's end (used, expired or unknown),
            // so that is written down too; another refusal may be this build's, and a later one may pass.
            this.refusedToken = tokenHash(token);
            this.options.log(
                `Cloud connection: the enrollment token was refused (${failure.code ?? failure.status}). It is not tried again; a new token enrolls the server.`,
            );
            if (failure.status === 401) {
                // Awaited, so a drain waits for it: a shutdown never loses the record that the token is spent.
                await this.noteRefusal(token);
            }
            return;
        }
        this.nextEnrollAt = this.now() + BACKOFF[Math.min(this.enrollFailures++, BACKOFF.length - 1)]!;
        this.options.log(
            `Cloud connection: enrollment failed, to be tried again (${failure?.message ?? 'unexpected error'}).`,
        );
    }

    /** Writes down a token's refusal, beside the identity as it is. Never over a record that can't be opened. */
    private async noteRefusal(token: string) {
        try {
            const { sealed, record } = this.read();
            if (sealed && !record) {
                return;
            }
            await this.save(sealed, {
                ...(record ?? { v: 1, instanceId: randomUUID() }),
                enrollment: { tokenHash: tokenHash(token), outcome: 'refused', at: this.now() },
            });
        } catch {
            // Remembered for this process; the next one asks once more.
        }
    }

    /** §2.7: the version, the origin and the fingerprint, nothing else; the issuer's word on mode and scopes back. */
    private async sync() {
        const identity = this.usable();
        const instanceId = this.read().record?.instanceId;
        if (!identity || !instanceId) {
            return;
        }
        const metadata = await this.issuerMetadata();
        const origin = this.options.origin();
        const report = {
            version: this.options.version(),
            ...(origin ? { origin } : {}),
            fingerprint: createHash('sha256')
                .update(`${origin ?? ''}\n${instanceId}`)
                .digest('base64url'),
        };
        const send = async () => {
            const token = await this.token(metadata.issuer);
            if (!token) {
                // Refused, paused or unreachable: `token` has dealt with it.
                throw new CloudRequestError('unreachable', 'sync (no token)');
            }
            return this.client.sync(metadata, token, report);
        };
        let answer;
        try {
            answer = await send();
        } catch (error) {
            if (!(error instanceof CloudRequestError) || error.kind !== 'refused' || error.status !== 401) {
                throw error;
            }
            // §3.3's rule for a 401: a new token, once.
            for (const slot of this.tokens.keys()) {
                if (slot.endsWith(`\n${metadata.issuer}`)) {
                    this.tokens.delete(slot);
                }
            }
            answer = await send();
        }
        this.lastSyncAt = this.now();
        this.pausedUntil = answer.status === 'paused' ? this.now() + HELD_MS : 0;
        const { sealed, record } = this.read();
        const current = record?.identity;
        if (sealed && record && current?.key.kid === identity.key.kid && current.revokedAt === undefined) {
            // For the app's own display only (§2.7): services read the token, never this copy.
            // If another runtime wrote meanwhile, its newer record stands and this answer is dropped.
            await this.save(sealed, {
                ...record,
                identity: { ...current, deploymentMode: answer.deploymentMode, scopes: answer.scopes },
                lastSync: { at: this.lastSyncAt, paused: answer.status === 'paused' },
            });
        }
    }

    // ── The data key ─────────────────────────────────────────────────────

    /** The stored identity's seal, for the data key's counts (CB-62). */
    sealStates(): Record<SealState, number> {
        const counts = { current: 0, previous: 0, legacy: 0, unknown: 0 };
        const sealed = this.options.store.secretSetting(CLOUD_IDENTITY_SETTING)?.value;
        if (sealed) {
            counts[this.options.box.state(this.options.box.valueKey(sealed))]++;
        }
        return counts;
    }

    /** Seals the stored identity again under the current data key; idempotent. */
    async reseal() {
        const result = { resealed: 0, unreadable: 0 };
        const sealed = this.options.store.secretSetting(CLOUD_IDENTITY_SETTING)?.value;
        if (!sealed) {
            return result;
        }
        let next: string | undefined;
        try {
            next = this.options.box.reseal(sealed);
        } catch {
            result.unreadable++;
            return result;
        }
        if (next && (await this.options.store.replaceSecretSetting(CLOUD_IDENTITY_SETTING, sealed, next))) {
            result.resealed++;
        }
        return result;
    }
}
