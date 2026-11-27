/**
 * The HTTP edge's order: every middleware and route of the app, mounted in the
 * order app.ts mounted them. Hono runs them in the order they are added, so
 * this order is the security boundary: the computers guard, then the apps
 * proxy, the public routes, the body limit, data tokens, plugin identities,
 * service keys, plugin services, the browser checks, the app's version
 * check, sign-in, the session check, draining, then the features' routes. tests/http-order.test.ts pins it.
 *
 * Each step lives in its feature's `composition/http/<x>.ts`, or in
 * `edge.ts` when no feature owns it. This file only orders them.
 */
import type { IncomingMessage, Server } from 'node:http';

import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { NetworkTrust } from '@socio/foundation/http/network-trust';
import { CLIENT_COMPAT, type ClientCompat } from '@socio/shared/client-compat';

import type { AuthSetup } from '../../auth/contract.js';
import type { I18nCatalogShape } from '../../i18n/contract.js';
import type { AppEdge, AppRuntime } from '../../main.js';
import type { LeaderLease } from '../../runtime/background.js';
import type { Runner } from '../../turns/runner.js';
import type { ReleaseData } from '../../updates/releases.js';
import type { Config } from '../../web/research.js';
import type { CoreStore } from '../core-store.js';

import { agentsRoutes } from './agents.js';
import { appsRoutes } from './apps.js';
import { authRoutes } from './auth.js';
import { backupRoutes } from './backup.js';
import { computersRoutes } from './computers.js';
import { dataspaceRoutes } from './dataspace.js';
import { edgeRoutes } from './edge.js';
import { bindAppRuntime } from './handle.js';
import { i18nHttpRoutes } from './i18n.js';
import { inferenceRoutes } from './inference.js';
import { liveRoutes } from './live.js';
import { mcpRoutes } from './mcp.js';
import { memoryRoutes } from './memory.js';
import { modulesRoutes } from './modules.js';
import { notificationsRoutes } from './notifications.js';
import { operatorRoutes } from './operator.js';
import { pluginsRoutes } from './plugins.js';
import { runtimeRoutes } from './runtime.js';
import { serviceAccountsRoutes } from './service-accounts.js';
import { settingsRoutes } from './settings.js';
import { turnsRoutes } from './turns.js';
import { updatesRoutes } from './updates.js';
import { voiceRoutes } from './voice.js';
import { webRoutes } from './web.js';
import { workspaceRoutes } from './workspace.js';

/** The largest chat request body (edge.ts). */
export const CHAT_REQUEST_BYTES = edgeRoutes.chatRequestBytes;

export interface AppOptions {
    store: CoreStore;
    runner: Runner;
    config: Config;
    origin?: string | string[];
    /** The app's runtime and its services (main.ts); none in tests of the bare edge. */
    edge?: AppEdge;
    auth: AuthSetup;
    /** Socio's version and releases; the build's by default (releases.ts). */
    releases?: () => ReleaseData;
    /** The computers network and trusted proxies (CB-309); none by default. */
    network?: NetworkTrust;
    /**
     * The process's runtime (main.ts), for routes run through `appHandle(app)` (handle.ts); none in most tests.
     * Bound only when given here, not taken from `edge`.
     */
    runtime?: AppRuntime;
    /** Which app versions this server works with (CB-553): shared's `CLIENT_COMPAT` unless the environment says otherwise. */
    clientCompat?: ClientCompat;
    /** The dictionaries; the process's (composition/i18n.ts) by default. */
    i18n?: I18nCatalogShape;
}

/** Every middleware and route of the app, in order (createApp in app.ts). */
export function mountApp(app: Hono<AppEnv>, options: AppOptions) {
    const {
        store,
        runner,
        config,
        origin,
        edge,
        auth,
        releases,
        network = { proxies: [] },
        runtime,
        i18n,
        clientCompat = CLIENT_COMPAT,
    } = options;
    if (runtime) {
        bindAppRuntime(app, runtime);
    }
    edgeRoutes.computersGuard(app, network);
    if (edge) {
        authRoutes.wireAccounts(auth, edge);
    }
    const { navigationPaths, tokenPaths } = authRoutes.signInPaths(auth, mcpRoutes.navigationPaths(edge));
    appsRoutes.proxy(app, edge);
    edgeRoutes.compressionAndPing(app);
    if (edge) {
        notificationsRoutes.images(app, edge);
        pluginsRoutes.feeds(app, edge, origin);
    }
    webRoutes.agentsPage(app, edge);
    i18nHttpRoutes.routes(app, i18n);
    if (edge) {
        agentsRoutes.mcp(app, edge, origin);
    }
    const limit = edgeRoutes.bodyLimit(app);
    dataspaceRoutes.tokens(app, edge);
    pluginsRoutes.identities(app, edge);
    pluginsRoutes.dataTokens(app, edge);
    serviceAccountsRoutes.keys(app, edge);
    pluginsRoutes.serviceCalls(app, edge);
    pluginsRoutes.actorCalls(app, edge);
    edgeRoutes.requestChecks(app, { auth, origin, navigationPaths, tokenPaths });
    updatesRoutes.clientCompat(app, clientCompat);
    authRoutes.signIn(app, auth, store);
    if (edge) {
        mcpRoutes.oauth(app, edge);
    }
    authRoutes.session(app, auth, edge);
    edgeRoutes.chatLimit(app, limit);
    authRoutes.protectedRoutes(app, auth);
    if (edge) {
        runtimeRoutes.draining(app, edge);
        computersRoutes.routes(app, edge);
        serviceAccountsRoutes.routes(app, edge);
        agentsRoutes.grants(app, edge);
        inferenceRoutes.routes(app, edge);
        webRoutes.routes(app, edge);
        operatorRoutes.routes(app, edge, runner);
        authRoutes.accessPolicy(app, auth, edge);
        modulesRoutes.routes(app, edge);
    }
    const voice = voiceRoutes.service(edge);
    if (edge && voice) {
        workspaceRoutes.routes(app, edge, voice);
    }
    liveRoutes.state(app, store, config, edge);
    turnsRoutes.routes(app, store, runner, edge);
    settingsRoutes.routes(app, { store: store.slices.settings, runner, edge, voice });
    backupRoutes.routes(app, edge);
    memoryRoutes.routes(app, store, edge);
    updatesRoutes.releases(app, releases);
    if (edge) {
        updatesRoutes.releaseSeen(app, edge, releases);
    }
    edgeRoutes.errorAnswer(app);
}

/**
 * What the process entry adds after the app's own routes, before the
 * pages: the security headers and the health check.
 */
export function mountProcessRoutes(app: Hono<AppEnv>, edge: AppEdge, leader: LeaderLease) {
    edgeRoutes.securityHeaders(app);
    runtimeRoutes.health(app, edge, leader);
}

/** The pages, rendered by React Router (web.ts). */
export const mountPages = webRoutes.pages;

/**
 * The server's WebSocket upgrades, in order: Vite's hot reload in
 * development (Vite answers it on the same server), mini apps' origins,
 * then live dictation's socket (CB-222); anything else is closed.
 */
export function mountUpgrades(app: Hono<AppEnv>, server: Server, edge: AppEdge, development: boolean) {
    const upgrade = appsRoutes.sockets(edge);
    const hotReload = (request: IncomingMessage) =>
        development && ['vite-hmr', 'vite-ping'].includes(request.headers['sec-websocket-protocol'] ?? '');
    const dictationSocket = voiceRoutes.dictationSockets(app);
    server.on('upgrade', (request, socket, head) => {
        if (hotReload(request)) {
            return;
        }
        if (upgrade(request, socket, head)) {
            return;
        }
        if (!dictationSocket(request, socket, head)) {
            socket.destroy();
        }
    });
}
