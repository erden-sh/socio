import type { ProfileRepository, TimeZoneNoteRepository, TimeZonesShape, TurnMemoryShape } from './contract.js';
import { spaceMemoryForTurn } from './space-memory.js';
import { movedTimeZone, rememberBrowserTimeZone, turnTimeZone } from './time-zone.js';
import { personalContext, sharedChat } from './turn.js';

/**
 * The contract's functional tags over today's functions: the composition
 * root provides `TurnMemory` and `TimeZones` over the platform's store and
 * workspace.
 * Each method calls the function of the same name with them, so nothing a
 * caller sees changes.
 */

/** `TurnMemory`: a turn's recall, on the store's repositories and the workspace. */
export const turnMemory = (
    store: Parameters<typeof personalContext>[0] & Parameters<typeof spaceMemoryForTurn>[0],
    workspace: Parameters<typeof sharedChat>[0] & Parameters<typeof spaceMemoryForTurn>[1],
): TurnMemoryShape => ({
    sharedChat: (threadId, userId) => sharedChat(workspace, threadId, userId),
    personalContext: (turn) => personalContext(store, turn),
    spaceMemoryForTurn: (turn) => spaceMemoryForTurn(store, workspace, turn),
});

/** `TimeZones`: a person's time zone, on the store's profiles and time zone notes. */
export const timeZones = (store: {
    profiles: ProfileRepository;
    timeZoneNotes: TimeZoneNoteRepository;
}): TimeZonesShape => ({
    turnTimeZone: (userId, browser, shared, workspaceZone) =>
        turnTimeZone(store.profiles, userId, browser, shared, workspaceZone),
    movedTimeZone: (userId, place) => movedTimeZone(store.profiles, store.timeZoneNotes, userId, place),
    rememberBrowserTimeZone: (userId, browser, now) =>
        rememberBrowserTimeZone(store.profiles, userId, browser, now, store.timeZoneNotes),
});
