import type { Space } from '@socio/shared/types';

// The Spaces list: the scope's spaces in the
// server's order (`createdAt`, so Everyday first), then by id. A private one
// says so. No React Native, so tests/shell runs it under Node.

export interface SpaceRow {
    readonly id: string;
    readonly name: string;
    /** Its description, or null when it has none. */
    readonly description: string | null;
    readonly private: boolean;
    readonly accessibilityLabel: string;
}

const byOldest = (a: Space, b: Space) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function spaceList(spaces: readonly Space[]): SpaceRow[] {
    return [...spaces].sort(byOldest).map((space) => {
        const description =
            typeof space.description === 'string' && space.description.trim() !== '' ? space.description : null;
        const shut = space.private === true;
        return {
            id: space.id,
            name: space.name,
            description,
            private: shut,
            accessibilityLabel: shut ? `${space.name}, private` : space.name,
        };
    });
}

/**
 * The Spaces page's first line, which the Spaces tile leads (the owner's `intro`, 2026-11-19): the
 * web's Spaces module description (packages/client/src/modules/spaces/module.tsx).
 */
export const SPACES_INTRO = 'Team pages your socios write and you edit together.';
