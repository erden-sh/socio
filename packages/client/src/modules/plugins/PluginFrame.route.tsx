import { createElement } from 'react';
import type { LoaderFunctionArgs, ShouldRevalidateFunction } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import type { RouteHandle } from '../../shell/shell-context';

import { PluginTitleCrumb } from './plugin-title-crumb';

// An installed plugin: Plugin name, for whoever its audience includes.
export const handle: RouteHandle = {
    // The name, with Open in a new tab beside it while the plugin is in its
    // frame: the page draws no bar of its own.
    crumb: ({ workspace, params, t }) => {
        const label =
            workspace.plugins?.find((item) => item.id === params.pluginId)?.name ??
            // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
            t('plugins.frame:crumb-fallback');
        return [{ label, node: createElement(PluginTitleCrumb, { pluginId: params.pluginId ?? '', name: label }) }];
    },
};

/**
 * The words of the page around the plugin (route-namespaces.json): its
 * crumb's Open in a new tab, a tab plugin's launch page and the link
 * confirmation. The plugin's own page is the plugin's, in its frame.
 */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'plugins:frame') };
}

/**
 * The splat, query and fragment are the plugin's own route (CB-446): when
 * only they change (the address following the app, or a link into the open
 * plugin), this route doesn't load again. Another plugin, a submission, or
 * an explicit revalidation of the same address keeps React Router's default.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
    currentParams,
    nextParams,
    currentUrl,
    nextUrl,
    formMethod,
    defaultShouldRevalidate,
}) =>
    formMethod || currentUrl.href === nextUrl.href || currentParams.pluginId !== nextParams.pluginId
        ? defaultShouldRevalidate
        : false;

export { PluginFrame as default } from './PluginFrame';
