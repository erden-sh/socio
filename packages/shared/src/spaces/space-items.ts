/**
 * A Space's items (CB-451): its pages and the datasets placed
 * in it, in one tree, as `GET /api/spaces/:spaceId/items` answers, and a
 * person's datasets no Space holds, as `GET /api/data/private-items`
 * answers (the "Private" group). The web sidebar and Socio Mobile draw
 * both with the same code.
 *
 * `page-tree` and `pages` stay pages only: a client not updated yet would
 * read a dataset there as a page.
 */

export const SPACE_ITEMS_SCHEMA = 1;

/** `GET /api/spaces/:spaceId/items`: the same for every reader of the Space. */
export interface SpaceItemsResponse {
    schema: 1;
    spaceId: string;
    /** Tree order: siblings in `position` order, parents before children. */
    items: SpaceItem[];
}

/**
 * `GET /api/data/private-items`: the person's own datasets in no Space, a
 * socio's scratch datasets included. Only they see it.
 */
export interface PrivateItemsResponse {
    schema: 1;
    scope: 'private';
    /** Every item is a dataset at the root (`parentId: null`), oldest first. */
    items: SpaceItem[];
}

export type SpaceItem = SpacePageItem | SpaceDatasetItem;

interface SpaceItemBase {
    id: string;
    /** A page id, or null at the Space's root. A page is never under a dataset. */
    parentId: string | null;
    title: string;
    /** A sortable key among siblings (`spaceItemKey` when none is stored). */
    position: string;
    /**
     * Changes whenever anything listed for this item changes, so a client
     * that caches items one by one refreshes exactly the changed ones.
     * Compare it for equality only: it is not ordered.
     */
    version: number;
}

export interface SpacePageItem extends SpaceItemBase {
    /**
     * `version` is the page's revision: every change of its title or parent
     * (an edit, a move) is a new revision, and its position comes from its
     * creation, which never changes.
     */
    kind: 'page';
}

export interface SpaceDatasetItem extends SpaceItemBase {
    /**
     * `version` is `spaceItemVersion` of the item: a hash of every field
     * listed, so a rename, a move, a new place, a table's row count, or a
     * change of its socio's or plugin's badge each give a new one.
     */
    kind: 'dataset';
    /** A person's, a socio's shared area's, or the workspace's (a plugin's among them). */
    owner: 'person' | 'socio' | 'workspace';
    /** A one-table dataset opens on that table; several show as tabs. Tables are not tree items. */
    tables: Array<{
        name: string;
        title: string;
        rows: number | null;
        analytical: boolean;
    }>;
    /** The socio whose scratch dataset this is (the Private group marks it with its name). */
    socio?: { id: string; name: string | null };
    /** The plugin that writes it: read-only to people while it does ("Written by …"). */
    plugin?: { id: string; name: string };
}

/**
 * A dataset item's `version` (CB-451): a 53-bit hash (cyrb53) of every field
 * the item lists but `version`, in a fixed order. Not its `updatedAt`,
 * which a rename or a move doesn't change, nor a stored counter, which a
 * socio's rename or a plugin binding (badges read from elsewhere) wouldn't
 * bump.
 */
export function spaceItemVersion(item: Omit<SpaceDatasetItem, 'version'>): number {
    const text = JSON.stringify([
        item.kind,
        item.id,
        item.parentId,
        item.title,
        item.position,
        item.owner,
        item.tables.map((table) => [table.name, table.title, table.rows, table.analytical]),
        item.socio ? [item.socio.id, item.socio.name] : null,
        item.plugin ? [item.plugin.id, item.plugin.name] : null,
    ]);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The kinds this version of the shared code knows; a client shows any other as "Not supported in this version". */
export const SPACE_ITEM_KINDS = ['page', 'dataset'] as const;

export const isKnownSpaceItem = (item: { kind: string }): item is SpaceItem =>
    (SPACE_ITEM_KINDS as readonly string[]).includes(item.kind);

/**
 * The derived position of an item with none stored: its time (a page's
 * creation, when a dataset joined the Space or was made), then its id, so
 * with no stored positions pages keep today's order (`createdAt, id`).
 */
export const spaceItemKey = (at: number, id: string) =>
    `${String(Math.max(0, Math.floor(at))).padStart(15, '0')}.${id}`;

/** What a stored position may be: a short key in the same key space. */
export const SPACE_POSITION = /^[0-9A-Za-z._:-]{1,80}$/;

/** The 403 for a reader of a Space who tries to place a dataset in it. */
export const SPACE_PLACE_REFUSED = 'Only this Space’s editors can add to it.';

/**
 * Puts items in tree order: siblings by `position` (then id), each parent
 * before its children. An item whose parent isn't a page in the list sits
 * at the root, so nothing is dropped.
 */
export function spaceItemTree<T extends { id: string; parentId: string | null; position: string; kind: string }>(
    items: readonly T[],
): T[] {
    const pages = new Set(items.filter((item) => item.kind === 'page').map((item) => item.id));
    const parentOf = (item: T) => (item.parentId !== null && pages.has(item.parentId) ? item.parentId : null);
    const children = new Map<string | null, T[]>();
    for (const item of items) {
        const parent = parentOf(item);
        const list = children.get(parent) ?? [];
        list.push(item);
        children.set(parent, list);
    }
    for (const list of children.values()) {
        list.sort((a, b) =>
            a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
    }
    const out: T[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null) => {
        for (const item of children.get(parent) ?? []) {
            if (seen.has(item.id)) {
                continue;
            }
            seen.add(item.id);
            out.push(item);
            walk(item.id);
        }
    };
    walk(null);
    // A cycle among pages (never stored, but never lost either): at the end.
    for (const item of items) {
        if (!seen.has(item.id)) {
            seen.add(item.id);
            out.push(item);
        }
    }
    return out;
}
