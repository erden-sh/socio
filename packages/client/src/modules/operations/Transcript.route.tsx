import { useParams, useSearchParams, type ClientLoaderFunctionArgs, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { preloadNamespaces } from '../../i18n/page-instance';
import { revalidateOn } from '../../lib/page-loader';
import { crumbTitleFor } from '../../shell/crumb-title';
import type { RouteHandle } from '../../shell/shell-context';

import { OPS_HOME } from './sections';
import { TranscriptPage } from './TranscriptPage';

export const handle: RouteHandle = {
    crumb: ({ params, title, t }) => [
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: t('operations:title'), to: OPS_HOME },
        // oxlint-disable-next-line socio/translate-in-components -- the header's t, passed at each render (CrumbContext)
        { label: crumbTitleFor(title, params.threadId) ?? t('operations:crumbs.chat') },
    ],
};

/** The chat transcript's namespaces (route-namespaces.json), inlined with the page. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'operations:chat') };
}

/**
 * A navigation in the browser: the route's data, and at the same time the
 * words its collapsed panels load on demand (what the chat read, a room's
 * audit), so they don't wait after the data comes.
 */
export function clientLoader({ serverLoader }: ClientLoaderFunctionArgs) {
    void preloadNamespaces(['operations.chat-grounding', 'operations.room-audit']);
    return serverLoader<typeof loader>();
}
export const shouldRevalidate = revalidateOn({ search: false });

/**
 * `/operations/chats/:threadId`: a chat's admin transcript view (CB-188).
 * Who may open it is the module gate's (admins); the server checks again
 * and writes the access log.
 */
export default function TranscriptRoute() {
    const { threadId } = useParams();
    const [params] = useSearchParams();
    return <TranscriptPage key={threadId} threadId={threadId!} via={params.get('via')} />;
}
