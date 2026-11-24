import type { Context } from 'hono';

import { DataError } from '@socio/foundation/dataspace/data-error';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { localRequest } from '@socio/foundation/http/local-request';
import { PageError } from '@socio/foundation/pages/page-error';
import { brandingInForce } from '@socio/foundation/settings/branding';
import { learningContainerIdSchema } from '@socio/shared/learning';
import type { MediaKind } from '@socio/shared/media-types';
import { LIBRARY_FIRST_SCREEN } from '@socio/shared/pages/page-library';
import { isAdmin, isOperator } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';
import type { WebServices } from '@socio/shared/web/web';

import type { ApprovalsViewsShape } from '../approvals/contract.js';
import type { AuthSetup, AuthViewsShape, RequestUserResolver } from '../auth/contract.js';
import type { DataspaceViewsShape } from '../dataspace/contract.js';
import type { DocsCatalogShape } from '../docs/contract.js';
import type { InferenceViewsShape } from '../inference/contract.js';
import type { BoardIssues, IssuesViewsShape } from '../issues/contract.js';
import type { LearningViewsShape } from '../learning/contract.js';
import type { StateViewShape } from '../live/contract.js';
import { MediaError, type MediaViewsShape } from '../media/contract.js';
import type { MemoriesViewShape } from '../memory/contract.js';
import type { PagesViewsShape } from '../pages/contract.js';
import type { RunsViewsShape } from '../runs/contract.js';
import { ScheduleError, type SchedulesViewsShape } from '../schedules/contract.js';
import type { LimitsShape } from '../settings/contract.js';
import { SpaceAccessError } from '../spaces/contract.js';
import type { ReleasesShape } from '../updates/contract.js';
import type { WorkspaceViewsShape } from '../workspace/contract.js';

import type { PageServices } from './contract.js';
import type { Config } from './research.js';

/** `stateView`'s arguments: the state the first page holds is `/api/state`'s. */
type StateArgs = Parameters<StateViewShape['stateView']>;

/**
 * The settings store the pages read, as the views they hand it to take it:
 * the branding and the state.
 */
export type PagesStore = StateArgs[0];

/**
 * The features' views the pages answer with, the same the API serves: each
 * feature's `<X>Views` tag (rooms' read state through `WorkspaceViews`),
 * memory's `MemoriesView`, updates' `Releases` for the state's version and
 * settings' `Limits` for its limit defaults. The composition root reads
 * them from the app's runtime (`composition/http/web.ts`), and hands in
 * live's state view (`GET /api/state`) beside them.
 */
export interface PageViews {
    readonly auth: AuthViewsShape;
    readonly releases: Pick<ReleasesShape, 'data'>;
    readonly state: StateViewShape;
    readonly memories: MemoriesViewShape;
    readonly limits: Pick<LimitsShape, 'defaults'>;
    readonly workspace: Pick<WorkspaceViewsShape, 'workspaceView'>;
    readonly issues: Pick<IssuesViewsShape, 'detailView'>;
    readonly pages: Pick<PagesViewsShape, 'spaceLibraryView'>;
    readonly approvals: ApprovalsViewsShape;
    readonly runs: Pick<RunsViewsShape, 'runsView'>;
    readonly media: MediaViewsShape;
    readonly data: DataspaceViewsShape;
    readonly schedules: Pick<SchedulesViewsShape, 'schedules' | 'withLongRuns' | 'detail'>;
    readonly learning: Pick<LearningViewsShape, 'publishedSkills' | 'containers' | 'container'>;
    readonly inference: InferenceViewsShape;
}

/**
 * What the pages read of the platform beside the views (`PageViews`):
 * the Board's issues, to find the one a page opens, the inference
 * registry the operator's view reads, and what `/api/state` reads, so a
 * page holds what the API returns. The HTTP composition builds it from the graph's tags.
 */
export type PagesPlatform = {
    readonly board: { readonly issues: Pick<BoardIssues, 'get'> };
    /** The server's settings `/api/state` shows under an admin's. */
    readonly config: {
        readonly dotRequestLimits?: StateArgs[4];
        readonly dictationMethods?: StateArgs[5];
        readonly autoTriage?: StateArgs[10];
        readonly traceContent?: boolean;
        readonly otlp?: unknown;
        readonly context?: StateArgs[12];
        readonly appLogs?: StateArgs[13];
        readonly rooms?: StateArgs[14];
        readonly voiceCalls?: StateArgs[15];
        readonly appInviteLinks?: StateArgs[16];
        readonly appPolicy?: StateArgs[17];
    };
    transcriptionSources(): StateArgs[6];
    readonly backups?: { schedule(): StateArgs[9] };
    readonly inference: Parameters<InferenceViewsShape['operatorInferenceView']>[0];
};

export interface WebServiceSources {
    docs?: DocsCatalogShape;
    store: PagesStore;
    /** The same research config the API's `/api/state` reports. */
    config: Config;
    platform?: PagesPlatform;
    /** The features' views (the sign-in screen and the state's version read them without a platform too). */
    views: PageViews;
    auth: AuthSetup;
}

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'text', 'pdf', 'file'];

/** A loader of one answer, asked for at most once. */
const once = <T>(load: () => Promise<T>) => {
    let value: Promise<T> | undefined;
    return () => (value ??= load());
};

/**
 * The services for one request by a user already resolved (`user` is
 * asked at most once; null when signed out). Each answer is kept for the
 * request. The bench calls this directly (scripts/loader-bench.mjs).
 */
export function userServices(sources: WebServiceSources, resolve: () => Promise<User | null>): WebServices {
    const { store, config, platform, auth, views } = sources;
    const user = once(resolve);
    const signedIn = async () => {
        const found = await user();
        if (!found) {
            throw new Error('Signed out: no data for this request.');
        }
        return found;
    };
    return {
        user,
        docsPage: async (url) => sources.docs?.screen(url, (await user())?.role) ?? null,
        docsTree: async () => sources.docs?.tree((await user())?.role) ?? null,
        docsMarkdown: async (url) => sources.docs?.markdown(url, (await user())?.role) ?? null,
        docsSearch: async (query) => (sources.docs ? sources.docs.search(query, (await user())?.role) : []),
        docsLlms: async (full) => sources.docs?.llms(full, (await user())?.role) ?? '# Socio documentation\n',
        signIn: once(async () => views.auth.signInView(auth.provider, brandingInForce(store.settings().branding))),
        state: once(async () =>
            views.state.stateView(
                store,
                config,
                views.releases,
                (await signedIn()).id,
                platform?.config.dotRequestLimits,
                platform?.config.dictationMethods,
                platform?.transcriptionSources(),
                undefined,
                platform && views.limits.defaults(),
                platform?.backups?.schedule(),
                platform?.config.autoTriage,
                platform && {
                    includeContent: platform.config.traceContent,
                    exporting: !!platform.config.otlp,
                },
                platform?.config.context,
                // As `/api/state` has them: the environment's under an admin's,
                // so the first page shows the switch the server uses (Rooms on
                // from ROOMS_ENABLED with nothing saved, CB-212) and the log
                // retention in force.
                platform?.config.appLogs,
                platform?.config.rooms,
                // Calls (CB-265): the first page shows the backend in force.
                platform?.config.voiceCalls,
                platform?.config.appInviteLinks,
                platform?.config.appPolicy,
            ),
        ),
        workspace: once(async () => (platform ? views.workspace.workspaceView(await signedIn()) : undefined)),
        issue: async (number) => {
            const viewer = await signedIn();
            const found = await platform?.board.issues.get(number);
            return platform && found ? views.issues.detailView(found, viewer.id) : null;
        },
        spaceLibrary: async (spaceId, pageId) => {
            const viewer = await signedIn();
            if (!platform) {
                return null;
            }
            try {
                return views.pages.spaceLibraryView(viewer.id, spaceId, {
                    limit: LIBRARY_FIRST_SCREEN,
                    include: pageId,
                });
            } catch (error) {
                // Missing, or a Space they may not read (CB-181): the same.
                if ((error instanceof PageError || error instanceof SpaceAccessError) && error.status === 404) {
                    return null;
                }
                throw error;
            }
        },
        approvals: async () => {
            const { id } = await signedIn();
            return platform ? views.approvals.approvals(id) : null;
        },
        approval: async (requestId) => {
            const { id } = await signedIn();
            return platform ? views.approvals.approval(requestId, id) : null;
        },
        runs: async (limit) => {
            const viewer = await signedIn();
            return platform ? views.runs.runsView(viewer.id, { limit, own: !isAdmin(viewer) }) : null;
        },
        media: async ({ folder, q, kind }) => {
            const { id } = await signedIn();
            // What the API's own query check allows.
            if (
                !platform ||
                (folder?.length ?? 0) > 512 ||
                (q?.length ?? 0) > 200 ||
                (kind && !MEDIA_KINDS.includes(kind))
            ) {
                return null;
            }
            try {
                return await views.media.mediaView(id, { folder, q, kind });
            } catch (error) {
                // A folder the data space refuses (a bad path): the page asks.
                if (error instanceof MediaError || error instanceof DataError) {
                    return null;
                }
                throw error;
            }
        },
        data: async () => {
            const user = await signedIn();
            return platform ? views.data.dataView(user, { files: false }) : null;
        },
        dataset: async (datasetId) => {
            const { id } = await signedIn();
            return platform ? views.data.datasetView(id, datasetId) : null;
        },
        schedules: async () => {
            const user = await signedIn();
            return platform ? views.schedules.withLongRuns(await views.schedules.schedules(user)) : null;
        },
        schedule: async (scheduleId) => {
            const { id } = await signedIn();
            if (!platform) {
                return null;
            }
            try {
                return await views.schedules.detail(id, scheduleId);
            } catch (error) {
                if (error instanceof ScheduleError && error.status === 404) {
                    return null;
                }
                throw error;
            }
        },
        learningSkills: async () => {
            await signedIn();
            return platform ? views.learning.publishedSkills() : null;
        },
        learningContainers: async () => {
            const user = await signedIn();
            return platform && isAdmin(user) ? views.learning.containers() : null;
        },
        learningContainer: async (containerId) => {
            const user = await signedIn();
            return platform && isAdmin(user) && learningContainerIdSchema.safeParse(containerId).data
                ? views.learning.container(containerId, { bodies: false })
                : null;
        },
        inference: async () => {
            const user = await signedIn();
            return platform && isOperator(user) ? views.inference.operatorInferenceView(platform.inference) : null;
        },
        memories: async () => views.memories.view((await signedIn()).id),
    };
}

/**
 * What page loaders call, in this process (no HTTP hop, no second auth
 * pass): one set per page request, each answer kept for the request so
 * the shell loader and a module gate share it. Every answer is what the
 * API returns to the same user, from the same view function (views.ts).
 * Mock auth from another machine is signed out here, as the API refuses
 * it. `resolveUser` is this set's own request user resolver, which records
 * each user once per name and role: the composition builds it with
 * `requestUserResolver(auth, platform)` when it builds these services.
 */
export function webServices(sources: WebServiceSources, resolveUser: RequestUserResolver) {
    const { auth } = sources;
    return (c: Context<AppEnv>): PageServices => {
        const headers: PageServices['headers'] = [];
        const services = userServices(sources, async () =>
            auth.provider.kind === 'mock' && !localRequest(c)
                ? null
                : resolveUser(c.req.raw, (name, value) => headers.push([name, value])),
        );
        return { services, headers };
    };
}
