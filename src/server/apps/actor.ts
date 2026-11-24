import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { personSeedOf } from '@socio/data/person-seed';
import { appEnvelopeKey, sha256Hex } from '@socio/foundation/actors/keys';
import { opaqueActorIds } from '@socio/foundation/actors/principal';
import {
    ENVELOPE_TTL_MS,
    newJti,
    PREVIOUS_KEY_GRACE_MS,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from '@socio/foundation/apps/envelope';
import { parseAudience, type ActionTier, type ActorScope, type Audience } from '@socio/shared/actor-scopes';
import type { AppDelegation, AppManifest } from '@socio/shared/apps/app-manifest';
import { canonicalJson } from '@socio/shared/jcs';

import type { AudiencePolicy } from '../actors/contract.js';
import type { SociosShape } from '../workspace/contract.js';

import type { ExtractionAwarePolicy } from './contract.js';
import { SqliteActorKeys } from './infra/actor-keys.js';

/** The environment names an app's envelope keys reach it under. */
export const ACTOR_KEY_ENV = {
    key: 'CB_ACTOR_KEY',
    previous: 'CB_ACTOR_KEY_PREVIOUS',
    previousUntil: 'CB_ACTOR_KEY_PREVIOUS_UNTIL',
} as const;

/**
 * An app version's policy version for socio access: SHA-256 of the JCS of
 * its contract, actions and `alwaysAsk`. A new version that changes them
 * suspends older grants until re-approved.
 */
export function actionSetHash(delegation: AppDelegation) {
    return sha256Hex(
        canonicalJson({
            contract: delegation.contract,
            actions: delegation.actions,
            alwaysAsk: delegation.alwaysAsk === true,
        }),
    );
}

/** The part of an app record socio access reads. */
export interface ActorApp {
    id: string;
    dotId: string;
    ownerUserId: string;
    status: 'ephemeral' | 'packaged' | 'promoted' | 'unpublished';
    liveVersion: number | null;
    createdAt: number;
}

export interface AppActorsDeps {
    db: DatabaseSync;
    /** The instance secret (SESSION_SECRET): keys and opaque ids. */
    secret: string;
    workspace: Pick<SociosShape, 'dot'>;
    /** A live app by id. */
    app(id: string): ActorApp | undefined;
    /** Owner, Space member, or nobody (`AppsService.access`). */
    access(personId: string, app: ActorApp): 'owner' | 'space' | undefined;
    /** A version's manifest, or the newest's when `version` is null. */
    manifest(appId: string, version: number | null): AppManifest | undefined;
    now?: () => number;
}

/**
 * Socio access for mini apps (CB-232): which apps take part, the `app`
 * audience policy, each app's envelope key and the envelope itself.
 *
 * Who receives envelopes and a key: promoted apps (immutable bundles in
 * the workspace app runtime), and a development app only on a
 * person-owned socio's computer when its newest packaged version declares
 * the contract. A development app on a company socio never does: anyone
 * sharing that computer can rewrite it, and computers never receive
 * `cbob_`.
 */
export class AppActors {
    private keys: SqliteActorKeys;
    private now: () => number;
    constructor(private deps: AppActorsDeps) {
        this.keys = new SqliteActorKeys(deps.db);
        this.now = deps.now ?? Date.now;
    }

    static inRuntime(app: Pick<ActorApp, 'status'>) {
        return app.status === 'promoted' || app.status === 'unpublished';
    }

    /** A development app whose computer belongs to one person. */
    private personOwned(app: ActorApp) {
        return !!this.deps.workspace.dot(app.dotId)?.ownerId;
    }

    /**
     * The manifest's socio-access contract: the live version's for a
     * promoted app, the newest packaged version's for a development app.
     */
    delegation(app: ActorApp): AppDelegation | undefined {
        const manifest = this.deps.manifest(app.id, AppActors.inRuntime(app) ? app.liveVersion : null);
        return manifest?.delegation?.contract === 1 ? manifest.delegation : undefined;
    }

    /** The version the proxy routes to; null for a development app. */
    version(app: ActorApp) {
        return AppActors.inRuntime(app) ? app.liveVersion : null;
    }

    /**
     * Whether the app gets envelopes and a key: promoted, or a development
     * app on a person-owned socio that declares the contract.
     */
    receivesEnvelopes(app: ActorApp) {
        if (app.status === 'promoted') {
            return true;
        }
        if (AppActors.inRuntime(app)) {
            return false;
        }
        return this.personOwned(app) && !!this.delegation(app);
    }

    private appOf(audience: Audience) {
        const parsed = parseAudience(audience);
        return parsed?.kind === 'app' ? this.deps.app(parsed.id) : undefined;
    }

    /**
     * The `app` audience policy: delegable while the app is served,
     * receives envelopes and declares the contract; its version is the
     * action set's hash; the person must still open it (and, for a
     * development app, be its socio's own person); tiers from the manifest.
     */
    policy(): AudiencePolicy & ExtractionAwarePolicy {
        return {
            policyVersion: (audience) => {
                const app = this.appOf(audience);
                if (!app || !this.receivesEnvelopes(app)) {
                    return undefined;
                }
                const delegation = this.delegation(app);
                return delegation ? actionSetHash(delegation) : undefined;
            },
            personMay: (personId, audience) => {
                const app = this.appOf(audience);
                if (!app || !this.deps.access(personId, app)) {
                    return false;
                }
                if (AppActors.inRuntime(app)) {
                    return true;
                }
                // Only the person whose socio's computer runs it.
                return app.ownerUserId === personId && this.deps.workspace.dot(app.dotId)?.ownerId === personId;
            },
            // Every access request shows the card. Part of the version above,
            // so turning it on suspends older grants.
            alwaysAsk: (audience) => {
                const app = this.appOf(audience);
                return !!app && this.delegation(app)?.alwaysAsk === true;
            },
            actionTier: (audience, action) => {
                const app = this.appOf(audience);
                const actions = app ? this.delegation(app)?.actions : undefined;
                return actions && Object.hasOwn(actions, action) ? (actions[action] as ActionTier) : undefined;
            },
            // CB-267 (CB-239): repository extractions reach only a promoted
            // app whose live version declares `"accepts": ["repo-extract"]`;
            // never a development app, whose source others can change. Asked
            // again at delivery, so retiring the declaration stops reads of
            // extractions made before.
            accepts: (audience, contract) => {
                const app = this.appOf(audience);
                return !!app && app.status === 'promoted' && this.delegation(app)?.accepts?.includes(contract) === true;
            },
        };
    }

    // ---- keys ----------------------------------------------------------------
    /** The app's current epoch: a rotation's, else its `createdAt`. */
    epoch(app: Pick<ActorApp, 'id' | 'createdAt'>) {
        return this.keys.get(app.id)?.epoch ?? app.createdAt;
    }

    /** The key the proxy signs with now. */
    key(app: Pick<ActorApp, 'id' | 'createdAt'>) {
        return appEnvelopeKey(this.deps.secret, app.id, this.epoch(app));
    }

    /**
     * The app's keys for its environment: the current one, and the previous
     * for 5 minutes after a rotation.
     */
    keyEnv(app: Pick<ActorApp, 'id' | 'createdAt'>): Record<string, string> {
        const row = this.keys.get(app.id);
        const env: Record<string, string> = {
            [ACTOR_KEY_ENV.key]: this.key(app).toString('base64url'),
        };
        if (row?.previousEpoch !== null && row?.previousEpoch !== undefined) {
            const until = (row.rotatedAt ?? 0) + PREVIOUS_KEY_GRACE_MS;
            if (until > this.now()) {
                env[ACTOR_KEY_ENV.previous] = appEnvelopeKey(this.deps.secret, app.id, row.previousEpoch).toString(
                    'base64url',
                );
                env[ACTOR_KEY_ENV.previousUntil] = String(until);
            }
        }
        return env;
    }

    /**
     * A new epoch (published again, retired, rotated by the owner): every
     * envelope signed before it fails at an app that has the new key.
     */
    async rotate(app: Pick<ActorApp, 'id' | 'createdAt'>) {
        return this.keys.rotate(app.id, this.epoch(app), this.now());
    }

    // ---- envelopes -----------------------------------------------------------
    /** An opaque per-app session id for the app's logs (`sid`). */
    sessionId(appId: string, ref: string) {
        return createHmac('sha256', this.deps.secret)
            .update(`socio-app-session\u0000${appId}\u0000${ref}`)
            .digest('base64url')
            .slice(0, 22);
    }

    /**
     * The `x-cb-actor` value for one forwarded request: `target` is the
     * exact request-target the proxy sends.
     */
    envelope(
        app: ActorApp,
        input: {
            personId: string;
            access: 'owner' | 'space';
            /** What `sid` is derived from: a session's hash, a socio session id. */
            sessionRef: string;
            obo?: string;
            method: string;
            target: string;
            socio?: {
                socioId: string;
                grantId: string;
                scopes: readonly ActorScope[];
            };
        },
    ) {
        const ids = opaqueActorIds(this.deps.secret, app.id, {
            personId: personSeedOf(this.deps.db, input.personId),
            ...(input.socio ? { socioId: input.socio.socioId, grantId: input.socio.grantId } : {}),
        });
        const now = this.now();
        const claims: EnvelopeClaims = {
            aud: app.id,
            sub: ids.sub,
            acc: input.access,
            ...(input.socio
                ? {
                      act: { typ: 'socio' as const, id: ids.socio!, grant: ids.grant! },
                      scp: input.socio.scopes.filter((scope) => scope.startsWith('app:')),
                  }
                : {}),
            sid: this.sessionId(app.id, input.sessionRef),
            ...(input.obo ? { obo: input.obo } : {}),
            req: {
                m: input.method.toUpperCase(),
                p: requestTargetHash(input.target),
            },
            iat: now,
            exp: now + ENVELOPE_TTL_MS,
            jti: newJti(),
            ver: this.version(app),
        };
        return signEnvelope(this.key(app), claims);
    }
}
