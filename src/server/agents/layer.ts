/**
 * Connected agents' layer: one `AgentGrants` on the workspace connection,
 * offered as `Grants` (what auth and the composition call), `GrantAdmin`
 * (agents' own routes), `AgentTokens` (the MCP endpoint's resolver) and
 * `AgentGrantsService` (the class, which the composition offers as
 * `LegacyAgentGrants`). Only the composition (`composition/agents.ts`) and
 * tests import this file.
 *
 * The client metadata documents' fetcher (`CimdFetcher`) stays auth's to
 * build: its options are auth's config (`auth/better-auth.ts`), so nothing
 * here makes it.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Layer } from 'effect';

import { AgentTokens, GrantAdmin, Grants } from './contract.js';
import { AgentGrants } from './grants.js';

/** The grants' class, under one tag: what `LegacyAgentGrants` holds. */
export class AgentGrantsService extends Context.Service<AgentGrantsService, AgentGrants>()(
    'socio/agents/AgentGrantsService',
) {}

/** Connected agents' grants (CB-90), on the workspace connection. */
export function agentGrants(db: DatabaseSync): AgentGrants {
    return new AgentGrants(db);
}

/**
 * One `AgentGrants` under every tag: the same instance, and `AgentTokens`
 * resolving through it at each call.
 */
export const agentGrantsContext = (grants: AgentGrants) =>
    Context.make(AgentGrantsService, grants).pipe(
        Context.add(Grants, grants),
        Context.add(GrantAdmin, grants),
        Context.add(AgentTokens, (token: string, resource: string) => grants.resolve(token, resource)),
    );

/** `AgentGrantsService`, `Grants`, `GrantAdmin` and `AgentTokens`, built once over `db`. */
export const AgentGrantsLive = (db: DatabaseSync) => Layer.syncContext(() => agentGrantsContext(agentGrants(db)));
