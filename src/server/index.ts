// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';

import '@socio/foundation/keys/load-secret-files';
import { createAdaptorServer } from '@hono/node-server';
import { Context } from 'effect';

import { openDatabase } from '@socio/data/open';
import { storageSettingsFromEnv } from '@socio/data/storage/settings';
import { appLogRetentionFromEnv } from '@socio/foundation/apps/log-retention';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import { contextSettingsFromEnv } from '@socio/foundation/context/settings';
import { resolveAppOrigins } from '@socio/foundation/http/app-origin';
import { networkTrustFromEnv } from '@socio/foundation/http/network-trust';
import { autoTriageFromEnv, dotRequestLimitsFromEnv } from '@socio/foundation/issues/settings';
import { dataKeysFromEnv, dataKeyWarning } from '@socio/foundation/keys/data-keys';
import { turnTimeLimitSecondsFromEnv } from '@socio/foundation/observability/failures';
import { otlpFromEnv, traceContentFromEnv } from '@socio/foundation/observability/otel-export';
import {
    guardProcessErrors,
    requestLog,
    shutdownCause,
    startStallMonitor,
    trackedFetch,
} from '@socio/foundation/observability/stall-monitor';
import { roomsSettingsFromEnv } from '@socio/foundation/rooms/settings';
import { appInviteLinksFromEnv, appPolicyFromEnv } from '@socio/shared/device-sign-in';
import { dictationAllowedFromEnv } from '@socio/shared/voice/dictation';

import { createApp } from './app.js';
import { appsRuntimeFromEnv } from './apps/runtime-client.js';
import { backupSettingsFromEnv } from './backup/backup-service.js';
import { classifySettingsFromEnv } from './classify/settings.js';
import { cloudFromEnv } from './cloud/settings.js';
import { LeaderWork } from './composition/app/work.js';
import { authFromEnv } from './composition/auth.js';
import {
    analyticsFromEnv,
    appEnvironmentFromEnv,
    codeUsersFromEnv,
    copyAlertLimitsFromEnv,
    pluginBackupLimitsFromEnv,
    cycleLimitsFromEnv,
    dotModelRoundsFromEnv,
    episodeRetentionDaysFromEnv,
    mediaSettingsFromEnv,
    modelSettingsFromEnv,
    notificationLimitsFromEnv,
    pushSettingsFromEnv,
    shutdownForceFromEnv,
    spaceMemoryRetentionDaysFromEnv,
    steeringMaxQueuedFromEnv,
    turnRecallTokensFromEnv,
    type PlatformConfig,
} from './composition/config.js';
import { openCoreStore } from './composition/core-store.js';
import { mountPages, mountProcessRoutes, mountUpgrades } from './composition/http/index.js';
import {
    bootFeatures,
    listening,
    loadDocs,
    shutdownSteps,
    seedCodeGroup,
    startAuth,
    startFeatures,
    syncAccounts,
    warmUp,
} from './composition/lifecycle/index.js';
import { workspaceStoreParts } from './composition/workspace-parts.js';
import { dataSettingsFromEnv } from './dataspace/limits.js';
import { domainsSettingsFromEnv } from './domains/settings.js';
import { deploymentKindFromEnv, flagDefaultsFromEnv } from './flags/env.js';
import { gitHubAppFromEnv } from './github/settings.js';
import { startAppRuntime } from './main.js';
import { bootDatabase } from './modules/boot.js';
import { priceSyncOrigin } from './operations/pricing/fetch.js';
import { operationsSettingsFromEnv } from './operations/settings.js';
import { catalogsFromEnv } from './plugins/catalog.js';
import { pluginRegistryAuthFromEnv, pluginServiceTokenFromEnv } from './plugins/identity.js';
import { sharedReplayer } from './replay/pool.js';
import { drainMsFromEnv } from './runtime/shutdown.js';
import { jobSettingsFromEnv, scheduleSettingsFromEnv } from './schedules/settings.js';
import { webSearchProvider } from './search/select.js';
import { SqliteStateStore } from './telegram/channel-state.js';
import { LocalAgentRunner } from './turns/local-runner.js';
import { updatesFromEnv } from './updates/settings.js';
import { transcriptionFromEnv } from './voice/transcription.js';
import { voiceCallsFromEnv } from './voice/voice-speech.js';
import { webSettingsFromEnv } from './web/web-reads.js';
import { WorkspaceStore } from './workspace/workspace.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const database = process.env.DATABASE_PATH ?? 'data/company-brain.sqlite';
const environment = appEnvironmentFromEnv(process.env);
const shutdownForce = shutdownForceFromEnv(process.env, environment, (line) => console.warn(line));
if (environment === 'development') {
    console.log(
        `Environment: development (operators may force-stop running work; SHUTDOWN_FORCE ${shutdownForce ? 'on' : 'off'}).`,
    );
}
// Validated before the database is touched; Better Auth opens it lazily.
const auth = authFromEnv(process.env, host, { database });
// Files and stored credentials (CB-62); unset: the key from SESSION_SECRET.
const dataKeys = dataKeysFromEnv(process.env);
// BACKUP_DIR, BACKUP_KEEP, BACKUP_INTERVAL_HOURS and the off-site copy (CB-63).
const backupSettings = backupSettingsFromEnv(process.env, {
    dataKey: !!dataKeys.current,
});
for (const warning of auth.warnings) {
    console.warn(`Auth: ${warning}`);
}
// Before any store opens the file: refuses a database from a newer build and
// backs up an existing one before writing to it.
bootDatabase(database, {
    backupDirectory: backupSettings.directory,
    keep: backupSettings.keep,
    log: (line) => console.log(line),
});
// Better Auth: the first admin (AUTH_FIRST_ADMIN_EMAIL) and the workspace owner, before users sync.
await startAuth(auth);
// Deprecated (CB-376): read once, to seed the "Code" group.
const codeUsers = codeUsersFromEnv(process.env);
await seedCodeGroup(auth, codeUsers);
// One connection for the app's own tables, shared by both stores (CB-110).
const connection = openDatabase(database);
const store = openCoreStore(connection);
const workspace = new WorkspaceStore(connection, workspaceStoreParts);
// The accounts the provider knows, and what was there before accounts
// (composition/lifecycle/auth.ts).
await syncAccounts(auth, store, workspace, process.env);
const config: PlatformConfig = {
    ...modelSettingsFromEnv(process.env),
    webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
    parallelApiKey: process.env.PARALLEL_API_KEY,
    searxngUrl: process.env.SEARXNG_URL,
    computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
    computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
    computerToken: process.env.COMPUTER_TOKEN,
    computerNamespace: process.env.COMPUTER_NAMESPACE,
    computerDiskUsageUrl: process.env.COMPUTER_DISK_USAGE_URL,
    voiceKey: process.env.VOICE_API_KEY,
    voiceModel: process.env.VOICE_MODEL,
    voiceName: process.env.VOICE_NAME ?? 'marin',
    dictationMethods: dictationAllowedFromEnv(process.env),
    transcription: transcriptionFromEnv(process.env, (line) => console.warn(line)),
    voiceCalls: voiceCallsFromEnv(process.env, (line) => console.warn(line)),
    codeUsers,
    dotModelRounds: dotModelRoundsFromEnv(process.env),
    turnTimeLimitSeconds: turnTimeLimitSecondsFromEnv(process.env),
    turnRecallTokens: turnRecallTokensFromEnv(process.env),
    episodeRetentionDays: episodeRetentionDaysFromEnv(process.env),
    spaceMemoryRetentionDays: spaceMemoryRetentionDaysFromEnv(process.env),
    steeringMaxQueued: steeringMaxQueuedFromEnv(process.env),
    ...cycleLimitsFromEnv(process.env),
    ...copyAlertLimitsFromEnv(process.env),
    ...pluginBackupLimitsFromEnv(process.env),
    github: gitHubAppFromEnv(process.env),
    runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
    environment,
    dotRequestLimits: dotRequestLimitsFromEnv(process.env),
    autoTriage: autoTriageFromEnv(process.env),
    rooms: roomsSettingsFromEnv(process.env),
    appInviteLinks: appInviteLinksFromEnv(process.env),
    appPolicy: appPolicyFromEnv(process.env),
    classify: classifySettingsFromEnv(process.env),
    notificationLimits: notificationLimitsFromEnv(process.env),
    push: pushSettingsFromEnv(process.env),
    web: webSettingsFromEnv(process.env),
    // Unset only on loopback (authFromEnv): then stored inference keys can't
    // be read after a restart, like sign-ins.
    sessionSecret: process.env.SESSION_SECRET?.trim() || undefined,
    dataKeys,
    appOrigin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV)?.[0],
    // The data space: /data/userdata next to /data/company-brain.sqlite.
    data: dataSettingsFromEnv(process.env, join(dirname(database), 'userdata')),
    // Its files in S3 (SeaweedFS in the stack) when S3_ENDPOINT is set (CB-54).
    storage: storageSettingsFromEnv(process.env),
    media: mediaSettingsFromEnv(process.env),
    // Mini apps: `<APPS_LABEL_PREFIX><app>--<dot>.<APPS_HOST>`,
    // apps.<APP_ORIGIN host> by default.
    apps: appsSettingsFromEnv(process.env, resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV)?.[0]),
    schedules: scheduleSettingsFromEnv(process.env),
    jobs: jobSettingsFromEnv(process.env),

    // Workspace plugins (docs/PLUGINS.md). Empty unless PLUGIN_CATALOGS is set.
    // They run as services of the same apps runtime as promoted mini apps.
    plugins: {
        catalogs: catalogsFromEnv(process.env),
        // Deprecated by Socio Secrets: read for one release, with a warning.
        ...pluginServiceTokenFromEnv(process.env, (line) => console.warn(line)),
        ...pluginRegistryAuthFromEnv(process.env, (line) => console.warn(line)),
    },
    appsRuntime: appsRuntimeFromEnv(process.env, process.env.DATA_API_URL?.trim() || undefined),
    // Hostnames through NPM and Cloudflare; off until all are set.
    domains: domainsSettingsFromEnv(process.env),
    // Updates (CB-259): the release feed operators see, and the updater
    // sidecar that applies one; notify-only without UPDATER_URL.
    updates: updatesFromEnv(process.env),
    // The cloud connection: sends nothing without an enrollment token or a
    // stored identity, and never with SOCIO_CLOUD=off.
    cloud: cloudFromEnv(process.env),
    // Feature flags' instance defaults (CB-169), under Settings' rules.
    featureFlags: flagDefaultsFromEnv(process.env, (line) => console.warn(line)),
    // CB-503: only an internal deployment may have flags in development.
    deploymentKind: deploymentKindFromEnv(process.env),
    // Turn traces to an OpenTelemetry collector (CB-128); off until set.
    otlp: otlpFromEnv(process.env),
    traceContent: traceContentFromEnv(process.env),
    context: contextSettingsFromEnv(process.env),
    appLogs: appLogRetentionFromEnv(process.env),
    // The Operations dashboard's reporting time zone (CB-164); UTC when unset.
    operations: operationsSettingsFromEnv(process.env),
    // The daily price sync's sources (CB-195), when they are mirrored.
    priceSyncUrl: priceSyncOrigin(process.env.OPS_PRICE_SYNC_URL),
    // Operations' DuckDB store (CB-186): /data/analytics next to the database.
    analytics: analyticsFromEnv(process.env, database, join(dirname(database), 'analytics')),
};
if (config.apps) {
    console.log(`Mini apps: served on ${config.apps.labelPrefix}*.${config.apps.host}.`);
}
if (config.appsRuntime) {
    console.log(`Mini apps: promoted apps run in ${config.appsRuntime.url}.`);
}
console.log(
    config.analytics?.mode === 'service'
        ? `Analytics: the socio-analytics service at ${config.analytics.url}.`
        : config.analytics
          ? 'Analytics: a child process of this app (OPS_ANALYTICS_MODE=child).'
          : 'Analytics: off (OPS_ANALYTICS_MODE=off).',
);
console.log(
    config.domains?.settings
        ? `Domains: ${config.domains.settings.base} and *.${config.domains.settings.base} through ${config.domains.settings.npm.url}${config.domains.settings.acmeEmail ? '' : ' (DOMAINS_ACME_EMAIL unset: no certificates)'}.`
        : `Domains: off (${config.domains?.missing.join(', ')} not set).`,
);
console.log(
    config.updates?.defaults.feed
        ? `Updates: checking ${config.updates.defaults.feed.kind}:${config.updates.defaults.feed.repository}${config.updates.defaults.checkHours ? ` every ${config.updates.defaults.checkHours} hour(s)` : ' only when an operator asks'}; ${config.updates.updater ? 'the updater applies them' : 'notify only (no UPDATER_URL)'}.`
        : `Updates: no release feed in the environment (UPDATES_FEED); operators can set one on the Platform page${config.updates?.updater ? '' : '; notify only (no UPDATER_URL)'}.`,
);
if (config.updates?.updaterProblem) {
    console.warn(`Updates: ${config.updates.updaterProblem}; the updater is off.`);
}
console.log(
    config.storage?.s3
        ? `Data space: files in S3 bucket ${config.storage.s3.bucket} (tenant ${config.storage.tenantId}).`
        : 'Data space: files on the local disk (S3_ENDPOINT not set).',
);
const dataKeyLine = dataKeyWarning(config.dataKeys ?? {}, environment);
if (dataKeyLine) {
    console.warn(dataKeyLine);
}
if (!config.sessionSecret) {
    console.warn(
        'Inference: SESSION_SECRET is not set, so backend keys and connections stored now can’t be read after a restart.',
    );
}
// The composition root (main.ts): every layer built once, here, before any
// route is mounted. `edge` is what the HTTP edge and the boot steps take: the
// runtime and its services.
const { runtime: appRuntime, edge } = await startAppRuntime({
    db: connection,
    store,
    workspace,
    config,
    runner: new LocalAgentRunner(database, { replayer: sharedReplayer() }),
    // The provider built and started above, not a second one.
    auth,
});
// Each feature's boot step, in order (composition/lifecycle/index.ts):
// backups, inference kinds, Telegram, the task runner and the leader lease.
const { researchConfig, runner, leader, pruning } = bootFeatures({
    database,
    telegramState: () => new SqliteStateStore(database),
    connection,
    backupSettings,
    dataKeys,
    config,
    store,
    workspace,
    edge,
    auth,
    env: process.env,
    superseded: () => void shutdown(),
});
// CB-309: the computers network reaches only the data API, and only the
// reverse proxy may set X-Forwarded-For.
const network = networkTrustFromEnv(process.env);
if (process.env.AUTH_TRUST_PROXY?.trim() === 'true' && !network.proxies.length) {
    console.warn(
        'AUTH_TRUST_PROXY is on without TRUSTED_PROXY_SUBNETS: any peer outside COMPUTERS_SUBNET may set X-Forwarded-For.',
    );
}
const docs = await loadDocs(edge);
const app = createApp({
    store,
    runner,
    config: researchConfig,
    origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
    edge,
    auth,
    network,
    runtime: appRuntime,
});
// The security headers and the health check, after the app's own routes.
mountProcessRoutes(app, edge, leader);
// The requests in flight lately, which a stall's log line names (CB-318).
const requests = requestLog();
// An HTTP/1 server (createAdaptorServer's default).
const server = createAdaptorServer({
    // Each request is held until its response is written to the end (a
    // streamed body included), so a stall while streaming names it.
    fetch: trackedFetch(requests, (request: Request, env: unknown) => app.fetch(request, env as never)),
    hostname: host,
}) as Server;
// The pages, rendered by React Router (packages/client/src). In development, Vite
// runs inside this server and its hot reload shares the port.
const development = process.env.NODE_ENV === 'development';
await mountPages(app, server, {
    development,
    origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
    store,
    config: researchConfig,
    edge,
    auth,
    docs,
});
// WebSockets: Vite's hot reload in development, mini apps' origins,
// then live dictation's socket (CB-222), through the app's own checks.
mountUpgrades(app, server, edge, development);
// What runs on every runtime, not only the leader: socio access, the coding
// gateway's internal listener and the mini apps' (composition/lifecycle/).
const started = startFeatures(edge, process.env);
// Before listening, so /healthz answers only after it and a start-first
// update keeps routing to the previous task meanwhile: sign-in's modules
// and a first page render, which the first requests otherwise pay for on
// the main thread (composition/lifecycle/warm.ts).
await warmUp(app, auth, { origin: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}` });
server.listen(port, host, () =>
    listening(edge, leader, () => {
        const address = server.address();
        console.log(
            `Socio listening on http://${host}:${typeof address === 'object' && address ? address.port : port}`,
        );
    }),
);
// Drains first (CB-37): running turns finish, new ones are refused
// (composition/lifecycle/index.ts has the order).
drainMsFromEnv(process.env); // a bad SHUTDOWN_DRAIN_MS stops the start
const shutdown = shutdownSteps({
    env: process.env,
    shutdownForce,
    config,
    store,
    workspace,
    connection,
    edge,
    appRuntime,
    runner,
    leader,
    pruning,
    started,
    server,
});
// CB-318: a main-thread stall leaves a log line with what was running
// (turns, runs and the requests open during it), the
// shutdown says why it started, and an error that reaches the top is one
// structured line (observed only: Node still exits as it would).
const leaderWork = Context.get(edge.services, LeaderWork);
const stalls = startStallMonitor({
    activity: ({ from, to }) => {
        const turns = runner.running;
        const other = leaderWork.inProgress();
        const answering = requests.during(from, to);
        return (
            [
                turns || other ? `${turns} turn(s), ${other} other run(s)` : '',
                answering.length ? `requests ${answering.join(', ')}` : '',
            ]
                .filter(Boolean)
                .join('; ') || undefined
        );
    },
});
// CB-516: an undici connection notice is logged, not fatal; anything else still exits.
guardProcessErrors();
const stopOn = (signal: NodeJS.Signals) => () => {
    console.log(shutdownCause(signal, process.uptime(), stalls));
    stalls.stop();
    void shutdown();
};
process.on('SIGTERM', stopOn('SIGTERM'));
process.on('SIGINT', stopOn('SIGINT'));
