/** The live state every tab polls, at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJsonAsync } from '@socio/foundation/http/conditional';
import { PRESENCE_HEADER } from '@socio/shared/notifications';
import { parsePresence } from '@socio/shared/notifications/presence';

import { stateVersion } from '../../live/view-versions.js';
import { stateView } from '../../live/views/state.js';
import type { AppEdge } from '../../main.js';
import { limitDefaults } from '../../settings/limits.js';
import { releases } from '../../updates/layer.js';
import type { Config } from '../../web/research.js';
import { AppStatus } from '../app/status.js';
import { LegacyConfig } from '../base.js';
import { stateStoreOf, type CoreStore } from '../core-store.js';
import { LegacyNotifications } from '../notifications.js';
import { Ports } from '../ports.js';

/**
 * Polled by every tab: 304 when nothing changed (conditional.ts). Each
 * poll also says whether its tab is in use (CB-114, presence.ts).
 */
export function mountState(app: Hono<AppEnv>, store: CoreStore, config: Config, edge: AppEdge | undefined) {
    // What the state reads beside the store, none without the app's
    // services; scheduled backups through their late port, at each poll.
    const sources = edge && {
        config: Context.get(edge.services, LegacyConfig),
        notifications: Context.get(edge.services, LegacyNotifications),
        status: Context.get(edge.services, AppStatus),
        backups: Context.get(edge.services, Ports).backups,
    };
    app.get('/api/state', (c) => {
        const presence = parsePresence(c.req.header(PRESENCE_HEADER));
        if (presence && sources) {
            sources.notifications.presence.tab(c.get('user').id, presence.tab, presence.path);
        }
        return conditionalJsonAsync(
            c,
            () =>
                stateView(
                    stateStoreOf(store),
                    config,
                    // The build's releases, the value updates' `Releases` holds.
                    releases,
                    c.get('user').id,
                    sources?.config.dotRequestLimits,
                    sources?.config.dictationMethods,
                    sources?.status.transcriptionSources(),
                    sources && {
                        service: sources.notifications,
                        limits: sources.config.notificationLimits,
                    },
                    sources && limitDefaults(sources.config),
                    sources?.backups.peek()?.schedule(),
                    sources?.config.autoTriage,
                    sources && {
                        includeContent: sources.config.traceContent,
                        exporting: !!sources.config.otlp,
                    },
                    sources?.config.context,
                    sources?.config.appLogs,
                    sources?.config.rooms,
                    sources?.config.voiceCalls,
                    sources?.config.appInviteLinks,
                    sources?.config.appPolicy,
                ),
            () => stateVersion(store, c.get('user')),
        );
    });
}

/** The live state's step, as index.ts mounts it. */
export const liveRoutes = { state: mountState };
