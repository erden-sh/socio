import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import type { AgentGrantAdminView, AgentSettingsView } from '@socio/shared/agent-grants';
import { MODULE_IDS } from '@socio/shared/modules';

import { ConfirmDelete } from '../../components/confirm-delete';
import { api } from '../../lib/api';
import { WorkspacePage } from '../../views/WorkspacePage';
import { AgentOrigin, AgentScopes } from '../settings/ConnectedAgentsSection';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const when = (t: number | null) =>
    t
        ? new Date(t).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
          })
        : '—';

/** The allowlist of client domains: off (any domain) until an admin sets it. */
function DomainAllowlist({ settings, onSaved }: { settings: AgentSettingsView; onSaved: () => void }) {
    const [text, setText] = useState((settings.allowedDomains ?? []).join(', '));
    const save = async (allowedDomains: string[] | null) => {
        try {
            await api('/admin/agent-grants/settings', 'PUT', { allowedDomains });
            toast.success(allowedDomains ? 'Allowed domains saved' : 'Any domain is allowed');
            onSaved();
        } catch (e) {
            failed(e, 'Could not save the allowed domains.');
        }
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        const domains = text
            .split(/[\s,]+/)
            .map((domain) => domain.trim())
            .filter(Boolean);
        void save(domains.length ? domains : null);
    };
    const on = settings.allowedDomains !== null;
    return (
        <Card data-slot="agent-allowlist">
            <CardHeader>
                <CardTitle>Allowed client domains</CardTitle>
                <CardDescription>
                    {on
                        ? `Only agents whose metadata comes from these domains (or their subdomains) can connect or act: ${settings.allowedDomains!.join(', ') || 'none'}.`
                        : 'Off: an agent from any domain can ask to connect. Each person still approves it.'}{' '}
                    An unverified local app only claims its domain.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form className="flex flex-wrap gap-2" onSubmit={submit}>
                    <Input
                        aria-label="Allowed client domains"
                        placeholder="claude.ai, cursor.com"
                        className="max-w-md"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <Button type="submit">Save</Button>
                    {on && (
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                                setText('');
                                void save(null);
                            }}
                        >
                            Allow any domain
                        </Button>
                    )}
                </form>
            </CardContent>
        </Card>
    );
}

/**
 * `/admin/agents` (CB-90): every person's connected agents, with what they
 * may do and when they were last used. An admin can disconnect any.
 */
export function AgentsAdminPage() {
    const [data, setData] = useState<{
        grants: AgentGrantAdminView[];
        settings: AgentSettingsView;
    }>();
    const [revoking, setRevoking] = useState<AgentGrantAdminView>();
    const load = useCallback(
        () =>
            api<{ grants: AgentGrantAdminView[]; settings: AgentSettingsView }>('/admin/agent-grants')
                .then(setData)
                .catch((e) => failed(e, 'Could not load the connected agents.')),
        [],
    );
    useEffect(() => void load(), [load]);
    return (
        <WorkspacePage
            slot="admin-agents"
            module={MODULE_IDS.connectedAgents}
            bodyClassName="grid gap-6"
            title="Connected agents"
            description="External agents, such as Claude Code, that people connected to act for them. Each acts as its person, with the scopes they approved, and never beyond that person's role. Disconnecting one ends its access at once."
        >
            {!data ? (
                <Skeleton className="h-32" />
            ) : (
                <>
                    <Table data-slot="admin-agent-list">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Person</TableHead>
                                <TableHead>Agent</TableHead>
                                <TableHead>From</TableHead>
                                <TableHead>Scopes</TableHead>
                                <TableHead>Connected</TableHead>
                                <TableHead>Last used</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data.grants.map((grant) => (
                                <TableRow key={grant.grantId} data-grant={grant.grantId}>
                                    <TableCell>{grant.personName}</TableCell>
                                    <TableCell>
                                        <span className="font-medium">{grant.label}</span>
                                        <span className="text-muted-foreground block text-xs">{grant.clientName}</span>
                                    </TableCell>
                                    <TableCell>
                                        <AgentOrigin grant={grant} />
                                    </TableCell>
                                    <TableCell>
                                        <AgentScopes scopes={grant.scopes} />
                                    </TableCell>
                                    <TableCell>{when(grant.createdAt)}</TableCell>
                                    <TableCell>{when(grant.lastUsedAt)}</TableCell>
                                    <TableCell>
                                        <Button variant="ghost" size="sm" onClick={() => setRevoking(grant)}>
                                            Disconnect
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                            {data.grants.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={7} className="text-muted-foreground">
                                        Nobody has connected an agent.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                    <DomainAllowlist settings={data.settings} onSaved={() => void load()} />
                </>
            )}
            {revoking && (
                <ConfirmDelete
                    title={`Disconnect ${revoking.label}?`}
                    action="Disconnect"
                    slot="confirm-disconnect-agent"
                    onClose={() => setRevoking(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(`/admin/agent-grants/${encodeURIComponent(revoking.grantId)}`, 'DELETE');
                            toast.success(`${revoking.label} disconnected`);
                            await load();
                        } catch (e) {
                            failed(e, 'Could not disconnect the agent.');
                        }
                        setRevoking(undefined);
                    }}
                >
                    It can&apos;t act for {revoking.personName} any more, from now on. They can connect it again.
                </ConfirmDelete>
            )}
        </WorkspacePage>
    );
}
