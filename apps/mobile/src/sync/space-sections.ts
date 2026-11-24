import type { SpaceRadar } from '@socio/shared/pages/page-radar';
import type { SpaceMemoryState } from '@socio/shared/space-memory';

import type { SqlConnection } from '../data';
import type { AuthedFetch } from '../net/authed-fetch';

import { type BoundedItem, type BoundedStore, createBoundedStore } from './bounded-kind';
import { SnapshotShapeError } from './errors';
import { spaceBodyPrefix } from './pages';

// A Space's radar and memory,
// read-only, the pages store's `sections`: one bounded kind (bounded-kind.ts)
// keyed by the Space and the section, `<spaceId>/radar` (`GET
// /api/spaces/:id/radar`, CB-282) and `<spaceId>/memory` (`GET
// /api/spaces/:id/memory`, CB-181), each read as its tab opens (`use()`), so
// the last answer shows offline with its age. Nothing polls them.
// - Their keys start with the Space's body prefix (`spaceBodyPrefix`), so a
//   Space the person lost drops them in its bodies' transaction.
// - A 404 (a Space the person may not read) drops the copy, as for a page body.
// No React Native: tests/sync runs it under Node.

export const SPACE_SECTIONS_KIND = 'space-section';
/** Sections kept on disk at most: a radar and a memory for each of 50 Spaces. */
export const SPACE_SECTIONS_KEPT = 100;
/** About how many characters of them are kept on disk at most. */
export const SPACE_SECTIONS_CHARS = 5_000_000;

/** The Space's sections besides its pages. */
export type SpaceSectionName = 'radar' | 'memory';

/** A section as kept: which one, and the server's answer. */
export type SpaceSection =
    | { readonly section: 'radar'; readonly radar: SpaceRadar }
    | { readonly section: 'memory'; readonly memory: SpaceMemoryState };

/** A section's key: the Space's body prefix, then the section. */
export const spaceSectionKey = (spaceId: string, section: SpaceSectionName) => `${spaceBodyPrefix(spaceId)}${section}`;

/** The Space and section a key names, or null for one that isn't a section's key. */
export function parseSpaceSectionKey(key: string): { spaceId: string; section: SpaceSectionName } | null {
    const at = key.lastIndexOf('/');
    const section = key.slice(at + 1);
    if (at <= 0 || (section !== 'radar' && section !== 'memory')) {
        return null;
    }
    const space = key.slice(0, at);
    if (space.includes('/')) {
        return null;
    }
    try {
        return { spaceId: decodeURIComponent(space), section };
    } catch {
        return null;
    }
}

const isList = (value: unknown) => Array.isArray(value);

function checkRadar(path: string, body: unknown): SpaceRadar {
    const radar = body as Partial<SpaceRadar> | null;
    if (!radar || typeof radar !== 'object') {
        throw new SnapshotShapeError(path, 'no radar.');
    }
    if (!isList(radar.recent) || !isList(radar.open) || !isList(radar.stale)) {
        throw new SnapshotShapeError(path, 'no recent, open or stale pages.');
    }
    if (typeof radar.staleDays !== 'number' || typeof radar.total !== 'number' || typeof radar.now !== 'number') {
        throw new SnapshotShapeError(path, 'no staleDays, total or now.');
    }
    return radar as SpaceRadar;
}

function checkMemory(path: string, body: unknown): SpaceMemoryState {
    const memory = body as Partial<SpaceMemoryState> | null;
    if (!memory || typeof memory !== 'object') {
        throw new SnapshotShapeError(path, 'no memory.');
    }
    if (!isList(memory.entries) || !isList(memory.proposals) || !isList(memory.retired)) {
        throw new SnapshotShapeError(path, 'no entries, proposals or retired entries.');
    }
    if (memory.access !== 'editor' && memory.access !== 'reader') {
        throw new SnapshotShapeError(path, 'no access.');
    }
    return memory as SpaceMemoryState;
}

const SECTION_PATH = /^\/api\/spaces\/[^/]+\/(radar|memory)$/;

function sectionPath(key: string): string {
    const parts = parseSpaceSectionKey(key);
    if (parts === null) {
        throw new TypeError(`${key} isn't a Space section's key.`);
    }
    return `/api/spaces/${encodeURIComponent(parts.spaceId)}/${parts.section}`;
}

function parseSection(path: string, body: unknown): SpaceSection {
    const section = SECTION_PATH.exec(path)?.[1];
    if (section === 'radar') {
        return { section, radar: checkRadar(path, body) };
    }
    if (section === 'memory') {
        return { section, memory: checkMemory(path, body) };
    }
    throw new SnapshotShapeError(path, 'not a Space section.');
}

export type SpaceSections = BoundedStore<SpaceSection>;

export interface SpaceSectionsOptions {
    readonly db: SqlConnection;
    readonly fetch: AuthedFetch;
    readonly signal?: AbortSignal;
    readonly onError?: (error: unknown) => void;
    readonly now?: () => number;
}

/** Opens the Spaces' sections on the scope's cache.db. */
export function createSpaceSections(options: SpaceSectionsOptions): SpaceSections {
    return createBoundedStore<SpaceSection>({
        ...options,
        definition: {
            name: SPACE_SECTIONS_KIND,
            format: 1,
            bounds: { items: SPACE_SECTIONS_KEPT, chars: SPACE_SECTIONS_CHARS },
            path: sectionPath,
            parse: parseSection,
        },
        // A key that isn't a section's never reads the network.
        isLocal: (key) => parseSpaceSectionKey(key) === null,
    });
}

/** Space `spaceId`'s section; hold it with `use()` in the same turn. */
export const spaceSection = (
    sections: SpaceSections,
    spaceId: string,
    section: SpaceSectionName,
): BoundedItem<SpaceSection> => sections.item(spaceSectionKey(spaceId, section));
