/**
 * The updater's platform port (CB-323): what the updater needs from
 * whatever runs the deployment. The updater keeps the job, its steps and
 * its history; the platform deploys a release tag, says when the new
 * version is healthy, and puts the previous deployment back.
 * `UPDATER_PLATFORM` picks the adapter; `portainer` is the default and, so
 * far, the only one (`platforms.ts`). Swarm only for now (owner decision,
 * 2026-11-01): Portainer first.
 */

/** The adapters, by their `UPDATER_PLATFORM` value. */
export const UPDATER_PLATFORMS = ['portainer'] as const;
export type UpdaterPlatformName = (typeof UPDATER_PLATFORMS)[number];
export const DEFAULT_UPDATER_PLATFORM: UpdaterPlatformName = 'portainer';

/**
 * Each adapter's own credentials, read from `<NAME>_FILE` like the app's
 * secrets. The adapter owns them: no other part of the updater reads them.
 */
export const PLATFORM_SECRET_SETTINGS: Record<UpdaterPlatformName, readonly string[]> = {
    portainer: ['UPDATER_PORTAINER_TOKEN'],
};

/** `UPDATER_PLATFORM`: unset is the default; anything unknown stops startup. */
export function parseUpdaterPlatform(raw: string | undefined): UpdaterPlatformName {
    const value = raw?.trim().toLowerCase() || DEFAULT_UPDATER_PLATFORM;
    if (!(UPDATER_PLATFORMS as readonly string[]).includes(value)) {
        throw new Error(
            `UPDATER_PLATFORM must be ${UPDATER_PLATFORMS.join(' or ')} (the platforms the updater can deploy to so far), not "${value.slice(0, 40)}".`,
        );
    }
    return value as UpdaterPlatformName;
}

/**
 * The platform could not be reached or refused a call: a deploy can't be
 * planned (502 before anything changed) or a step failed (a rollback).
 * Messages name the call and status, never credentials or env values.
 */
export class PlatformError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'PlatformError';
    }
}

export type HealthResult = { ok: true } | { ok: false; reason: string };

/** A deploy planned and checked, with nothing changed yet. */
export interface PreparedDeploy<State> {
    /**
     * What the adapter needs to deploy, check and roll back, kept in the
     * job on disk (JSON) so a restarted updater carries on. Private to the
     * updater: never in its status.
     */
    state: State;
    /** What the deploy will change, for the job's first step. */
    summary: string;
}

/**
 * The port: deploy a tag, wait until healthy, roll back. `prepare` reads
 * the deployment and checks the deploy can happen without changing
 * anything; it refuses with a `PlanError` (the deployment isn't ready:
 * 409) or a `PlatformError` (unreachable: 502).
 */
export interface UpdaterPlatform<State = unknown> {
    readonly name: UpdaterPlatformName;
    /** What it updates and where, for the startup line. */
    readonly describe: string;
    prepare(target: string): Promise<PreparedDeploy<State>>;
    /** Moves the deployment to the planned tag. */
    deploy(state: State): Promise<void>;
    /**
     * Whether the deploy took effect, for an update cut off around it.
     * Throws when it can't tell (the updater then checks health instead).
     */
    deployed(state: State): Promise<boolean>;
    /** Healthy at `version`, steadily, before the timeout. */
    waitHealthy(version: string): Promise<HealthResult>;
    /** Puts the deployment back exactly as `prepare` found it. */
    rollBack(state: State): Promise<void>;
}
