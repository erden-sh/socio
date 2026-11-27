import type { ClientLoaderFunctionArgs, LoaderFunctionArgs } from 'react-router';

import { ROUTE_NAMESPACES, routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';

import { CHAT_NAMESPACES } from './live-namespaces';

export { ChatThread as default } from '../../views/ChatViews';
export { chatThreadHandle as handle } from './handle';

/** Its namespaces (route-namespaces.json), inlined with the page; once a visit, as they don't change with the params. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'chat:thread') };
}

/**
 * What the page loads on demand that the route doesn't inline: the live
 * chat's namespaces (chat.composer, chat.model), the reactions' report
 * outcomes (chat.report) and the approval cards' and bar's words
 * (approvals.card).
 */
const ON_DEMAND = [...CHAT_NAMESPACES, 'chat.report', 'approvals.card'].filter(
    (ns) => !ROUTE_NAMESPACES['chat:thread']!.includes(ns),
);

/**
 * A navigation in the browser: the route's data, and at the same time what
 * the page loads on demand (`ON_DEMAND`), so nothing waits for its words
 * after the data comes. The navigation doesn't wait for them either: the
 * chat shows its loading state until they're in. The first page load uses
 * the server's data.
 */
export function clientLoader({ serverLoader }: ClientLoaderFunctionArgs) {
    void preloadNamespaces(ON_DEMAND);
    return serverLoader<typeof loader>();
}
export const shouldRevalidate = revalidateOn({ search: false });
