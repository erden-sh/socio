/**
 * What other features may know of socios' Souls (CB-179, CB-330): the
 * `Souls` tag, as the slice of `SoulStore` its callers use, the
 * `SoulTools` tag (the socio's own Soul tool for a turn), the error they
 * catch, the repository port and the tool's name. It imports only `effect`
 * and `@socio/*`, and holds no logic.
 *
 * The types, the error and the constant here moved from the files that
 * defined them (`souls.ts`, `domain/repositories.ts`, `tools.ts`); their
 * importers switched and the re-exports are gone. `SoulStore` implements
 * `SoulsShape`; `SoulTools` came later, and `SoulError` became a tagged
 * error (`layer.ts` implements the tags).
 *
 * Not here, on purpose:
 * - The `SoulStore` class: construction only. The workspace holds it
 *   (`WorkspaceStore`), built on its own connection by the factory from
 *   `composition/workspace-parts.ts`, and the root offers the workspace's store
 *   as `Souls`.
 * - `soulRoutes` and `soulsModule`: route mounting (inside the workspace
 *   routes today) and the module registry, entry code.
 * - `socioActor` and `selfSoulActor`: only `souls/` calls them.
 * - A `SoulsConfig` tag: souls reads no `PlatformConfig` field.
 */
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context, Data } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { SoulFields, SoulSource, SoulVersion } from '@socio/shared/soul';

// ── Constants ────────────────────────────────────────────────────────────

/** The socio's own Soul tool (CB-330), by name. */
export const SOUL_TOOL_NAMES: readonly string[] = ['edit_own_soul'];

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * Why a Soul change was refused; `status` is the HTTP answer. The routes
 * and the tool catch it with `instanceof` and answer with its message and
 * status. Its `name`, `message` and `String()` are those of the plain
 * `Error` it replaced.
 */
export class SoulError extends Data.TaggedError('SoulError')<{
    readonly message: string;
    readonly status: 400 | 403 | 404 | 409;
}> {}

// ── Repository ───────────────────────────────────────────────────────────

/** One version of a socio's Soul, as stored (`socio_souls`). */
export interface SoulRecord {
    dotId: string;
    version: number;
    instructions: string;
    voice: string;
    values: string;
    style: string;
    createdAt: number;
    createdBy: string;
    source: Exclude<SoulSource, 'migrated'>;
    restoredFrom: number | null;
}

/**
 * Souls' repository (CB-110): the versions of each socio's Soul, never
 * changed or removed; only `souls/infra` implements it. Its write is
 * synchronous (`…Now`), in the caller's transaction.
 */
export interface SoulRepository {
    /**
     * Adds a version and copies its standing instructions to the socio's
     * row (`dots.instructions`), so a build from before Souls still finds
     * them.
     */
    appendNow(soul: SoulRecord): void;
}

// ── Souls (`souls.ts`) ───────────────────────────────────────────────────

/** `SoulsShape.append`'s options. */
export interface SoulAppendOptions {
    restoredFrom?: number | null;
    now?: number;
    /** Lets the socio itself (`dot:<dotId>`) write its own Soul (CB-330). */
    allowSelf?: boolean;
}

/**
 * Each socio's Soul and its versions (CB-179): what the workspace's socios
 * (`current`, `append`), the Soul routes (`history`, `save`, `restore`)
 * and the socio's own tool (`saveSelf`) call. Refusals throw `SoulError`.
 */
export interface SoulsShape {
    /** The Soul in use: the newest version. */
    current(dotId: string): SoulVersion | undefined;
    /** Every version, newest first. */
    history(dotId: string): SoulVersion[];
    /** One version, or undefined. */
    version(dotId: string, version: number): SoulVersion | undefined;
    /** Adds the next version, inside the caller's transaction. */
    append(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        source: Exclude<SoulSource, 'migrated'>,
        options?: SoulAppendOptions,
    ): SoulVersion;
    /** An edit: a new version when the parts changed, else the one in use. */
    save(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        baseVersion?: number,
        now?: number,
        options?: { allowSelf?: boolean },
    ): Promise<SoulVersion>;
    /** Puts an earlier version back, as a new version. */
    restore(
        dotId: string,
        version: number,
        actor: string,
        baseVersion?: number,
        now?: number,
        options?: { allowSelf?: boolean },
    ): Promise<SoulVersion>;
    /** The socio edits its own Soul; `actor` must be `dot:<dotId>` (CB-330). */
    saveSelf(
        dotId: string,
        input: Partial<SoulFields>,
        actor: string,
        baseVersion?: number,
        now?: number,
    ): Promise<SoulVersion>;
    /** The socio restores a version of its own Soul (CB-330). */
    restoreSelf(
        dotId: string,
        version: number,
        actor: string,
        baseVersion?: number,
        now?: number,
    ): Promise<SoulVersion>;
}

/** Each socio's Soul (`WorkspaceStore.souls`, a `SoulStore`). */
export class Souls extends Context.Service<Souls, SoulsShape>()('socio/souls/Souls') {}

// ── The socio's own Soul tool (`tools.ts`) ───────────────────────────────

/** The socio's own Soul tool (CB-330), for one turn. */
export interface SoulToolsShape {
    /**
     * `edit_own_soul` for the turn's socio, or none: an archived socio, or
     * one the person it acts for may not edit (`canEditSoul`), gets none.
     */
    tools(turn: DotTurn): ToolDefinition[];
}

/** The socio's own Soul tool (`layer.ts`, over `Souls` and the workspace's slices). */
export class SoulTools extends Context.Service<SoulTools, SoulToolsShape>()('socio/souls/SoulTools') {}
