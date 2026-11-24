import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AgentGrantView } from '@socio/shared/agent-grants';

import { ConfirmDelete } from '../../components/confirm-delete';
import { scopeLabel } from '../../lib/agent-scopes';
import { api } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const when = (at: number | null) =>
    at
        ? new Date(at).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
          })
        : 'never';

/** Where an agent comes from: its domain, or that it is unverified. */
export function AgentOrigin({ grant }: { grant: AgentGrantView }) {
    return grant.clientDomain ? (
        <span className="font-medium">{grant.clientDomain}</span>
    ) : (
        <Badge variant="secondary">Unverified local app</Badge>
    );
}

/** The scopes as short words, with the plain explanation as a tooltip. */
export function AgentScopes({ scopes }: { scopes: readonly string[] }) {
    return (
        <span className="flex flex-wrap gap-1">
            {scopes.map((scope) => (
                <Badge key={scope} variant="outline" title={scopeLabel(scope)}>
                    {scope}
                </Badge>
            ))}
        </span>
    );
}

/**
 * Account → Connected agents (CB-90): the external agents (Claude Code,
 * Cursor, …) this person approved to act for them, and Disconnect, which
 * ends an agent's access at once.
 */
export function ConnectedAgentsSection() {
    const [grants, setGrants] = useState<AgentGrantView[]>();
    const [revoking, setRevoking] = useState<AgentGrantView>();
    const load = useCallback(
        () =>
            api<{ grants: AgentGrantView[] }>('/agent-grants')
                .then((answer) => setGrants(answer.grants))
                .catch((e) => failed(e, 'Could not load connected agents.')),
        [],
    );
    useEffect(() => void load(), [load]);
    return (
        <section className="grid gap-2" data-slot="connected-agents">
            <h3 className="font-medium">Connected agents</h3>
            <p className="text-muted-foreground">
                Agents you run elsewhere, such as Claude Code, that act here for you. They can do only what you
                approved, and never more than you can. To connect Claude Code, run{' '}
                <code className="text-xs">
                    claude mcp add --transport http socio {globalThis.location?.origin ?? ''}/mcp
                </code>{' '}
                and approve it in the browser.
            </p>
            <ul className="grid gap-2" aria-label="Your connected agents">
                {grants?.map((grant) => (
                    <li key={grant.grantId} className="grid gap-1 rounded-md border p-3" data-grant={grant.grantId}>
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{grant.label}</span>
                            <span className="text-muted-foreground">{grant.clientName}</span>
                            <AgentOrigin grant={grant} />
                            <span className="flex-1" />
                            <Button variant="ghost" size="sm" onClick={() => setRevoking(grant)}>
                                Disconnect
                            </Button>
                        </span>
                        <AgentScopes scopes={grant.scopes} />
                        <span className="text-muted-foreground text-xs">
                            Connected {when(grant.createdAt)} · last used {when(grant.lastUsedAt)}
                        </span>
                    </li>
                ))}
                {grants?.length === 0 && <li className="text-muted-foreground">No connected agents.</li>}
            </ul>
            {revoking && (
                <ConfirmDelete
                    title={`Disconnect ${revoking.label}?`}
                    action="Disconnect"
                    slot="confirm-disconnect-agent"
                    onClose={() => setRevoking(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(`/agent-grants/${encodeURIComponent(revoking.grantId)}`, 'DELETE');
                            toast.success(`${revoking.label} disconnected`);
                            await load();
                        } catch (e) {
                            failed(e, 'Could not disconnect the agent.');
                        }
                        setRevoking(undefined);
                    }}
                >
                    It can&apos;t act for you any more, from now on. Connect it again to use it.
                </ConfirmDelete>
            )}
        </section>
    );
}
