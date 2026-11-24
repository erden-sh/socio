import { Folder, Plus } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';
import type { PageTitle } from '@socio/shared/pages/page-library';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import type { PageSearchResult } from '@socio/shared/pages/page-search';

import { api } from '../../lib/api';
import { useFlag } from '../../shell/flags';
import { spacePath } from '../pages/page-navigation';
import type { ClientModule, PaletteCommand } from '../types';

import { pageCommands, pageHitCommands } from './page-commands';
import { PageReviewRenderer } from './PageReviewRenderer';

import { NavPrivate, NavSpace } from '@/components/nav-spaces';
import { useSidebarNav } from '@/components/sidebar-nav';
import { SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu } from '@/components/ui/sidebar';

/** The sidebar's Spaces, each with its page tree. */
function SpacesGroup() {
    const nav = useSidebarNav();
    const { workspace } = nav.context;
    const datasets = useFlag('datasets-in-spaces');
    return (
        <SidebarGroup>
            <SidebarGroupLabel>Spaces</SidebarGroupLabel>
            {/* Whoever the server's "create Spaces" permission lets in; a member's is private (CB-181). */}
            {workspace.permissions?.createSpaces && (
                <SidebarGroupAction aria-label="Create Space" title="Create Space" onClick={nav.go(nav.onCreateSpace)}>
                    <Plus />
                </SidebarGroupAction>
            )}
            <SidebarMenu>
                {/* The person's datasets in no Space, at the top (CB-451). */}
                {datasets && <NavPrivate onNavigate={nav.close} />}
                {workspace.spaces.map((item) => (
                    <NavSpace key={item.id} space={item} onNavigate={nav.close} />
                ))}
            </SidebarMenu>
        </SidebarGroup>
    );
}

/** Spaces: the team's pages, written by the Dots and edited by people. */
export const spacesModule: ClientModule = {
    id: MODULE_IDS.spaces,
    title: 'Spaces',
    description: 'Team pages your socios write and you edit together.',
    icon: Folder,
    tone: 'sky',
    order: 20,
    opens: ({ workspace }) => ({
        path: workspace.spaces[0] ? spacePath(workspace.spaces[0].id) : '/spaces',
    }),
    navGroups: [{ order: 20, component: SpacesGroup }],
    // A Dot's draft for review shows as a card in the chat.
    toolRenderers: {
        cards: [pageReviewTool.name],
        Register: PageReviewRenderer,
    },
    commands: ({ workspace }) =>
        workspace.spaces.map((item): PaletteCommand => ({
            id: `space:${item.id}`,
            label: item.name,
            group: 'Spaces',
            keywords: ['space', item.description],
            icon: Folder,
            run: ({ navigate }) => navigate(spacePath(item.id)),
        })),
    // Every Space's page titles, fetched when the palette opens.
    loadCommands: async ({ workspace }, signal) =>
        pageCommands(workspace.spaces, await api<PageTitle[]>('/pages/titles', 'GET', undefined, signal)),
    // Pages by their text, from the server, as the user types.
    search: {
        waiting: 'Searching pages…',
        run: async ({ workspace }, query, { exact }, signal) =>
            pageHitCommands(
                workspace.spaces,
                await api<PageSearchResult>(
                    `/spaces/search?${new URLSearchParams({
                        q: query,
                        ...(exact ? { exact: 'true' } : {}),
                    })}`,
                    'GET',
                    undefined,
                    signal,
                ),
            ),
    },
};
