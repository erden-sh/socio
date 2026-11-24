import type { FlagDefinition, FlagEvaluation, FlagTargets } from '@socio/shared/flags';
import type { Role } from '@socio/shared/types';

import type { FlagLayers } from './contract.js';

/** Who a flag is evaluated for; a person the workspace doesn't know has no role. */
export interface FlagSubject {
    userId: string;
    role?: Role;
}

/** Whether a rule turns the flag on for this person. */
export const targets = (rule: FlagTargets, subject: FlagSubject) =>
    rule.enabled || (!!subject.role && rule.roles.includes(subject.role)) || rule.people.includes(subject.userId);

/** Whether this deployment has the flag at all: a `dev` flag only an internal one (CB-503). */
export const available = (flag: Pick<FlagDefinition, 'stage'>, internal: boolean) => internal || flag.stage !== 'dev';

/**
 * Why the workspace's admins can't set this flag, or null. This server's
 * configuration decides a locked server rule and what a plan leaves out;
 * Settings shows it read-only and names no role (CB-503). A `dev` flag in
 * a customer deployment isn't there at all.
 */
export function workspaceBlocked(
    flag: Pick<FlagDefinition, 'stage'>,
    layers: Pick<FlagLayers, 'instance' | 'tier'>,
    internal: boolean,
): string | null {
    if (!available(flag, internal)) {
        return 'Not available in this deployment.';
    }
    if (layers.instance?.locked) {
        return 'Set by this server’s configuration: admins can’t change it.';
    }
    if (layers.tier === false) {
        return 'Set by this server’s configuration: not part of this workspace’s plan.';
    }
    return null;
}

/**
 * A flag's value for one person (server-side only). First, a `dev` flag
 * in a customer deployment is off, whatever any layer says (CB-503). Then
 * each layer replaces the one before: default, env, instance rule, plan,
 * workspace rule. A locked instance rule and a plan that leaves the flag
 * out end it there. Nothing the person stores takes part (CB-503): only
 * this server's configuration and the workspace's admins decide who has a
 * flag, whatever its stage.
 */
export function evaluateFlag(
    flag: Pick<FlagDefinition, 'stage' | 'default'>,
    layers: FlagLayers,
    subject: FlagSubject,
    internal: boolean,
): FlagEvaluation {
    if (!available(flag, internal)) {
        return { enabled: false, source: 'deployment' };
    }
    let result: FlagEvaluation = { enabled: flag.default, source: 'default' };
    if (layers.env !== undefined) {
        result = { enabled: layers.env, source: 'env' };
    }
    if (layers.instance) {
        result = { enabled: targets(layers.instance, subject), source: 'instance' };
    }
    if (layers.instance?.locked) {
        return result;
    }
    if (layers.tier === false) {
        return { enabled: false, source: 'tier' };
    }
    if (layers.tier === true) {
        result = { enabled: true, source: 'tier' };
    }
    if (layers.workspace) {
        result = { enabled: targets(layers.workspace, subject), source: 'workspace' };
    }
    return result;
}
