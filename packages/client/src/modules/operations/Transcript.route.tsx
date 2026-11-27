import { useParams, useSearchParams, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { crumbTitleFor } from '../../shell/crumb-title';
import type { RouteHandle } from '../../shell/shell-context';

import { OPS_HOME } from './sections';
import { TranscriptPage } from './TranscriptPage';

export const handle: RouteHandle = {
    crumb: ({ params, title }) => [
        { label: 'Operations', to: OPS_HOME },
        { label: crumbTitleFor(title, params.threadId) ?? 'Chat' },
    ],
};

/** The chat transcript's namespaces (route-namespaces.json), inlined with the page. */
export async function loader({ context }: LoaderFunctionArgs) {
    return { i18n: await routeI18n(context, 'operations:chat') };
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
