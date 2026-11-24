import { useEffect } from 'react';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { keepSummary } from '../platform/active-scope';
import { setPushBadge } from '../platform/push';
import { badgeCount } from '../push/badge';
import { workspaceSummary } from '../shell/account';
import { chatList } from '../shell/chat-list';
import { chatsQuery, shellQuery, shellRows, sociosQuery } from '../shell/queries';

// The registry's summary of the open workspace: its name and its
// unread, kept as they change, so the switcher shows them for a workspace that
// isn't open, and the app icon's badge. It draws nothing, and waits for
// the state row, which holds the name and says whether rooms are on.

export function WorkspaceSummary() {
    return useHasWorkspaceScope() ? <Summary /> : null;
}

function Summary() {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const { data: approvals } = useLiveQuery({ query: (q) => q.from({ approval: collections.approvals }) });
    const { state } = shellRows(shell);
    const rows = state === null ? null : chatList(chats, dots, state);
    const summary = state === null || rows === null ? null : workspaceSummary(state, rows, scope.workspace);
    // The app icon's badge: this workspace's approvals waiting and rooms' unread, set as each pull lands.
    const badge = rows === null ? null : badgeCount(approvals, rows);
    const id = scope.workspace.id;
    const name = summary?.name;
    const unread = summary?.unread;
    useEffect(() => {
        if (unread !== undefined) {
            keepSummary(id, { name, unread }).catch((error: unknown) =>
                console.warn('[switcher] summary not kept', error),
            );
        }
    }, [id, name, unread]);
    useEffect(() => {
        if (badge !== null) {
            setPushBadge(badge);
        }
    }, [badge]);
    return null;
}
