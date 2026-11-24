/**
 * What other features may know of capabilities: the `capabilities` tool's
 * registry tag, the slice of it they call, and the plain types and constant
 * around it. It imports only `effect` and `@socio/*`, and holds no logic.
 *
 * The types here moved from `registry.ts` and the tool name from `tool.ts`.
 * `CapabilityRegistry` implements `CapabilitiesShape`.
 *
 * The `identity` and `requests` sections read web's and the Board's
 * through two ports declared here (`CapabilityIdentity`,
 * `CapabilityRequests`), which the composition provides from web's
 * `WebCapabilities` and issues' `Board`, so capabilities imports neither.
 *
 * Not here, on purpose:
 * - `registerCoreCapabilities` (`core.ts`), the layer (`layer.ts`) and
 *   `capabilitiesTool` (`tool.ts`) are construction: only composition
 *   calls them.
 * - `CapabilitiesConfig` has no `web` (web's `WebSettings`): the `identity`
 *   section reads the web through `CapabilityIdentity` (web's
 *   `WebCapabilities`), which binds its own settings.
 */
import { Context } from 'effect';

import type { CapabilityDefinition } from '@socio/foundation/capabilities/definition';
import type { WebSearchProvider } from '@socio/foundation/search/providers';
import type { DotTurn } from '@socio/foundation/turns/turn';

// ── Constants ────────────────────────────────────────────────────────────

/** The tool that answers what a socio can do (`capabilitiesTool`). */
export const CAPABILITIES_TOOL = 'capabilities';

// ── Plain types ──────────────────────────────────────────────────────────

/**
 * A capability and what it reports for one turn: moved to the foundation,
 * since the modules' contract names them and `modules/` sits below this
 * folder.
 */
export type { CapabilityDefinition, CapabilityStatus } from '@socio/foundation/capabilities/definition';

/**
 * A named part of the `capabilities` answer besides the list: `identity`
 * (the web identity policy) and `requests` (capability requests).
 * Registering a section with a name that exists replaces it, so the real
 * sections swap out their placeholders.
 */
export type CapabilitySection = (turn: DotTurn) => unknown;

// ── Services ─────────────────────────────────────────────────────────────

/**
 * The platform's capability registry (`LegacyCapabilities`), as
 * composition, operations' coverage and the `capabilities` tool use it.
 * `CapabilityRegistry` implements it.
 */
export interface CapabilitiesShape {
    /** Adds one; throws on an invalid or repeated id. */
    register(definition: CapabilityDefinition): CapabilitiesShape;
    /** Adds or replaces a named section of the answer. */
    section(name: string, section: CapabilitySection): CapabilitiesShape;
    /** Every registered capability, in registration order. */
    list(): CapabilityDefinition[];
    /** The capability that brings a tool, if one declares it. */
    forTool(name: string): CapabilityDefinition | undefined;
    /** Everything the `capabilities` tool answers for one turn. */
    describe(
        turn: DotTurn,
        policy: (capability: string) => string,
        toolNames: readonly string[],
    ): Promise<Record<string, unknown> & { capabilities: unknown[] }>;
}

export class Capabilities extends Context.Service<Capabilities, CapabilitiesShape>()(
    'socio/capabilities/Capabilities',
) {}

// ── Ports the sections read ──────────────────────────────────────────────

/**
 * The `identity` section: a Dot's web identity, limits and the hosts
 * that asked it to stop. The composition provides web's `WebCapabilities`.
 */
export interface CapabilityIdentityShape {
    capabilityFor(dotId: string): Promise<unknown>;
}

export class CapabilityIdentity extends Context.Service<CapabilityIdentity, CapabilityIdentityShape>()(
    'socio/capabilities/CapabilityIdentity',
) {}

/**
 * The `requests` section: this Dot's capability requests for this
 * user. The composition provides issues' `Board.requests`.
 */
export interface CapabilityRequestsShape {
    pendingRequestsFor(dotId: string, userId: string): Promise<unknown[]>;
    resolvedRequestsFor(dotId: string, userId: string): Promise<unknown[]>;
}

export class CapabilityRequests extends Context.Service<CapabilityRequests, CapabilityRequestsShape>()(
    'socio/capabilities/CapabilityRequests',
) {}

// ── Config ───────────────────────────────────────────────────────────────

/** The `PlatformConfig` fields capabilities reads (see above). */
export interface CapabilitiesConfigShape {
    /** With the two tokens, whether the `computer` capability can be on. */
    readonly computerSupervisorUrl?: string;
    readonly computerSupervisorToken?: string;
    readonly computerToken?: string;
    /** Whether `web.research` can search (`searches(config)`), with the workspace's settings. */
    readonly webSearchProvider?: WebSearchProvider;
}

export class CapabilitiesConfig extends Context.Service<CapabilitiesConfig, CapabilitiesConfigShape>()(
    'socio/capabilities/CapabilitiesConfig',
) {}
