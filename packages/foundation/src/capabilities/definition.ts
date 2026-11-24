/**
 * What a module contributes to the `capabilities` tool: a capability and
 * what it reports for one turn. Moved from `capabilities/contract.ts`,
 * which re-exports both: the modules' contract names them, and
 * `modules/` sits below `capabilities/` in the folder order.
 */
import type { DotTurn } from '../turns/turn.js';

/** What a capability reports for one turn (its Dot and acting user). */
export interface CapabilityStatus {
    enabled: boolean;
    /** Why it is off, or how to turn it on, in a line. */
    note?: string;
    limits?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    /** Anything else the Dot should know (its scratch dataset, its folder). */
    details?: Record<string, unknown>;
}

/**
 * A capability a module contributes to the `capabilities` tool. The
 * description says how the capability is meant to be used: it is what a
 * Dot reads to discover it.
 */
export interface CapabilityDefinition {
    /** Dotted lowercase, unique: `data`, `pages`, `computer`, `web.read`. */
    id: string;
    label: string;
    description: string;
    /** The Dot tools it brings. */
    tools?: readonly string[];
    /** The approval capability ids its actions use (`data.create_dataset`). */
    approvals?: readonly string[];
    /** May read async repositories (CB-110). */
    status?: (turn: DotTurn) => CapabilityStatus | Promise<CapabilityStatus>;
}
