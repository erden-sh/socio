import { createElement } from 'react';
import type { ShouldRevalidateFunction } from 'react-router';

import type { RouteHandle } from '../../shell/shell-context';

import { PluginTitleCrumb } from './plugin-title-crumb';

// An installed plugin: Plugin name, for whoever its audience includes.
export const handle: RouteHandle = {
    // The name, with Open in a new tab beside it while the plugin is in its
    // frame: the page draws no bar of its own.
    crumb: ({ workspace, params }) => {
        const label = workspace.plugins?.find((item) => item.id === params.pluginId)?.name ?? 'Plugin';
        return [{ label, node: createElement(PluginTitleCrumb, { pluginId: params.pluginId ?? '', name: label }) }];
    },
};

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
