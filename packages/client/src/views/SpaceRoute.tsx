import { Navigate, useMatches, useNavigate } from 'react-router';

import type { PageLibrary } from '@socio/shared/pages/page-library';

import { spacePath } from '../modules/pages/page-navigation';
import { SpaceWorkspace } from '../modules/spaces/SpaceWorkspace';
import { useRouteParams, useShell } from '../shell/shell-context';

import { NotFound } from './NotFound';

/** `/spaces`: the first Space. */
export function SpacesIndex() {
    const { workspace } = useShell();
    const first = workspace.spaces[0];
    if (!first) {
        return <NotFound what="Space" />;
    }
    return <Navigate to={spacePath(first.id)} replace />;
}

/**
 * `/spaces/:spaceId` (the library), `/spaces/:spaceId/pages/:pageId`, and
 * `/spaces/:spaceId/memory` and `/settings` (CB-181). One route element
 * for all, so the Space's page list stays loaded while moving between its
 * pages.
 */
export function SpaceRoute({ library }: { library?: PageLibrary } = {}) {
    const shell = useShell();
    const { state, workspace } = shell;
    const { spaceId = '', pageId } = useRouteParams();
    const navigate = useNavigate();
    const tab = useMatches().at(-1)?.id;
    const space = workspace.spaces.find((item) => item.id === spaceId);
    if (!space) {
        return <NotFound what="Space" />;
    }
    return (
        <SpaceWorkspace
            key={space.id}
            space={space}
            library={library?.spaceId === space.id ? library : undefined}
            pageId={pageId}
            memory={tab === 'spaces:memory'}
            radar={tab === 'spaces:radar'}
            settings={tab === 'spaces:settings'}
            workspace={workspace}
            paused={state.settings.paused}
            onPage={(id) => navigate(spacePath(space.id, id))}
            onMoved={(to, id) => navigate(spacePath(to, id), { replace: true })}
            onSettings={() => shell.openDialog({ type: 'settings' })}
            onCreateDot={() => shell.openDialog({ type: 'dot', spaceId: space.id })}
            onDirty={shell.setDirty}
            onRefresh={shell.refresh}
            onSchedule={(threadId) => shell.openDialog({ type: 'schedule', threadId })}
            onThread={(id) => navigate(`/chats/${encodeURIComponent(id)}`)}
        />
    );
}
