/**
 * What other features may know of mini apps: tags, the slices of the apps
 * service they call, and plain types. It imports only `effect`, `@socio/*`
 * packages and other features' contracts, and holds no logic.
 *
 * `Apps` is the slice of `AppsService` (`LegacyApps`) that other
 * folders and the composition root call; `AppsService` implements it.
 * `AppsConfig` is what apps reads of the platform's configuration. The
 * actor envelope codec, the apps' host names and settings, and their log
 * retention are pure helpers in `@socio/foundation/apps/*`.
 *
 * Socio access's repository extraction route reads the coding gateways,
 * which sit above apps in the folder order: what it reads of them is
 * stated here (`ExtractionAwarePolicy`, `ExtractionDelivery`,
 * `AppExtractions`), and the gateways implement it.
 */
import type { Buffer } from 'node:buffer';

import { Context } from 'effect';

import type { AppsSettings } from '@socio/foundation/apps/settings';
import type { Audience } from '@socio/shared/actor-scopes';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { AppManifest } from '@socio/shared/apps/app-manifest';
import type { AppsHealthSummary, AppStatus, WorkspaceAppEntry } from '@socio/shared/apps/app-types';
import type { OwnedList, TransferParties, TransferTally } from '@socio/shared/auth';

import type { TelegramThreadInfo } from '../integrations/contract.js';

// ── Plain types ──────────────────────────────────────────────────────────

/** A live app as the registry reads it (`AppsService.get`). */
export type AppRecord = {
    id: string;
    slug: string;
    name: string;
    description: string;
    dotId: string;
    ownerUserId: string;
    port: number;
    sharedSpaceId: string | null;
    startCommand: string | null;
    status: AppStatus;
    liveVersion: number | null;
    previousVersion: number | null;
    /** The owner's values for the manifest's env names (JSON). */
    config: string;
    promotedAt: number | null;
    createdAt: number;
    updatedAt: number;
    datasets: string[];
};

/** How the app reaches the workspace app runtime (`APPS_RUNTIME_*`). */
export interface AppsRuntimeSettings {
    /** `APPS_RUNTIME_URL`: its API, e.g. http://company-brain-apps:4330. */
    url: string;
    /** `APPS_RUNTIME_TOKEN` (`_FILE`): shared with the runtime only. */
    token: string;
    /** Its ingress (same host, `APPS_RUNTIME_INGRESS_PORT`, 4331). */
    ingress: { host: string; port: number };
    /** The data API as the runtime's apps reach it (`APPS_RUNTIME_DATA_URL`). */
    dataApiUrl?: string;
}

/**
 * What an app's or a plugin's audience policy may add: whether the app
 * declares `"accepts": ["repo-extract"]` in its manifest's `delegation`
 * block (CB-232). Without it no app is eligible.
 */
export interface ExtractionAwarePolicy {
    accepts?(audience: Audience, contract: 'repo-extract'): boolean | Promise<boolean>;
}

/** What delivery answers the extraction route (`GET /api/apps/actor/extractions/:id`). */
export type ExtractionDelivery =
    | { status: 200; body: Buffer; contentType: 'application/json' }
    | { status: 401 | 403 | 404 | 410; error: string };

/**
 * A repository extraction's delivery for that route (CB-239): the Git
 * gateway's (`gateway/extract.ts`), which the composition hands the routes.
 */
export type AppExtractions = (input: {
    id: string;
    appId: string;
    obo: string | undefined;
}) => Promise<ExtractionDelivery>;

/**
 * Socio access's extraction delivery, for the module's routes: the
 * composition provides it with the coding gateways it adopts.
 */
export class AppExtractionDelivery extends Context.Service<AppExtractionDelivery, AppExtractions>()(
    'socio/apps/AppExtractionDelivery',
) {}

/**
 * A chat's Telegram facts, as the app browser's tools tell a Telegram group
 * (`turnConversation`): telegram's `Links`, by the slice they call
 * (telegram is above apps in the folder order, so the port is declared
 * here and the composition provides it from `Links`).
 */
export interface AppsTelegramShape {
    readonly threadInfo: (threadId: string) => Promise<TelegramThreadInfo | undefined>;
}

export class AppsTelegram extends Context.Service<AppsTelegram, AppsTelegramShape>()('socio/apps/AppsTelegram') {}

// ── Apps ─────────────────────────────────────────────────────────────────

/**
 * What other features read from the mini app registry (`LegacyApps`).
 * `apps/service.ts` implements it.
 */
export interface AppsService {
    /** Mini apps are on (APPS_HOST or APP_ORIGIN is set). */
    readonly enabled: boolean;
    /** Promotion and handoff; other features read the launcher. */
    readonly promotions: AppLauncher;
    /** A live app; a deleted one is missing (CB-64). */
    get(id: string): AppRecord | undefined;
    /** Every live app. */
    all(): AppRecord[];
    /** The app's own origin; throws while mini apps are off. */
    url(app: Pick<AppRecord, 'id'>): string;
    /**
     * Owner, or someone who may read the Space it is shared with (the one
     * Space access rule, CB-181); nobody else. Asked on every request.
     */
    access(userId: string, app: AppRecord): 'owner' | 'space' | undefined;
    /**
     * Ends a person's sessions on every app's origin and their unused
     * sign-in codes (they were deactivated), and those apps' open
     * connections. Returns how many sessions ended.
     */
    endSessionsOf(userId: string): Promise<number>;
    /** How many sessions `endSessionsOf` would end now (CB-360's deactivation preview). */
    sessionCountOf(userId: string): Promise<number>;
}

/** What other features read from app promotions (`apps/promotion.ts`). */
export interface AppLauncher {
    /** Promoted apps a user may open: launcher and sidebar entries. */
    launcherFor(userId: string): WorkspaceAppEntry[];
}

/** Retained OOM attempts of promoted apps in a period, by Dot (CB-146). */
export interface AppOoms {
    oomsByDot(from: number, to: number): Promise<Array<{ dotId: string; count: number; lastAt: number }>>;
}

/**
 * The promotions slice callers outside `apps/` use: the launcher, a
 * version's manifest (the Socio Secrets an app declares) and the OOM
 * attempts the operations dashboard counts.
 */
export interface AppPromotionsShape extends AppLauncher {
    /** A version's manifest; the latest when `version` is null or missing. */
    manifestOf(appId: string, version?: number | null): AppManifest | undefined;
    /** Build and start attempts with their logs (CB-146). */
    readonly attempts: AppOoms;
}

/**
 * The slice of `AppsService` other folders and the composition root call:
 * `AppsService` (the registry reads) plus socio reach (actors), and the
 * computer hooks the Dots' computers take (redaction and stop).
 * Construction-time bindings (`usePlugins`, `useWorkloadSecrets`,
 * `useRuntime`, `useTargets`) are not in it: they are wiring. `apps/layer.ts`
 * builds the registry from tags; the plugins module and the workspace
 * secrets' step still bind theirs late.
 */
export interface AppsShape extends AppsService {
    readonly promotions: AppPromotionsShape;
    /** A socio may reach the app for this person, in this conversation (CB-232). */
    socioMayReach(app: AppRecord, userId: string, conversationId: string, dotId: string): boolean;
    /** Development apps stop with their Dot's computer; promoted apps keep running. */
    computerStopped(dotId: string): void;
    /**
     * Tokens (and envelope keys, CB-232) apps of this Dot hold: redacted
     * from its computer's responses.
     */
    secretsFor(dotId: string): string[];
    /** Self-healing as Operations → Health shows it (CB-291). */
    healthSummary(): AppsHealthSummary;
    /**
     * After a transfer of ownership committed (CB-360): these apps' data
     * tokens name their old owner. Each is revoked, and a running promoted
     * app is restarted with the new owner's. Returns a note per app.
     */
    handedOver(appIds: readonly string[]): Promise<string[]>;
}

export class Apps extends Context.Service<Apps, AppsShape>()('socio/apps/Apps') {}

// ── Ownership (CB-360) ───────────────────────────────────────────────────

/**
 * The apps a person owns, and handing them to another person (CB-360's
 * transfer). An app's bundles are files in its owner's data space and it
 * reads its owner's datasets, so the caller moves the data space in the
 * same transaction. `infra/sqlite/ownership.ts` implements it.
 */
export interface AppOwnershipShape {
    owned(userId: string): OwnedList;
    /**
     * Every app of `from`, deleted ones too; run inside the caller's
     * transaction. `appIds`: the live ones, for `AppsShape.handedOver`.
     */
    transfer(parties: TransferParties): TransferTally & { appIds: string[] };
}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * What `apps/` reads of the platform's configuration. Each field has
 * `PlatformConfig`'s type, so the composition root provides the tag from
 * it; `dataApiUrl` is `config.data?.apiUrl`.
 */
export interface AppsConfigShape {
    /** Mini apps' origin and limits (`appsSettingsFromEnv`); off when unset. */
    readonly apps?: AppsSettings;
    /** The workspace app runtime for promoted apps (`APPS_RUNTIME_URL`). */
    readonly appsRuntime?: AppsRuntimeSettings;
    /** `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS` (CB-175), under an admin's in Settings. */
    readonly appLogs?: Partial<AppLogRetention>;
    /** The data API apps' servers call (`DATA_API_URL`). */
    readonly dataApiUrl?: string;
    /** `SESSION_SECRET`: the app browser's context key (CB-232); none when unset. */
    readonly sessionSecret?: string;
}

export class AppsConfig extends Context.Service<AppsConfig, AppsConfigShape>()('socio/apps/AppsConfig') {}
