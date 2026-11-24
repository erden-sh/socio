import { pageAncestors } from '@socio/shared/pages/page-hierarchy';
import type { PageLibrary } from '@socio/shared/pages/page-library';

import { crumbTitleFor } from '../../shell/crumb-title';
import type { RouteHandle } from '../../shell/shell-context';
import { spacePath } from '../pages/page-navigation';

// Space › ancestors › current page. The live page publishes its ancestry
// after the complete authorized summary list arrives; loader data is a fallback.
export const spaceHandle: RouteHandle = {
    crumb: ({ workspace, params, title, data }) => {
        const found = workspace.spaces.find((item) => item.id === params.spaceId);
        // Before the page view publishes it (and on the server): the title
        // from the library's loader.
        const pageTitle =
            crumbTitleFor(title, params.pageId) ??
            (data as PageLibrary | null | undefined)?.pages.find(
                (page) => page.id === params.pageId && page.spaceId === params.spaceId,
            )?.title;
        const library = data as PageLibrary | null | undefined;
        const published =
            title && title.key === params.pageId && title.ancestry && title.ancestry.spaceId === params.spaceId
                ? title.ancestry.pages
                : undefined;
        const current = library?.pages.find((page) => page.id === params.pageId && page.spaceId === params.spaceId);
        const ancestors = found ? (published ?? (current ? pageAncestors(current, library?.pages ?? []) : [])) : [];
        return [
            found ? { label: found.name, to: spacePath(found.id) } : { label: 'Spaces' },
            ...ancestors.map((page) => ({
                label: page.title.trim() || 'Untitled page',
                to: spacePath(found!.id, page.id),
            })),
            {
                label: pageTitle === undefined ? 'Pages' : pageTitle.trim() || 'Untitled page',
            },
        ];
    },
};
