import { createHmac } from 'node:crypto';

import { sha256Hex } from '@socio/foundation/actors/keys';
import { isContinuationToken } from '@socio/foundation/actors/tokens';
import {
    ENVELOPE_TTL_MS,
    newJti,
    requestTargetHash,
    signEnvelope,
    type EnvelopeClaims,
} from '@socio/foundation/apps/envelope';
import {
    parseAudience,
    scopesCoverTier,
    type ActionTier,
    type ActorDenyReason,
    type ActorRevokeReason,
    type Audience,
} from '@socio/shared/actor-scopes';
import { canonicalJson } from '@socio/shared/jcs';
import { pluginAudience, pluginPermissionAccess } from '@socio/shared/plugins/plugins';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { pluginActorKey } from '../../apps-runtime/keys.js';
import type { ActorsShape, AudiencePolicy, CredentialRecord, TrackedHandle } from '../actors/contract.js';

import { bundledPlugins, type PluginToolDefinition } from './bundled.js';
import type { InstalledPlugin, PluginActorsShape, PluginCaller } from './contract.js';

/**
 * What socio-actor access needs of the plugin service (CB-232). The
 * install, the person, and the install's audience are the plugin
 * service's; this file never keeps a list of its own.
 */
export interface PluginActorHost {
    get(id: string): InstalledPlugin | undefined;
    /** The install's audience (CB-254): admins always, members when it says. */
    mayUse(row: InstalledPlugin | undefined, person: User | undefined): boolean;
    activeUser(userId: string): User | undefined;
    /** `x-cb-user`: the person's opaque per-plugin id. */
    personId(id: string, userId: string): string;
    /** The runtime's secret (`APPS_RUNTIME_TOKEN`): the envelope key's root. */
    runtimeToken?: string;
}

/**
 * A plugin's actions and their tiers, the one action set behind every way
 * in (CB-232, reconciling CB-254's audiences and scopes with the
 * `plugin:<id>` audience):
 *
 * - a bundled plugin's tools, each its permission's access
 *   (`pluginPermissionAccess`: `<area>:read` reads, anything else writes),
 *   only for permissions the install granted. The same mapping gives a
 *   connected agent's per-plugin scope (`plugins:<id>:read|write`);
 * - a service plugin's declared `delegation.actions`, only when it
 *   declares the contract (it verifies the envelope).
 *
 * Undefined while the plugin is disabled, or can't be delegated at all.
 */
export function pluginActionSet(row: InstalledPlugin | undefined): Record<string, ActionTier> | undefined {
    if (!row?.enabled) {
        return undefined;
    }
    if (row.mode === 'bundled') {
        const tools = (bundledPlugins[row.id]?.tools ?? []).filter((tool) => row.permissions.includes(tool.permission));
        if (!tools.length) {
            return undefined;
        }
        return Object.fromEntries(tools.map((tool) => [tool.name, pluginPermissionAccess(tool.permission)]));
    }
    const delegation = row.manifest.delegation;
    if (delegation?.contract !== 1) {
        return undefined;
    }
    return { ...delegation.actions };
}

/**
 * A plugin's policy version: SHA-256 of the JCS of its mode, its action set
 * and `alwaysAsk`. A build or manifest that changes what the plugin does
 * suspends grants made under the older one.
 */
export function pluginPolicyVersion(row: InstalledPlugin | undefined) {
    const actions = pluginActionSet(row);
    if (!row || !actions) {
        return undefined;
    }
    return sha256Hex(
        canonicalJson({
            contract: 1,
            mode: row.mode,
            actions,
            alwaysAsk: row.manifest.delegation?.alwaysAsk === true,
        }),
    );
}

/** Why a socio may not use a bundled plugin's tool now, in its words. */
const TOOL_REFUSED: Partial<Record<ActorDenyReason, string>> = {
    grant_missing: 'request access with request_app_access first; the person decides on its approval card',
    scope_insufficient:
        'your access to it is read-only; request write access with request_app_access; the person decides on its approval card',
    admin_tier: 'socios can’t use that',
    conversation_shared: 'delegated access isn’t available in Telegram groups and topics: ask in a private chat',
    policy_stale: 'it changed since you were given access; request it again with request_app_access',
    feature_off: 'socio access isn’t available to this person',
};

export type PluginToolDecision =
    | { ok: true; permissions: string[]; grantId: string }
    | { ok: false; message: string; reason: ActorDenyReason };

/**
 * Socio-actor access for plugins (CB-232): the `plugin` audience
 * policy, the check a bundled plugin's tool makes for a socio, envelopes
 * and on-behalf-of tokens for service plugins, and the end of a plugin's
 * grants. One permission system: who may use a plugin is its install's
 * audience (CB-254), which is this audience's `personMay`; what a socio
 * may do there is its grant's scopes over the plugin's action set, whose
 * tiers are the same as a connected agent's per-plugin scopes.
 */
export class PluginActors implements PluginActorsShape {
    constructor(
        private host: PluginActorHost,
        readonly actors: ActorsShape,
    ) {}

    private rowOf(audience: Audience) {
        const parsed = parseAudience(audience);
        return parsed?.kind === 'plugin' ? this.host.get(parsed.id) : undefined;
    }

    /** The `plugin` audience policy, registered once per platform. */
    policy(): AudiencePolicy {
        return {
            policyVersion: (audience) => pluginPolicyVersion(this.rowOf(audience)),
            // The install's audience is who may use the plugin, for people,
            // connected agents and socios alike (CB-254): one answer.
            personMay: (personId, audience) => this.host.mayUse(this.rowOf(audience), this.host.activeUser(personId)),
            alwaysAsk: (audience) => this.rowOf(audience)?.manifest.delegation?.alwaysAsk === true,
            actionTier: (audience, action) => {
                const actions = pluginActionSet(this.rowOf(audience));
                return actions && Object.hasOwn(actions, action) ? actions[action] : undefined;
            },
        };
    }

    /** Whether `socio-actor-access` is on for the person. */
    featureOn(personId: string) {
        return this.actors.featureOn(personId);
    }

    /**
     * A socio's use of a bundled plugin's tool for the turn's person: a
     * live grant of this person, socio and conversation for `plugin:<id>`
     * must allow the tool's tier. The grant comes from the turn, never from
     * the model. Every deny is audited; allows are sampled. The permissions
     * the tool then runs with are the install's, narrowed to the tiers the
     * grant covers.
     */
    async toolUse(
        row: InstalledPlugin,
        tool: PluginToolDefinition,
        socio: { id: string; personId: string; conversationId: string },
        permissions: readonly string[],
    ): Promise<PluginToolDecision> {
        const audience = pluginAudience(row.id);
        const { actors } = this;
        const correlationId = `a5-tool-${newJti()}`;
        const now = Date.now();
        const grants = actors.grants
            .unrevoked({
                personId: socio.personId,
                socioId: socio.id,
                conversationId: socio.conversationId,
                audience,
            })
            .filter((grant) => grant.expiresAt > now)
            .reverse();
        const refuse = (reason: ActorDenyReason, grantId?: string) => {
            actors.audit.decision(
                {
                    correlationId,
                    phase: 'decision',
                    decision: 'deny',
                    reason,
                    personId: socio.personId,
                    socioId: socio.id,
                    ...(grantId ? { grantId } : {}),
                    audience,
                    action: tool.name,
                },
                `${grantId ?? 'none'}|${tool.name}`,
            );
            const words = TOOL_REFUSED[reason] ?? 'this access was revoked';
            return {
                ok: false as const,
                reason,
                message: `You can’t use ${row.manifest.name} for this person here: ${words}${reason === 'grant_missing' || reason === 'scope_insufficient' ? ` (app: "${row.id}")` : ''}.`,
            };
        };
        if (!grants.length) {
            return refuse('grant_missing');
        }
        let first: ActorDenyReason | undefined;
        for (const grant of grants) {
            const decision = await actors.authorizer.authorize(grant.id, {
                audience,
                action: tool.name,
            });
            if (!decision.allowed) {
                first ??= decision.reason;
                continue;
            }
            actors.audit.decision(
                {
                    correlationId,
                    phase: 'decision',
                    decision: 'allow',
                    personId: grant.personId,
                    socioId: grant.socioId,
                    grantId: grant.id,
                    audience,
                    action: tool.name,
                    ...(decision.tier ? { tier: decision.tier } : {}),
                },
                `${grant.id}|${tool.name}`,
            );
            actors.grants.touch(grant.id);
            const covered = new Set(
                grant.scopes.flatMap((scope) =>
                    scope === 'app:read'
                        ? ['read']
                        : scope === 'app:write' || scope === 'app:act'
                          ? ['read', 'write']
                          : [],
                ),
            );
            return {
                ok: true,
                grantId: grant.id,
                permissions: permissions.filter((permission) => covered.has(pluginPermissionAccess(permission))),
            };
        }
        return refuse(first ?? 'grant_missing', grants[0]?.id);
    }

    // ---- service plugins: envelopes and on-behalf-of tokens ---------------
    /** The key the proxy signs `x-cb-actor` with for this plugin. */
    private key(id: string) {
        const secret = this.host.runtimeToken;
        return secret ? Buffer.from(pluginActorKey(secret, id), 'base64url') : undefined;
    }

    private opaque(label: string, id: string, value: string) {
        return createHmac('sha256', this.host.runtimeToken || 'plugin-person')
            .update(`${label}\u0000${id}\u0000${value}`)
            .digest('base64url')
            .slice(0, 22);
    }

    /**
     * The `x-cb-actor` value for one forwarded request to a service plugin:
     * `aud` is `plugin:<id>`, `sub` today's `x-cb-user`, `acc` `owner` for
     * admins (who manage plugins) and `space` for members, and for a socio
     * `act` and `scp` (its grant's scopes). Undefined without the runtime's
     * secret.
     */
    envelope(
        row: InstalledPlugin,
        input: {
            personId: string;
            sessionRef: string;
            obo?: string;
            method: string;
            target: string;
            socio?: { socioId: string; grantId: string; scopes: readonly string[] };
        },
    ) {
        const key = this.key(row.id);
        if (!key) {
            return undefined;
        }
        const person = this.host.activeUser(input.personId);
        const now = Date.now();
        const claims: EnvelopeClaims = {
            aud: pluginAudience(row.id),
            sub: this.host.personId(row.id, input.personId),
            acc: person && isAdmin(person) ? 'owner' : 'space',
            ...(input.socio
                ? {
                      act: {
                          typ: 'socio' as const,
                          id: this.opaque('socio-plugin-actor', row.id, input.socio.socioId),
                          grant: this.opaque('socio-plugin-grant', row.id, input.socio.grantId),
                      },
                      scp: input.socio.scopes.filter((scope) => scope.startsWith('app:')),
                  }
                : {}),
            sid: this.opaque('socio-plugin-session', row.id, input.sessionRef),
            ...(input.obo ? { obo: input.obo } : {}),
            req: {
                m: input.method.toUpperCase(),
                p: requestTargetHash(input.target),
            },
            iat: now,
            exp: now + ENVELOPE_TTL_MS,
            jti: newJti(),
            ver: null,
        };
        return signEnvelope(key, claims);
    }

    /** A `cbob_` for one request to the plugin, for `plugin:<id>` only. */
    mintObo(id: string, actor: { grantId: string } | { sessionHash: string }, requestId: string, ttlMs: number) {
        return this.actors.credentials.mintObo({
            appId: pluginAudience(id),
            ...actor,
            requestId,
            ttlMs,
        });
    }

    /**
     * A socio session's check at the plugin's origin: not while a live
     * runtime enforces an older contract (the rollback gap); the credential
     * for `plugin:<id>`, `bind` (the context proof), then `authorizeActor`
     * for a read of the plugin. The plugin's SDK enforces each action's tier
     * with `scp`; Socio's data routes theirs.
     */
    async check(id: string, token: string, correlationId: string, bind: (credential: CredentialRecord) => boolean) {
        if (!this.actors.issuable()) {
            return { ok: false as const, status: 403 as const };
        }
        return this.actors.check(
            token,
            {
                kind: 'cbsa',
                audience: pluginAudience(id),
                tier: 'read',
                correlationId,
            },
            bind,
        );
    }

    /** A context's proof key. */
    contextKey(contextId: string) {
        return this.actors.contextKey(contextId);
    }

    /** Holds a socio session's open response. */
    track(grantId: string, handle: TrackedHandle) {
        return this.actors.revocations.track(grantId, handle);
    }

    /**
     * Who a plugin service's call back into Socio is for, from its
     * `x-cb-obo`: the person whose plugin session it is, or the person a
     * socio's grant acts for, for a `read` (GET, HEAD) or `write` (anything
     * else) of the plugin. A token that doesn't open for this plugin, or
     * whose session or grant no longer allows it, is refused; it never
     * falls back to the service's own reach.
     *
     * A continuation is taken the same way as by the app data API: a
     * reference token for `plugin:<id>`, held by its grant, carrying no more
     * than it was issued with, and re-authorized on every use, so a revoked
     * or expired grant stops the job at its next call.
     */
    async caller(
        row: InstalledPlugin,
        token: string,
        method: string,
        session: (hash: string) => Promise<{ userId: string } | undefined>,
    ): Promise<PluginCaller> {
        const { actors } = this;
        const audience = pluginAudience(row.id);
        const refused: PluginCaller = {
            ok: false,
            status: 403,
            error: 'This access was revoked.',
        };
        const tier: ActionTier = ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'read' : 'write';
        const continuation = isContinuationToken(token)
            ? actors.credentials.resolve(token, { kind: 'continuation', audience })
            : undefined;
        const claims = continuation ? undefined : actors.credentials.openObo(token, audience);
        const correlationId =
            (continuation?.ok ? continuation.credential.contextId : undefined) ??
            claims?.requestId ??
            `a5-obo-${newJti()}`;
        const deny = (reason: ActorDenyReason, grantId?: string) => {
            const grant = grantId ? actors.grants.get(grantId) : undefined;
            actors.audit.decision(
                {
                    correlationId,
                    phase: 'decision',
                    decision: 'deny',
                    reason,
                    ...(grant
                        ? {
                              personId: grant.personId,
                              socioId: grant.socioId,
                              grantId: grant.id,
                          }
                        : {}),
                    audience,
                    action: `data.${tier}`,
                    tier,
                },
                `${grantId ?? 'none'}|data`,
            );
            return refused;
        };
        if (continuation) {
            if (!continuation.ok) {
                return deny(continuation.reason);
            }
            // It carries no more than it was issued with.
            if (!scopesCoverTier(continuation.credential.scopes, tier)) {
                return deny('scope_insufficient', continuation.grant.id);
            }
        } else if (!claims) {
            return deny('credential_invalid');
        }
        if (claims?.sessionHash) {
            const live = await session(claims.sessionHash);
            const user = live ? this.host.activeUser(live.userId) : undefined;
            if (!user || !this.host.mayUse(row, user)) {
                return deny('person_no_access');
            }
            return { ok: true, user };
        }
        const grantId = continuation?.ok ? continuation.grant.id : claims!.grantId!;
        if (!actors.issuable()) {
            return deny('contract_outdated', grantId);
        }
        const decision = await actors.authorizer.authorize(grantId, {
            audience,
            tier,
        });
        if (!decision.allowed) {
            return deny(decision.reason, grantId);
        }
        const grant = actors.grants.get(grantId)!;
        const user = this.host.activeUser(grant.personId);
        if (!user) {
            return deny('person_inactive', grantId);
        }
        actors.audit.decision(
            {
                correlationId,
                phase: 'decision',
                decision: 'allow',
                personId: grant.personId,
                socioId: grant.socioId,
                grantId,
                audience,
                action: `data.${tier}`,
                tier,
            },
            `${grantId}|data.${tier}`,
        );
        actors.grants.touch(grantId);
        return { ok: true, user, grantId };
    }

    /**
     * A contract plugin's call with no `x-cb-obo` (as for apps):
     * reads stay the service's own (a cache, a page); a write is refused,
     * since a write for a person must say whose it is. Audited.
     */
    backgroundRefused(row: InstalledPlugin, method: string) {
        if (row.manifest.delegation?.contract !== 1) {
            return false;
        }
        if (['GET', 'HEAD'].includes(method.toUpperCase())) {
            return false;
        }
        this.actors.audit.decision(
            {
                correlationId: `a5-bg-${newJti()}`,
                phase: 'decision',
                decision: 'deny',
                reason: 'obo_required',
                audience: pluginAudience(row.id),
                action: 'data.write',
                tier: 'write',
            },
            `${row.id}|background`,
        );
        return true;
    }

    // ---- the end of a plugin's grants ---------------------------------------
    /** Every grant for `plugin:<id>` ends (disabled, uninstalled). */
    async ended(id: string, by: string, reason: ActorRevokeReason) {
        return (await this.actors.revoke({ audience: pluginAudience(id) }, by, reason)).length;
    }

    /**
     * The install's audience changed: each grant for the plugin is checked
     * again now, and those whose person may no longer use it end
     * (`access_changed`).
     */
    async recheck(id: string, by: string) {
        return (await this.actors.reevaluate({ audience: pluginAudience(id) }, by)).length;
    }
}
