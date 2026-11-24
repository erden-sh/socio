import type { RouteConfigEntry } from '@react-router/dev/routes';
import type { ComponentType } from 'react';
import {
    createMemoryRouter,
    RouterContextProvider,
    type LoaderFunction,
    type MiddlewareFunction,
    type RouteObject,
    type ShouldRevalidateFunction,
} from 'react-router';

import type { ApprovalsState, ApprovalView } from '@socio/shared/approvals';
import type { AuthSession } from '@socio/shared/auth';
import type { DatasetDetail, DataSpaceState } from '@socio/shared/data-types';
import type { OperatorInferenceState } from '@socio/shared/inference';
import type { IssueDetail } from '@socio/shared/issues/issue-types';
import type { LearningContainerDetail, LearningContainerSummary, PublishedSkills } from '@socio/shared/learning';
import type { MediaListing } from '@socio/shared/media-types';
import type { MemoriesState } from '@socio/shared/memory';
import { LIBRARY_FIRST_SCREEN, type PageLibrary, type PageSummary } from '@socio/shared/pages/page-library';
import type { ScheduleDetail, SchedulesState } from '@socio/shared/schedule-types';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { RunList, WebServices } from '@socio/shared/web/web';

import { api, ApiError } from '../../src/lib/api';
import { webContext } from '../../src/lib/web-context';
import Root, { ErrorBoundary as RootError } from '../../src/root';
import config from '../../src/routes';

/** What a `*.route.tsx` file exports (the subset this app uses). */
export interface RouteModule {
    default?: ComponentType;
    handle?: unknown;
    ErrorBoundary?: ComponentType;
    loader?: LoaderFunction;
    shouldRevalidate?: ShouldRevalidateFunction;
    middleware?: MiddlewareFunction[];
}

/** Loads a route module by its config file (relative to `packages/client/src`). */
export type LoadRouteModule = (file: string) => RouteModule;

// Every route module, loaded up front: tests don't wait for chunks.
const modules = import.meta.glob<RouteModule>('../../src/**/*.route.tsx', { eager: true });

/** A route module by its config file (relative to `packages/client/src`). */
export function loadRouteModule(file: string): RouteModule {
    const module = modules[`../../src/${file}`];
    if (!module) {
        throw new Error(`No route module ${file}`);
    }
    return module;
}

/** A route module's exports as route object fields (only those it has). */
function routeFields(module: RouteModule) {
    const fields: Pick<
        RouteObject,
        'Component' | 'handle' | 'ErrorBoundary' | 'loader' | 'shouldRevalidate' | 'middleware'
    > = {};
    if (module.default) {
        fields.Component = module.default;
    }
    if (module.handle !== undefined) {
        fields.handle = module.handle;
    }
    if (module.ErrorBoundary) {
        fields.ErrorBoundary = module.ErrorBoundary;
    }
    if (module.loader) {
        fields.loader = module.loader;
    }
    if (module.shouldRevalidate) {
        fields.shouldRevalidate = module.shouldRevalidate;
    }
    if (module.middleware) {
        fields.middleware = module.middleware;
    }
    return fields;
}

/**
 * The route config (`routes.ts`) as data router routes: the same ids,
 * paths and nesting the framework build makes, each route's fields set
 * from its module.
 */
export function toRouteObjects(entries: readonly RouteConfigEntry[], load: LoadRouteModule): RouteObject[] {
    return entries.map((entry): RouteObject => {
        const fields = routeFields(load(entry.file));
        if (entry.index) {
            return { id: entry.id, index: true, ...fields };
        }
        return {
            id: entry.id,
            path: entry.path,
            caseSensitive: entry.caseSensitive,
            ...fields,
            children: entry.children && toRouteObjects(entry.children, load),
        };
    });
}

/**
 * The app's routes under the root route (its outlet, not the document),
 * as the browser gets them. `extraRoutes` go into the shell next to the
 * modules' gates (a test module's gate and pages).
 */
export function testRoutes(extraRoutes: RouteObject[] = [], load: LoadRouteModule = loadRouteModule): RouteObject[] {
    const routes = toRouteObjects(config, load);
    const shell = routes.find((route) => route.id === 'shell');
    if (!shell || shell.index) {
        throw new Error('No shell route');
    }
    shell.children = [...(shell.children ?? []), ...extraRoutes];
    return [
        {
            id: 'root',
            path: '/',
            Component: Root,
            ErrorBoundary: RootError,
            children: routes,
        },
    ];
}

/** A Space library's first screen from its page list. */
function libraryOf(spaceId: string, pages: PageSummary[], include?: string) {
    const recent = [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, LIBRARY_FIRST_SCREEN);
    const open = pages.find((page) => page.id === include);
    if (open && !recent.includes(open)) {
        recent.push(open);
    }
    return {
        spaceId,
        total: pages.length,
        pages: recent,
        hasCovers: pages.some((page) => page.cover),
    } satisfies PageLibrary;
}

/**
 * The server's page services (`WebServices`) over the tests' stubbed
 * fetch: each method asks the API route it stands for, once per
 * navigation. A 401 means signed out. `log` gets each API path asked for.
 */
export function fetchServices(log: string[] = []): WebServices {
    const once = <T,>(load: () => Promise<T>) => {
        let value: Promise<T> | undefined;
        return () => (value ??= load());
    };
    const get = <T,>(path: string) => {
        log.push(`/api${path}`);
        return api<T>(path);
    };
    const workspace = once(() =>
        get<WorkspaceState>('/workspace').catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 401) {
                return null;
            }
            throw error;
        }),
    );
    // A page's API answers 404 for a missing item: the loader's null.
    const orNull = <T,>(answer: Promise<T>) =>
        answer.catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) {
                return null;
            }
            throw error;
        });
    const signedIn = async <T,>(value: T | null) => {
        if (value === null) {
            throw new Error('Signed out: no data.');
        }
        return value;
    };
    return {
        user: async () => (await workspace())?.user ?? null,
        signIn: once(async () => {
            const { provider, methods } = await get<AuthSession>('/auth/session');
            return { provider, ...(methods ? { methods } : {}) };
        }),
        state: once(async () => get<State>('/state')),
        workspace: async () => signedIn(await workspace()),
        issue: (number) => orNull(get<IssueDetail>(`/issues/${number}`)),
        approvals: () => orNull(get<ApprovalsState>('/approvals')),
        data: () => orNull(get<DataSpaceState>('/data?files=false')),
        schedules: () => orNull(get<SchedulesState>('/schedules')),
        schedule: (id) => orNull(get<ScheduleDetail>(`/schedules/${encodeURIComponent(id)}`)),
        learningSkills: () => orNull(get<PublishedSkills>('/learning/skills')),
        memories: () => get<MemoriesState>('/memories'),
        inference: () =>
            get<OperatorInferenceState>('/inference').catch((error: unknown) => {
                if (error instanceof ApiError && error.status === 403) {
                    return null;
                }
                throw error;
            }),
        learningContainers: () =>
            get<LearningContainerSummary[]>('/learning/containers').catch((error: unknown) => {
                if (error instanceof ApiError && error.status === 403) {
                    return null;
                }
                throw error;
            }),
        learningContainer: (id) =>
            orNull(get<LearningContainerDetail>(`/learning/containers/${encodeURIComponent(id)}?bodies=false`)),
        dataset: (id) => orNull(get<DatasetDetail>(`/data/datasets/${encodeURIComponent(id)}`)),
        media: (query) => {
            const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value)).toString();
            return get<MediaListing>(`/media${search ? `?${search}` : ''}`).catch(() => null);
        },
        runs: (limit) =>
            get<RunList>(`/runs?limit=${limit}`).catch((error: unknown) => {
                if (error instanceof ApiError && error.status === 403) {
                    return null;
                }
                throw error;
            }),
        approval: (id) => orNull(get<ApprovalView>(`/approvals/${encodeURIComponent(id)}`)),
        // The tests' servers answer the full list; the summary is made here,
        // as the server's view makes it (page-routes.test.ts checks that).
        spaceLibrary: async (spaceId, pageId) => {
            const pages = await orNull(get<PageSummary[]>(`/spaces/${spaceId}/pages`));
            return pages && libraryOf(spaceId, pages, pageId);
        },
    };
}

/**
 * A memory router on the app's routes, starting at `path`. `load` replaces
 * how route modules load (a page that fails to render). Loaders and
 * middleware get the services through the router context, as on the
 * server; each navigation gets its own set (`services`, fetchServices by
 * default).
 */
export function createTestRouter(
    path: string,
    {
        extraRoutes,
        load,
        services = () => fetchServices(),
    }: {
        extraRoutes?: RouteObject[];
        load?: LoadRouteModule;
        services?: () => WebServices;
    } = {},
) {
    return createMemoryRouter(testRoutes(extraRoutes, load), {
        initialEntries: [path],
        getContext: () => new RouterContextProvider(new Map([[webContext, { services: services(), nonce: '' }]])),
    });
}
