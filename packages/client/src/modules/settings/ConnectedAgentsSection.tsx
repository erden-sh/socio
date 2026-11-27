import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { AgentGrantView } from '@socio/shared/agent-grants';

import { ConfirmDelete } from '../../components/confirm-delete';
import { scopeLabel } from '../../lib/agent-scopes';
import { api } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/** Where an agent comes from: its domain, or that it is unverified. */
export function AgentOrigin({ grant }: { grant: AgentGrantView }) {
    const { t } = useTranslation(['settings.shared']);
    return grant.clientDomain ? (
        <span className="font-medium">{grant.clientDomain}</span>
    ) : (
        <Badge variant="secondary">{t('settings.shared:agents.unverified')}</Badge>
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
    const { t } = useTranslation(['settings', 'settings.connected-agents']);
    const when = (at: number | null) =>
        at ? t('settings.connected-agents:when', { when: new Date(at) }) : t('settings.connected-agents:never');
    const [grants, setGrants] = useState<AgentGrantView[]>();
    const [revoking, setRevoking] = useState<AgentGrantView>();
    const load = useCallback(
        () =>
            api<{ grants: AgentGrantView[] }>('/agent-grants')
                .then((answer) => setGrants(answer.grants))
                .catch((e) => failed(e, t('settings.connected-agents:loadFailed'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    return (
        <section className="grid gap-2" data-slot="connected-agents">
            <h3 className="font-medium">{t('settings:sections.connected-agents')}</h3>
            <p className="text-muted-foreground">
                <Trans
                    t={t}
                    i18nKey="settings.connected-agents:intro"
                    values={{
                        // A command to copy, not words.
                        command: `claude mcp add --transport http socio ${globalThis.location?.origin ?? ''}/mcp`,
                    }}
                    components={{ command: <code className="text-xs" /> }}
                />
            </p>
            <ul className="grid gap-2" aria-label={t('settings.connected-agents:listLabel')}>
                {grants?.map((grant) => (
                    <li key={grant.grantId} className="grid gap-1 rounded-md border p-3" data-grant={grant.grantId}>
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{grant.label}</span>
                            <span className="text-muted-foreground">{grant.clientName}</span>
                            <AgentOrigin grant={grant} />
                            <span className="flex-1" />
                            <Button variant="ghost" size="sm" onClick={() => setRevoking(grant)}>
                                {t('settings.connected-agents:disconnect')}
                            </Button>
                        </span>
                        <AgentScopes scopes={grant.scopes} />
                        <span className="text-muted-foreground text-xs">
                            {t('settings.connected-agents:used', {
                                connected: when(grant.createdAt),
                                used: when(grant.lastUsedAt),
                            })}
                        </span>
                    </li>
                ))}
                {grants?.length === 0 && (
                    <li className="text-muted-foreground">{t('settings.connected-agents:none')}</li>
                )}
            </ul>
            {revoking && (
                <ConfirmDelete
                    title={t('settings.connected-agents:confirmTitle', { agent: revoking.label })}
                    action={t('settings.connected-agents:disconnect')}
                    slot="confirm-disconnect-agent"
                    onClose={() => setRevoking(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(`/agent-grants/${encodeURIComponent(revoking.grantId)}`, 'DELETE');
                            toast.success(t('settings.connected-agents:disconnected', { agent: revoking.label }));
                            await load();
                        } catch (e) {
                            failed(e, t('settings.connected-agents:disconnectFailed'));
                        }
                        setRevoking(undefined);
                    }}
                >
                    {t('settings.connected-agents:confirmBody')}
                </ConfirmDelete>
            )}
        </section>
    );
}
