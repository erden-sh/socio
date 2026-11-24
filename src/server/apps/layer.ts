/**
 * Mini apps' layers: they implement `contract.ts`'s `Apps`. The registry is
 * built from the tags it reads: the workspace's slices (`Socios`, `People`,
 * `Spaces`, `Audit`, `Conversations`), spaces' `Access`, the computers'
 * `ComputerRecords` and `Screenshots`, the approvals, the data space,
 * socio access (`AppActors`, and the instance secret in `ActorsConfig`),
 * the workspace settings (the log retention an admin saved), `AppsConfig`,
 * and `AppsBoot`, what no feature's tag offers yet. Only the composition
 * root (`composition/apps.ts`) and tests import this file.
 *
 * The service stays the promise-based `AppsService`: its callers (the
 * routes, the tools, the proxy, other features) call it as before.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { appLogRetention } from '@socio/foundation/apps/log-retention';

import { ActorsConfig, AppActors, type AppActorAccess } from '../actors/contract.js';
import { Approvals, type ApprovalsShape } from '../approvals/contract.js';
import { ComputerRecords, Screenshots, type ComputersShape, type ScreenshotsShape } from '../computers/contract.js';
import { Data, type DataSpaceShape } from '../dataspace/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../settings/contract.js';
import { Access } from '../spaces/contract.js';
import { Audit, Conversations, People, Socios, Spaces, type SpacesShape } from '../workspace/contract.js';

import { Apps, AppsConfig, type AppsConfigShape } from './contract.js';
import { AppsRuntimeClient } from './runtime-client.js';
import { AppsService } from './service.js';
import type { AppsWorkspace } from './slices.js';

/**
 * What the boot step hands the apps that no feature's tag offers: the
 * workspace connection their tables are on, and the computers, which are
 * built after the apps (their late-bound port).
 */
export interface AppsBootShape {
    readonly db: DatabaseSync;
    readonly computers: () => ComputersShape;
}

export class AppsBoot extends Context.Service<AppsBoot, AppsBootShape>()('socio/apps/AppsBoot') {}

/** Everything the platform's app registry is made of, from the tags or a platform built on its own. */
export interface AppsParts extends AppsBootShape {
    readonly config: AppsConfigShape;
    /** The instance secret the opaque per-person ids derive from. */
    readonly secret: string;
    readonly approvals: ApprovalsShape;
    readonly workspace: AppsWorkspace;
    /** Where a Space's change of readers is announced (CB-181, CB-277). */
    readonly spaces: Pick<SpacesShape, 'onSpaceAccessChange'>;
    readonly data: DataSpaceShape;
    readonly actors: AppActorAccess;
    /** The workspace settings, read on each prune for the log retention an admin saved (CB-175). */
    readonly settings: Pick<WorkspaceSettingsShape, 'settings'>;
    readonly screenshots: ScreenshotsShape;
    readonly log: (line: string) => void;
}

/**
 * Mini apps, whose open connections close when a Space they are shared
 * with changes who reads it.
 */
export function makeApps(parts: AppsParts): AppsService {
    const { config } = parts;
    const apps = new AppsService(parts.db, {
        settings: config.apps,
        secret: parts.secret,
        approvals: parts.approvals,
        workspace: parts.workspace,
        data: parts.data,
        computers: parts.computers,
        dataApiUrl: config.dataApiUrl,
        runtime: config.appsRuntime ? new AppsRuntimeClient(config.appsRuntime) : undefined,
        bundleLimits: config.apps?.bundle,
        logRetention: () => appLogRetention(parts.settings.settings(), config.appLogs),
        actors: parts.actors,
        screenshots: parts.screenshots,
        log: parts.log,
    });
    // Someone left a Space, it was made private (CB-181) or deleted
    // (CB-277): apps shared with it drop their open connections; each
    // reconnects only if its person still reads the Space.
    parts.spaces.onSpaceAccessChange((spaceId) => apps.closeSpaceSockets(spaceId));
    return apps;
}

/** The workspace as the apps read it, from its slices' tags, Space access and the computers' records. */
export const appsWorkspace = Effect.gen(function* () {
    const socios = yield* Socios;
    const people = yield* People;
    const spaces = yield* Spaces;
    const audit = yield* Audit;
    const conversations = yield* Conversations;
    return {
        dot: (id) => socios.dot(id),
        dots: () => socios.dots(),
        users: () => people.users(),
        spaces: () => spaces.spaces(),
        audit: (entry, now) => audit.audit(entry, now),
        thread: (id) => conversations.thread(id),
        socioReader: (threadId, dotId) => conversations.socioReader(threadId, dotId),
        spaceAccess: yield* Access,
        computers: yield* ComputerRecords,
    } satisfies AppsWorkspace as AppsWorkspace;
});

/** The registry, from the tags it reads. */
export const appsService = Effect.gen(function* () {
    const boot = yield* AppsBoot;
    return makeApps({
        db: boot.db,
        computers: boot.computers,
        config: yield* AppsConfig,
        secret: (yield* ActorsConfig).secret,
        approvals: yield* Approvals,
        workspace: yield* appsWorkspace,
        spaces: yield* Spaces,
        data: yield* Data,
        actors: yield* AppActors,
        settings: yield* WorkspaceSettings,
        screenshots: yield* Screenshots,
        log: (line) => console.log(line),
    });
});

/** `Apps`, over a registry built once. */
export const AppsLive = Layer.effect(Apps, appsService);
