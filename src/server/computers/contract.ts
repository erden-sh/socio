/**
 * What other features may know of the socios' computers: the tags for what
 * they and the composition ask of this folder, as slices of the methods they
 * call, and its plain types and constants. It imports only `effect` and
 * `@socio/*`, and holds no logic.
 *
 * The types and constants here moved from the files that defined them
 * (`computer-service.ts`, `computer-disk-usage.ts`, `computer-tools.ts`), which
 * re-export them, so every importer keeps compiling until that importer
 * switches to the contract. The classes implement their shapes.
 *
 * `computers/layer.ts` implements the tags, which the composition root
 * (`composition/computers.ts`) provides.
 *
 * Not here, on purpose:
 * - `computerTools` and `computersModule`: only this folder's module and
 *   `modules/` (entry wiring) use them.
 * - `ComputerTimeout` and `ComputerConflict`: no other folder throws or
 *   catches them. They stay plain `Error` subclasses in
 *   `computer-service.ts`, which still rejects its promises with them (the
 *   routes' `onError` answers by their message).
 * - `computerSecretPath`, `BROWSER_STUCK`, `STUCK_BROWSER_MS` and
 *   `COMPUTER_SECRET_PATH`: only this folder and its tests read them.
 */
import { Context } from 'effect';

import type { ComputerExecEnv } from '@socio/foundation/turns/turn';
import type { AppComputerState } from '@socio/shared/apps/app-types';
import type { ComputerDiskStatus, ComputerResourceStats } from '@socio/shared/computers/computer-resources';
import type {
    ComputerAction,
    ComputerAudit,
    ComputerPermissions,
    ComputerStatus,
} from '@socio/shared/computers/computer-types';
import type { DeploymentMetrics } from '@socio/shared/operations/deployment-metrics';
import type { ToolImage } from '@socio/shared/tool-images';

// ── Types ────────────────────────────────────────────────────────────────

/** One computer's resource reading for the operations sampler (CB-164). */
export interface ComputerTelemetryReading {
    dotId: string;
    stats: ComputerResourceStats;
    /** Checked inside the SQLite writer queue so a late result cannot outlive stop. */
    current: () => boolean;
}

/** Where a mini app on a Dot's computer listens, or why there is none. */
export type AppTarget =
    | { state: 'running'; host: string; port: number }
    | { state: Exclude<AppComputerState, 'running'> };

/** Trusted gateway identity; never parsed from a model or browser action payload. */
export type ComputerPrincipal = { kind: 'person' | 'app' | 'job'; id: string };

/** What a caller may set for one action instead of the platform's hooks (jobs). */
export interface ComputerActionOptions {
    principal?: ComputerPrincipal;
    /**
     * Exec only: this file and prefix instead of the computer session's;
     * `null` for none (the command gets no data token).
     */
    env?: ComputerExecEnv | null;
    /** Redacted from the response too. */
    secrets?: readonly string[];
    /**
     * Screenshot only: asks for a JPEG of this quality (CB-157) rather than
     * a PNG. A computer image from before CB-157 ignores it and sends a PNG.
     */
    jpegQuality?: number;
}

/** One socio's computer disk use, from the last measurement (CB-197). */
export interface ComputerDiskReading {
    /** Workspace, browser profile and private volumes together. */
    volumeBytes: number | null;
    /** The computer container's writable layer (Docker's SizeRw). */
    containerBytes: number | null;
}

/**
 * What a socio's activity shows of a computer-audit line. The same shape as
 * `ComputerActivity` in `integrations/contract.ts`, which the
 * audit repository returns; that one can re-export this one once
 * `integrations/` switches.
 */
export interface ComputerActivity {
    action: string;
    actor: string;
    outcome: string;
    userId: string | null;
    createdAt: number;
}

/** Where a turn's screenshots are kept: the conversation's attachments. */
export interface ToolImageStore {
    save(image: { name: string; bytes: Uint8Array; width?: number; height?: number }): Promise<ToolImage>;
}

/** What a screenshot's result says of its page, without the image's bytes. */
export interface ScreenshotPage {
    url?: string;
    width?: number;
    height?: number;
    capturedAt?: string;
}

/**
 * A screenshot's result as history keeps it (CB-157): the page, and the
 * stored image's reference or why there is none.
 */
export type ScreenshotResult = ScreenshotPage & ({ image: ToolImage } | { error: string });

// ── Constants ────────────────────────────────────────────────────────────

/**
 * A page's address at most this long in a screenshot's result: a result
 * that names an image stays short enough to be read as one (`toolImageOf`).
 */
export const SCREENSHOT_URL_CHARS = 2_000;

// ── Computers ────────────────────────────────────────────────────────────

/**
 * The computers' disk usage (CB-197): the last measurement from the
 * read-only disk usage proxy, which `refresh` starts when one is due.
 * `ComputerDiskUsage` implements it.
 */
export interface ComputerDiskShape {
    status(): ComputerDiskStatus;
    /** One socio's computer, or nulls when there is no fresh measurement. */
    reading(dotId: string): ComputerDiskReading;
    /** A coding sandbox's workspace volume (CB-239), or null. */
    workspace(volumeKey: string): number | null;
    /** Starts a measurement when one is due. Never waits for it. */
    refresh(signal?: AbortSignal): void;
}

/**
 * The slice of `ComputerService` that the composition, the computer routes and
 * module, and other features (apps, coding, dots, operations, schedules)
 * call. `ComputerService` implements it.
 */
export interface ComputersShape {
    /** Whether the supervisor and the computers' tokens are set. */
    readonly configured: boolean;
    /** Whether a socio's computer last read as running; null before a reading. */
    resourceState(id: string): boolean | null;
    readonly disk: ComputerDiskShape;
    diskStatus(): ComputerDiskStatus;
    /**
     * The deployment's resource use (CB-321), through the read-only disk
     * usage proxy; null when it isn't set up. `operations/` reads it.
     */
    readonly deployment: DeploymentMetrics | null;
    /** Platform-only reads: no ensure, shell, credential minting or control takeover. */
    resourceReadings(signal?: AbortSignal): Promise<ComputerTelemetryReading[]>;
    status(id: string): Promise<ComputerStatus>;
    /** Where a mini app on the socio's computer listens, or why there is none. */
    appTarget(id: string, port: number, signal?: AbortSignal): Promise<AppTarget>;
    /** Writes a file as the platform; the secrets are redacted from the response. */
    writeFile(
        id: string,
        path: string,
        contents: string,
        principal: ComputerPrincipal,
        secrets?: readonly string[],
    ): Promise<void>;
    permissions(id: string, input: unknown, userId?: string): Promise<ComputerStatus>;
    start(id: string, userId?: string): Promise<ComputerStatus>;
    /** Starts the computer for the socio's own work (a job run); returns how long the wake took. */
    ensureRunning(id: string, options: { userId?: string; signal?: AbortSignal; waitMs: number }): Promise<number>;
    stop(id: string, userId?: string): Promise<ComputerStatus>;
    control(id: string, verb: 'take' | 'release', userId?: string): Promise<ComputerStatus>;
    action(
        id: string,
        action: ComputerAction,
        input: unknown,
        actor?: 'owner' | 'agent',
        signal?: AbortSignal,
        userId?: string,
        options?: ComputerActionOptions,
    ): Promise<unknown>;
}

export class Computers extends Context.Service<Computers, ComputersShape>()('socio/computers/Computers') {}

/**
 * Per-socio computer permissions and the computer audit (CB-110), which
 * `WorkspaceStore.computers` holds and other features read (apps,
 * capabilities, dots, operations, schedules, workspace). `ComputerStore`
 * implements it.
 */
export interface ComputerRecordsShape {
    /** Whether this person used this computer before (shared data access). */
    usedBy(userId: string, dotId: string): boolean;
    /** The socio's permissions; all off when none were saved. */
    permissions(id: string): Promise<ComputerPermissions>;
    patch(id: string, patch: Partial<ComputerPermissions>): Promise<ComputerPermissions>;
    /** A pending audit entry; returns its id. */
    begin(dotId: string, action: string, actor: 'owner' | 'agent' | 'platform', userId?: string): string;
    finish(id: string, outcome: 'succeeded' | 'failed'): void;
    /** The socio's latest entries. */
    audit(id: string): Promise<ComputerAudit[]>;
    /** The socio's entries at or before `before`, newest first (its activity). */
    activity(dotId: string, before: number, limit: number): Promise<ComputerActivity[]>;
}

export class ComputerRecords extends Context.Service<ComputerRecords, ComputerRecordsShape>()(
    'socio/computers/ComputerRecords',
) {}

/**
 * The computer actions in progress, across every `ComputerService`: an
 * operator's force stop (`runtime/force-stop.ts`) counts and aborts them.
 * Today `computerActionsInFlight` and `abortComputerActions` in
 * `computer-service.ts`.
 */
export interface ComputerWorkShape {
    /** How many computer actions are in progress. */
    inFlight(): number;
    /**
     * Aborts every computer action in progress; returns how many. Only the
     * requests end: the computers keep running.
     */
    abort(): number;
}

export class ComputerWork extends Context.Service<ComputerWork, ComputerWorkShape>()('socio/computers/ComputerWork') {}

/**
 * A screenshot's result as history keeps it (CB-157), for the tools that
 * take one (`apps/browse-tools.ts`). Today `screenshotResult` in
 * `computer-tools.ts`. Not a package helper yet: it tells `MediaError` (still
 * in `media/service.ts`) from other failures.
 */
export interface ScreenshotsShape {
    result(result: unknown, images: ToolImageStore | undefined, now?: Date): Promise<ScreenshotResult>;
}

export class Screenshots extends Context.Service<Screenshots, ScreenshotsShape>()('socio/computers/Screenshots') {}

// ── Config ───────────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `computers/` reads. `PlatformConfig` has each
 * of them with this type, so the composition root can provide the tag from
 * it.
 */
export interface ComputersConfigShape {
    /** The computer supervisor's base URL. */
    readonly computerSupervisorUrl?: string;
    /** The supervisor's token; the disk usage proxy takes it too. */
    readonly computerSupervisorToken?: string;
    /** The token the computers themselves take. */
    readonly computerToken?: string;
    /** The supervisor's namespace for the computers' containers and volumes. */
    readonly computerNamespace?: string;
    /** The read-only disk usage proxy (CB-197); empty: disk usage is not set up. */
    readonly computerDiskUsageUrl?: string;
}

export class ComputersConfig extends Context.Service<ComputersConfig, ComputersConfigShape>()(
    'socio/computers/ComputersConfig',
) {}
