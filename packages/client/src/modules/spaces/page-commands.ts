import { FileText } from 'lucide-react';

import type { PageTitle } from '@socio/shared/pages/page-library';
import { freshnessLabel, type PageSearchResult } from '@socio/shared/pages/page-search';
import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';
import { spacePath } from '../pages/page-navigation';
import type { PaletteCommand, PaletteSearchAnswer } from '../types';

/**
 * Tells the server a page was opened from a search: one freshness signal
 * per person, page and day. Fire and forget; it never holds the page up.
 */
export function notePageUse(spaceId: string, pageId: string) {
    void api(`/spaces/${spaceId}/pages/${pageId}/used`, 'POST').catch(() => {});
}

/** One page entry of the palette; opening it counts as a use. */
function pageCommand(
    space: Space,
    page: Pick<PageTitle, 'id' | 'title' | 'freshness'>,
    extra: Partial<PaletteCommand> = {},
): PaletteCommand {
    return {
        id: `page:${page.id}`,
        label: page.title || 'Untitled page',
        group: 'Pages',
        hint: space.name,
        keywords: ['page'],
        icon: FileText,
        searchOnly: true,
        note: freshnessLabel(page.freshness),
        ...extra,
        run: ({ navigate }) => {
            notePageUse(space.id, page.id);
            navigate(spacePath(space.id, page.id));
        },
    };
}

/**
 * The palette's page entries: Space by Space in the sidebar's order, each
 * Space's pages in the order the server lists them. Pages of a Space the
 * sidebar doesn't show (yet, or any more) are left out.
 */
export function pageCommands(spaces: readonly Space[], pages: readonly PageTitle[]): PaletteCommand[] {
    const bySpace = new Map<string, PageTitle[]>();
    for (const page of pages) {
        const list = bySpace.get(page.spaceId) ?? [];
        list.push(page);
        bySpace.set(page.spaceId, list);
    }
    return spaces.flatMap((space) => (bySpace.get(space.id) ?? []).map((page) => pageCommand(space, page)));
}

/**
 * The server's text hits as palette entries, best first, each with its
 * snippet; hits in a Space the sidebar doesn't show are left out.
 */
export function pageHitCommands(spaces: readonly Space[], answer: PageSearchResult): PaletteSearchAnswer {
    const byId = new Map(spaces.map((space) => [space.id, space]));
    return {
        corrected: answer.corrected,
        commands: answer.results.flatMap((hit) => {
            const space = byId.get(hit.spaceId);
            return space ? [pageCommand(space, hit, { detail: hit.snippet })] : [];
        }),
    };
}
