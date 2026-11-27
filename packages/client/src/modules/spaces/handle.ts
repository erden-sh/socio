import { pageAncestors } from '@socio/shared/pages/page-hierarchy';
import type { PageLibrary } from '@socio/shared/pages/page-library';

import { crumbTitleFor } from '../../shell/crumb-title';
import type { RouteHandle } from '../../shell/shell-context';
import { spacePath } from '../pages/page-navigation';

/** What `/spaces/:spaceId`'s loader gives: its namespaces, and the library's first screen (null signed out or for a Space that isn't there). */
export interface SpaceRouteData {
    i18n?: unknown;
    library: PageLibrary | null;
}

// Space › ancestors › current page. The live page publishes its ancestry
// after the complete authorized summary list arrives; loader data is a fallback.
export const spaceHandle: RouteHandle = {
    crumb: ({ workspace, params, title, data, t }) => {
        const found = workspace.spaces.find((item) => item.id === params.spaceId);
        // Before the page view publishes it (and on the server): the title
        // from the library's loader.
        const library = (data as SpaceRouteData | null | undefined)?.library;
        const pageTitle =
            crumbTitleFor(title, params.pageId) ??
            library?.pages.find((page) => page.id === params.pageId && page.spaceId === params.spaceId)?.title;
        const published =
            title && title.key === params.pageId && title.ancestry && title.ancestry.spaceId === params.spaceId
                ? title.ancestry.pages
                : undefined;
        const current = library?.pages.find((page) => page.id === params.pageId && page.spaceId === params.spaceId);
        const ancestors = found ? (published ?? (current ? pageAncestors(current, library?.pages ?? []) : [])) : [];
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        const untitled = t('spaces.nav:untitled-page');
        return [
            // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
            found ? { label: found.name, to: spacePath(found.id) } : { label: t('spaces.nav:crumbs.spaces') },
            ...ancestors.map((page) => ({
                label: page.title.trim() || untitled,
                to: spacePath(found!.id, page.id),
            })),
            {
                // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
                label: pageTitle === undefined ? t('spaces.nav:crumbs.pages') : pageTitle.trim() || untitled,
            },
        ];
    },
};
