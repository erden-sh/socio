import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { SocioGrantView, SocioGrantsState } from '@socio/shared/socio-access';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';
import { EndGrantDialog, GrantItem } from '../settings/SocioAccessSection';

/**
 * Operations → Socio access (CB-232): every live grant a person
 * gave a socio to use an app for them, and End access. Admins can end any
 * grant, never approve one for someone else (CB-232). Other people's chat
 * titles stay theirs: only rooms are named.
 */
export function SocioAccessPage() {
    const { t } = useTranslation(['operations.socio-access']);
    const [grants, setGrants] = useState<SocioGrantView[]>();
    const [ending, setEnding] = useState<SocioGrantView>();
    const [error, setError] = useState('');
    const load = useCallback(
        () =>
            api<SocioGrantsState>('/actors/admin/grants')
                .then((answer) => {
                    setGrants(answer.grants);
                    setError('');
                })
                .catch((e) => setError(e instanceof Error ? e.message : t('operations.socio-access:load-failed'))),
        [t],
    );
    useEffect(() => void load(), [load]);
    return (
        <SettingsCard>
            <section className="grid min-w-0 gap-3" data-slot="ops-socio-access">
                <p className="m-0 text-muted-foreground">{t('operations.socio-access:intro')}</p>
                {error && (
                    <p role="alert" className="m-0 text-destructive">
                        {error}
                    </p>
                )}
                <ul className="grid min-w-0 gap-2" aria-label={t('operations.socio-access:list')}>
                    {grants?.map((grant) => (
                        <GrantItem key={grant.id} grant={grant} admin onEnd={setEnding} />
                    ))}
                    {grants && !grants.length && (
                        <li className="text-muted-foreground">{t('operations.socio-access:empty')}</li>
                    )}
                </ul>
            </section>
            {ending && (
                <EndGrantDialog
                    grant={ending}
                    onClose={() => setEnding(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(`/actors/admin/grants/${encodeURIComponent(ending.id)}`, 'DELETE');
                            toast.success(t('operations.socio-access:ended'));
                            await load();
                        } catch (e) {
                            toast.error(e instanceof Error ? e.message : t('operations.socio-access:end-failed'));
                        }
                        setEnding(undefined);
                    }}
                />
            )}
        </SettingsCard>
    );
}
