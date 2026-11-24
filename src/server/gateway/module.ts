import { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { CODING_SESSION_CAPABILITIES, CODING_TOOL_NAMES } from '@socio/shared/coding/coding-sessions';
import { MODULE_IDS } from '@socio/shared/modules';

import type { ServerModule } from '../modules/contract.js';

import { HostedGateway } from './adopted.js';
import { extractTools } from './extract-tools.js';
import { gitSettingsRoutes } from './git.js';
import { modelSettingsRoutes } from './model.js';
import { gatewaySchema } from './schema.js';

/**
 * The coding gateway's module (CB-239): its admin routes under
 * `/api/gateway` (the models and limits, the Git proxy's repositories), a
 * person's own coding sessions (`/api/gateway/sessions`), and the socio
 * tools its parts add (`repo_extract`, CB-267; `coding_*`), composed from
 * the parts' own files so they never edit the registry. The listener runs
 * on every runtime from the server entry (`createGatewayServer`), not
 * here; the leader's tick follows coding sessions (runs taken over after a
 * drain, limits, the reaper).
 *
 * Its hooks read what the platform's gateways are made from, and the
 * coding sessions they host, as the composition adopted them
 * (`HostedGateway`, `adopted.ts`), from the app's services at the moment
 * of use.
 */
export const gatewayModule: ServerModule = {
    id: MODULE_IDS.gateway,
    // The phases' tables, in one ordered list (schema.ts).
    migrations: gatewaySchema.migrations,
    routes: ({ services }) => {
        const { sources, coding } = services.get(HostedGateway);
        const app = new Hono<AppEnv>();
        for (const routes of [modelSettingsRoutes(sources), gitSettingsRoutes(sources), coding.routes()]) {
            if (routes) {
                app.route('/gateway', routes);
            }
        }
        return app;
    },
    dotTools: ({ services }, turn) => {
        const { sources, coding } = services.get(HostedGateway);
        return [...extractTools(sources, turn), ...coding.tools.dotTools(turn)];
    },
    capabilities: ({ services }) => [
        {
            id: 'coding',
            label: 'Coding sessions',
            description:
                'Run a coding agent on a listed repository for the person you act for, in a sandbox of its own (coding_start, then coding_prompt; coding_status, coding_diff, coding_open_pr, coding_stop). They approve each session on a card, every time.',
            tools: CODING_TOOL_NAMES,
            approvals: Object.values(CODING_SESSION_CAPABILITIES),
            status: (turn) => {
                const { sources, coding } = services.get(HostedGateway);
                const on =
                    sources.flags.enabled('socio-actor-access', turn.userId) &&
                    sources.flags.enabled('coding-sessions', turn.userId);
                const configured = coding.sessions.configured;
                return {
                    enabled: on && configured,
                    ...(on
                        ? configured
                            ? {}
                            : { note: 'Coding sandboxes are not set up on this server.' }
                        : { note: 'Not available to this person yet.' }),
                };
            },
        },
    ],
    tick: {
        everyMs: 15_000,
        run: ({ services, log }) =>
            services
                .get(HostedGateway)
                .coding.sessions.tick()
                .catch(() => log('Coding sessions: the tick failed.')),
    },
    stop: ({ services }) => services.get(HostedGateway).coding.sessions.shutdown(),
};
