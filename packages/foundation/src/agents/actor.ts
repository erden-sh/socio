/*
 * Connected agents' actor (CB-90), moved here from
 * `server/agents/contract.ts` so that the Board (`server/issues`), below
 * agents in the folder order, can name it.
 */

/** A connected agent acting for one person, through one grant (CB-90). */
export interface AgentActor {
    /** The grant: one person's approval of one client, revocable. */
    grantId: string;
    /** The OAuth client id: for CIMD clients, the metadata document's https URL. */
    clientId: string;
    /** The client's name from its metadata ("Claude Code"). */
    clientName: string;
    /** The host the client id is served from, shown on consent ("claude.ai"); null for unverified local apps. */
    clientDomain: string | null;
    /** The person's label for this connection ("Claude Code on laptop"). */
    label: string;
    /** The person the agent acts for. */
    userId: string;
    /** `AgentScope`s and per-plugin scopes (`isGrantableScope`). */
    scopes: readonly string[];
}
