/**
 * Connected agents' scopes (CB-90): what a grant may reach. Moved from
 * `src/server/agents/actor.ts`, which re-exports them.
 */
import { parsePluginScope } from '../plugins/plugins.js';

/** What a grant may reach. Effective access is these ∩ the person's role. */
export const AGENT_SCOPES = [
    'issues:read',
    'issues:write',
    'pages:read',
    'pages:write',
    'docs:read',
    // Legacy plugin scopes (v0.22.0): the social planner's tools only
    // (LEGACY_SCOPE_PLUGINS). Every other plugin has its own scopes,
    // `plugins:<id>:read|write` (isGrantableScope).
    'plugins:read',
    'plugins:write',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * A scope a grant may hold: one of `AGENT_SCOPES`, or one plugin's own
 * (`plugins:<id>:read|write`, CB-254). The authorization server offers
 * only the per-plugin scopes of this instance's catalog; a tool still
 * needs its plugin installed and the person in its audience.
 */
export function isGrantableScope(scope: string) {
    return (AGENT_SCOPES as readonly string[]).includes(scope) || !!parsePluginScope(scope);
}
