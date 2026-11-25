/**
 * The web at the HTTP edge: the public agents page, web reads' routes, and the
 * pages React Router renders. `index.ts` mounts each where app.ts and the
 * process entry did.
 *
 * Web reads' routes read `WebReader` and `WebIdentities` through the app's
 * runtime (`appHandle(app).uninterruptible`). The agents page reads only
 * the settings, and the pages run React Router with per-request services
 * over the app's services and the features' views (`web/services.ts`), so neither
 * runs an Effect: `mountPages` reads the views' tags once, from the runtime
 * `createApp` bound to the app (`boundAppRuntime`), and every loader,
 * including those the docs' exports call synchronously (`services(c)`),
 * uses those values.
 */
import type { Server } from 'node:http';

import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { ApprovalsViews } from '../../approvals/contract.js';
import { AuthViews, type AuthSetup } from '../../auth/contract.js';
import { requestUserResolver } from '../../auth/request-user.js';
import { DataspaceViews } from '../../dataspace/contract.js';
import type { DocsCatalogShape } from '../../docs/contract.js';
import { mountDocsExports } from '../../docs/http.js';
import { InferenceViews } from '../../inference/contract.js';
import { IssuesViews } from '../../issues/contract.js';
import { SqliteBoardService } from '../../issues/layer.js';
import { LearningViews } from '../../learning/contract.js';
import { stateView } from '../../live/views/state.js';
import type { AppEdge, AppServices } from '../../main.js';
import { MediaViews } from '../../media/contract.js';
import { MemoriesView } from '../../memory/contract.js';
import { PagesViews } from '../../pages/contract.js';
import { RunsViews } from '../../runs/contract.js';
import { SchedulesViews } from '../../schedules/contract.js';
import { Limits } from '../../settings/contract.js';
import { Releases } from '../../updates/contract.js';
import { serveAgentsPage } from '../../web/agents-page.js';
import { mountWeb, type WebBuild } from '../../web/mount.js';
import { productionWeb } from '../../web/prod.js';
import type { Config } from '../../web/research.js';
import { webServices, type PagesPlatform, type PageViews } from '../../web/services.js';
import { webSettingsFromEnv } from '../../web/web-reads.js';
import { webRoutes as webApiRoutes } from '../../web/web-routes.js';
import { WorkspaceViews } from '../../workspace/contract.js';
import { AppStatus } from '../app/status.js';
import { LegacyConfig, LegacyWorkspace } from '../base.js';
import { stateStoreOf, type CoreStore } from '../core-store.js';
import { processI18nCatalog } from '../i18n.js';
import { LegacyInference } from '../inference.js';
import { LegacyPlugins } from '../plugins.js';
import { Ports } from '../ports.js';

import { appHandle, boundAppRuntime } from './handle.js';

/** Public and static: what the web-read User-Agent links to. */
export function mountAgentsPage(app: Hono<AppEnv>, edge: AppEdge | undefined) {
    serveAgentsPage(app, (edge && Context.get(edge.services, LegacyConfig).web) ?? webSettingsFromEnv({}));
}

export function mountWebRoutes(app: Hono<AppEnv>, edge: AppEdge) {
    // Run to their end if the client goes away, as the plain handlers did:
    // no interruption, so no logged 500 for a request nobody waits for.
    app.route('/api', webApiRoutes(Context.get(edge.services, LegacyWorkspace), appHandle(app).uninterruptible));
}

/**
 * The views the pages answer with, as the app's runtime built them (each
 * feature's tag), and live's state view (`GET /api/state`'s).
 */
export function pageViewsOf(context: Context.Context<AppServices>): PageViews {
    return {
        auth: Context.get(context, AuthViews),
        releases: Context.get(context, Releases),
        state: { stateView },
        memories: Context.get(context, MemoriesView),
        limits: Context.get(context, Limits),
        workspace: Context.get(context, WorkspaceViews),
        issues: Context.get(context, IssuesViews),
        pages: Context.get(context, PagesViews),
        approvals: Context.get(context, ApprovalsViews),
        runs: Context.get(context, RunsViews),
        media: Context.get(context, MediaViews),
        data: Context.get(context, DataspaceViews),
        schedules: Context.get(context, SchedulesViews),
        learning: Context.get(context, LearningViews),
        inference: Context.get(context, InferenceViews),
    };
}

/**
 * What the pages read beside the views (`PagesPlatform`), made once from the
 * app's services: scheduled backups through their late port, at each read.
 */
export function pagesSources(services: AppEdge['services']): PagesPlatform {
    const status = Context.get(services, AppStatus);
    const backups = Context.get(services, Ports).backups;
    return {
        board: Context.get(services, SqliteBoardService),
        config: Context.get(services, LegacyConfig),
        transcriptionSources: () => status.transcriptionSources(),
        get backups() {
            return backups.peek();
        },
        inference: Context.get(services, LegacyInference),
    };
}

/**
 * The pages, rendered by React Router (packages/client/src). In development, Vite
 * runs inside `server` and its hot reload shares the port. `app` must have
 * the app's runtime bound (`createApp({ runtime })`), already built
 * (`startAppRuntime`): the loaders read the features' views from it.
 */
export async function mountPages(
    app: Hono<AppEnv>,
    server: Server,
    {
        development,
        origin,
        store,
        config,
        edge,
        auth,
        docs,
    }: {
        development: boolean;
        origin: string[] | undefined;
        store: CoreStore;
        config: Config;
        edge: AppEdge;
        auth: AuthSetup;
        docs: DocsCatalogShape;
    },
) {
    const { services } = edge;
    const runtime = boundAppRuntime(app);
    if (!runtime) {
        throw new Error('The pages read the views through the app runtime, but this app has none.');
    }
    // Built by `startAppRuntime` before any mount: this reads it, builds nothing.
    const views = pageViewsOf(await runtime.context());
    const web: WebBuild = development
        ? await (await import('../../web/dev.js')).developmentWeb(server)
        : await productionWeb();
    const plugins = Context.get(services, LegacyPlugins);
    const options = {
        ...web,
        origin,
        services: webServices(
            {
                store: stateStoreOf(store),
                config,
                platform: pagesSources(services),
                views,
                auth,
                docs,
                i18n: {
                    catalog: processI18nCatalog(),
                    preference: (userId) => Context.get(services, LegacyWorkspace).preferences(userId).locale,
                },
                appearancePreferences: (userId) => Context.get(services, LegacyWorkspace).preferences(userId),
            },
            // Its own resolver, with its own record of whom it wrote (the API's is another).
            requestUserResolver(auth, { workspace: Context.get(services, LegacyWorkspace) }),
        ),
        // An embedded plugin is framed from its apps-host origin only.
        frameSrc: (path: string) => plugins.embedOrigin(path),
    };
    // The docs' Markdown and llms.txt exports first: `.md` and `.txt` are
    // protected exports, not static files.
    mountDocsExports(app, options);
    mountWeb(app, options);
}

/** The web's steps, as index.ts and the process entry mount them: the agents page, web reads' routes and the pages. */
export const webRoutes = { agentsPage: mountAgentsPage, routes: mountWebRoutes, pages: mountPages };
