import { formatSize } from '@socio/shared/text/format-size';

// Keeping a Space offline:
// the words of the Space's header toggle and Settings' "Spaces kept offline"
// rows. No React Native, so tests/shell runs it under Node.

/** The Space header's toggle: its name for screen readers, said with its state. */
export const KEEP_OFFLINE_TOGGLE = {
    label: 'Keep offline',
    hint: 'Keeps every page of this space on this phone, so you can read them offline.',
    kept: 'Kept offline',
} as const;

/** What shows when the kept Spaces can't change: user.db is a newer build's, or didn't migrate. */
export const KEEP_NEEDS_UPDATE = 'Update Socio to change which spaces are kept offline.';

/** What shows when a change wasn't kept. */
export const KEEP_FAILED = 'Couldn’t change that. Try again.';

/** Settings' section of kept Spaces. */
export const KEPT_SPACES_SECTION = {
    title: 'Spaces kept offline',
    note: 'Every page of these spaces stays on this phone and updates when you’re online. Clear cache keeps the choice and downloads them again.',
} as const;

/** One Space as Settings lists it. */
export interface KeptSpaceRow {
    readonly id: string;
    readonly name: string;
    /** "12 pages · 340 KB", or "Measuring…". */
    readonly line: string;
    readonly testID: string;
}

/** What a kept Space holds on disk, as keep-offline.ts measures it. */
export interface KeptSpaceSizeLike {
    readonly pages: number;
    readonly bytes: number;
}

/** A kept Space's line: its pages and size once measured. */
export function keptSpaceLine(size: KeptSpaceSizeLike | undefined): string {
    if (size === undefined) {
        return 'Measuring…';
    }
    const pages = `${size.pages} ${size.pages === 1 ? 'page' : 'pages'}`;
    return `${pages} · ${formatSize(size.bytes)}`;
}

/**
 * Settings' rows: each kept Space the workspace still lists, in the order
 * kept, by its name. A Space the person lost isn't shown (nothing of it is
 * kept, and it comes back kept if access does).
 */
export function keptSpaceRows(
    kept: readonly string[],
    spaces: readonly { readonly id: string; readonly name: string }[],
    sizes: ReadonlyMap<string, KeptSpaceSizeLike> | null,
): KeptSpaceRow[] {
    const names = new Map(spaces.map((space) => [space.id, space.name]));
    return kept.flatMap((id) => {
        const name = names.get(id);
        return name === undefined
            ? []
            : [{ id, name, line: keptSpaceLine(sizes?.get(id)), testID: `settings-kept-space-${id}` }];
    });
}
