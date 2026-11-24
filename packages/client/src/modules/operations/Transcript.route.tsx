import { useParams, useSearchParams } from 'react-router';

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
