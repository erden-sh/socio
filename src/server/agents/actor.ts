import type { AgentActor } from '@socio/foundation/agents/actor';

/**
 * Connected agents (CB-90): an external agent (Claude Code, Cursor, ...)
 * acting for one person through a grant they approved. Like a Dot, every
 * action it takes carries both identities: the agent (its OAuth client and
 * the grant) and the person. The auth side (OAuth 2.1 + CIMD) resolves a
 * bearer token to an `AgentActor`; the MCP side acts only through one.
 */

/** "Claude Code on laptop for Ada": how agent actions are shown. */
export const agentByline = (actor: Pick<AgentActor, 'label'>, person: string) => `${actor.label} for ${person}`;
