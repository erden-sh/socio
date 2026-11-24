/**
 * Connected agents' construction: their layer (`agents/layer.ts`) on the boot
 * step's workspace connection, and the builder the tests call
 * (`buildAgentGrants`).
 *
 * No `AgentsConfig`: agents reads no field of the startup configuration.
 * The MCP endpoint's allowed origins come from the HTTP composition
 * (`composition/http/agents.ts`), and the client metadata documents'
 * options are auth's.
 */
import { Effect, Layer } from 'effect';

import type { AgentGrants } from '../agents/grants.js';
import { agentGrants, AgentGrantsLive, AgentGrantsService } from '../agents/layer.js';

import { LegacyWorkspace } from './base.js';
import type { AppWorkspace } from './workspace-parts.js';

/** Connected agents' grants (CB-90). */
export function buildAgentGrants(workspace: AppWorkspace): AgentGrants {
    return agentGrants(workspace.db);
}

/**
 * Connected agents' grants, under the graph's `LegacyAgentGrants` tag (the class):
 * agents' own `AgentGrantsService` tag, under its old name.
 */
export const LegacyAgentGrants = AgentGrantsService;

/**
 * Connected agents' step of the graph: `agents/layer.ts`'s grants on the
 * workspace connection, offered as `LegacyAgentGrants`, `Grants`,
 * `GrantAdmin` and `AgentTokens` (the MCP endpoint's resolver, through
 * those same grants).
 */
export const agentsLayers = {
    grants: Layer.unwrap(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            return AgentGrantsLive(db);
        }),
    ),
};
