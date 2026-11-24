/**
 * What other code may know of the "Ask a socio" panel (CB-26): its one
 * service, as a tag. It imports only `effect` and `@socio/*`, and holds no
 * logic.
 *
 * `layer.ts` provides `Ask`, made from the tags of what the panel reads: the
 * data space, schedules, the Board, page moves, the workspace's slices, its
 * pages and Space access. The module's hooks (`module.ts`) use the same
 * service.
 *
 * Not here, on purpose:
 * - No `AskConfig`: the panel reads no configuration.
 * - No `AskViews`: the panel has no view in `live/`.
 */
import { Context } from 'effect';

import type { DotTurn } from '@socio/foundation/turns/turn';
import type { AskContextRef, AskLookup, AskOpened } from '@socio/shared/ask';
import type { ThreadFollower } from '@socio/shared/auth';

/**
 * The panel's conversations: one per person, item and socio. Every call
 * reads the item again with the person's own access; a refusal rejects
 * with the panel's `AskError` (its message and status), as the routes
 * answer it.
 */
export interface AskShape {
    /** The item's conversation with `dotId` (default: the socio last asked), without making one. */
    lookup(userId: string, ref: AskContextRef, dotId?: string): Promise<AskLookup>;
    /** The person's conversation about the item with this socio, made on first use. */
    open(userId: string, ref: AskContextRef, dotId: string): Promise<AskOpened>;
    /** Remembers the socio the person picked, for the next screen. */
    pick(userId: string, dotId: string): void;
    /** The item a panel conversation is about, for this turn only, or an empty string. */
    turnNote(turn: DotTurn): Promise<string>;
}

/** The "Ask a socio" panel's service (CB-26). */
export class Ask extends Context.Service<Ask, AskShape>()('socio/ask/Ask') {}

/**
 * The context links a moved conversation keeps (CB-360's transfer): each
 * becomes the new owner's, or is dropped where they have one for that
 * context already. `infra/sqlite/ownership.ts` implements it.
 */
export type ContextThreadOwnershipShape = ThreadFollower;
