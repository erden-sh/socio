import type { User } from '@socio/shared/types';
import type { WebServices } from '@socio/shared/web/web';

import { dataView } from '../../src/server/dataspace/data-views.js';
import { issueListView } from '../../src/server/issues/views.js';
import { learningContainers, learningContainerView } from '../../src/server/learning/views.js';
import { spacePagesView } from '../../src/server/pages/views.js';

import type { SeededWorkspace } from './seed-workspace.js';

/**
 * What each page's loader asks the services for on the seeded workspace,
 * for the bench (scripts/loader-bench.mjs) and the size test
 * (tests/integration/loader-size.test.ts). `load` does what the route module's
 * loader does, with the params of the seed's largest case (the Space
 * with the most pages, the issue with the most comments). For a kept
 * loader, `address` is the page that runs it: the size test opens it
 * through the app's routes and checks `load` returns the same.
 */
export interface PageLoader {
    /** The page, as the address bar shows it. */
    page: string;
    /** The route module's loader, by route id. */
    route: string;
    /** Who may open it: operators or admins only, or members too. */
    admins?: boolean;
    operators?: boolean;
    /**
     * False for a page whose loader missed the budget and was not kept: the
     * bench still measures what it would return (the API's view), so the
     * numbers can be checked again.
     */
    kept: boolean;
    /** The page's address for this user, where the route's loader runs. */
    address?: (as: User) => string;
    load(services: WebServices, as: User): Promise<unknown>;
}

/** The shell's loader (and the module gates, which reuse its answers). */
export const shellLoader: PageLoader = {
    page: 'shell',
    route: 'shell',
    kept: true,
    load: async (services) => {
        const [state, workspace] = await Promise.all([services.state(), services.workspace()]);
        return { session: 'signed-in', state, workspace };
    },
};

/** Who the bench and the size test open a page as. */
export const pageUsers = (seed: SeededWorkspace, loader: PageLoader) =>
    loader.operators ? [seed.operator] : loader.admins ? [seed.admin] : [seed.admin, seed.member];

export async function pageLoaders(seed: SeededWorkspace): Promise<PageLoader[]> {
    const { platform, workspace } = seed;
    // What the feature views read, as their tags' layers hand it in.
    const pageSources = { spaceAccess: workspace.spaceAccess, pages: workspace.pages, counters: workspace.counters };
    const { learning } = platform;
    const learningSources = { learning, evidence: learning.evidence, skills: learning.skills, socios: workspace };
    const most = <T>(items: T[], count: (item: T) => number) =>
        items.reduce((best, item) => (count(item) > count(best) ? item : best));
    const comments = new Map<string, number>();
    for (const item of await platform.board.issues.list()) {
        comments.set(item.id, (await platform.board.issues.comments(item.id)).length);
    }
    const issue = most(await platform.board.issues.list(), (item) => comments.get(item.id) ?? 0);
    const space = most(workspace.spaces(), (item) => workspace.pages.list(item.id).length);
    // The open page: the oldest edit, so it is not in the first screen.
    const oldest = workspace.pages.list(space.id).reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b));
    // Each person's newest request, read before any page loads.
    const newest = new Map<string, string>();
    for (const user of workspace.users()) {
        const [first] = await platform.approvals.list(user.id, { limit: 1 });
        if (first) {
            newest.set(user.id, first.id);
        }
    }
    const approvalOf = (as: User) => newest.get(as.id)!;
    const datasetOf = (as: User) => platform.data.datasetsFor(as.id)[0]!.id;
    return [
        {
            page: '/issues',
            route: 'issues',
            kept: false,
            load: async () => issueListView(platform),
        },
        {
            page: '/issues/:issueKey',
            route: 'issues:issue',
            kept: true,
            address: () => `/issues/CB-${issue.number}`,
            load: (services) => services.issue(issue.number),
        },
        {
            page: '/spaces/:spaceId (every page, the poll)',
            route: 'spaces:space',
            kept: false,
            load: async (_, as) => spacePagesView(pageSources, as.id, space.id),
        },
        {
            page: '/spaces/:spaceId/pages/:pageId',
            route: 'spaces:space',
            kept: true,
            address: () => `/spaces/${space.id}/pages/${oldest.id}`,
            load: (services) => services.spaceLibrary(space.id, oldest.id),
        },
        {
            page: '/approvals',
            route: 'approvals',
            kept: true,
            address: () => '/approvals',
            load: (services) => services.approvals(),
        },
        {
            page: '/approvals/:approvalId',
            route: 'approvals:request',
            kept: true,
            address: (as) => `/approvals/${approvalOf(as)}`,
            load: (services, as) => services.approval(approvalOf(as)),
        },
        {
            page: '/runs (the poll: 200 runs)',
            route: 'runs',
            admins: true,
            kept: false,
            load: (services) => services.runs(200),
        },
        {
            page: '/runs',
            route: 'runs',
            admins: true,
            kept: true,
            address: () => '/runs',
            load: (services) => services.runs(50),
        },
        {
            page: '/media',
            route: 'media',
            kept: true,
            address: () => '/media',
            // The route's loader returns the address's query with the listing.
            load: async (services) => ({
                query: { folder: '', q: '', kind: '' },
                listing: await services.media({}),
            }),
        },
        {
            page: '/data (with the file list)',
            route: 'data',
            kept: false,
            load: async (_, as) => dataView(platform.data, as),
        },
        {
            page: '/data',
            route: 'data',
            kept: true,
            address: () => '/data',
            load: (services) => services.data(),
        },
        {
            page: '/data/datasets/:datasetId',
            route: 'data:dataset',
            kept: true,
            address: (as) => `/data/datasets/${datasetOf(as)}`,
            load: (services, as) => services.dataset(datasetOf(as)),
        },
        {
            page: '/schedules',
            route: 'schedules',
            kept: true,
            address: () => '/schedules',
            load: (services) => services.schedules(),
        },
        {
            page: '/learning (a container with proposal bodies)',
            route: 'learning',
            admins: true,
            kept: false,
            load: async () => learningContainerView(learningSources, learningContainers(learningSources)[0]!),
        },
        {
            page: '/learning',
            route: 'learning',
            kept: true,
            address: () => '/learning',
            // What the route's loader asks for, by role.
            load: async (services, as) => {
                if (as.role !== 'admin') {
                    return { admin: false, skills: await services.learningSkills() };
                }
                const containers = await services.learningContainers();
                return {
                    admin: true,
                    containers,
                    open: await services.learningContainer(containers![0]!.id),
                };
            },
        },
        {
            page: '/settings/operator',
            route: 'operator',
            operators: true,
            kept: true,
            address: () => '/settings/operator',
            load: (services) => services.inference(),
        },
    ];
}
