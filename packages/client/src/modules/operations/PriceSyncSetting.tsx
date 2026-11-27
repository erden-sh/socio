import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { PriceSyncView, PricingView } from '@socio/shared/operations/operations-cost';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

/**
 * Operations → Settings → Price sync (CB-195): one switch, an admin's
 * choice over the server's (`OPS_PRICE_SYNC`: on in production images).
 * Off, Socio reads no price list at all: for offline installs. Changes
 * are written to the workspace audit.
 */
export function PriceSyncSetting() {
    const { t } = useTranslation(['operations.settings', 'operations']);
    const [sync, setSync] = useState<PriceSyncView>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<PricingView>('/operations/pricing', 'GET', undefined, controller.signal)
            .then((view) => !controller.signal.aborted && setSync(view.sync))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : t('operations:load-failed'));
                }
            });
        return () => controller.abort();
    }, [t]);
    const save = async (enabled: boolean | null) => {
        setBusy(true);
        setError('');
        try {
            setSync(
                await api<PriceSyncView>('/operations/pricing/sync', 'PUT', {
                    enabled,
                }),
            );
            toast.success(t('operations.settings:saved'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.settings:save-failed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsCard>
            <div className="grid gap-4" data-slot="ops-price-sync-setting">
                <div className="grid gap-1">
                    <h3 className="font-medium">{t('operations.settings:price-sync.title')}</h3>
                    <p className="text-muted-foreground">
                        {t('operations.settings:price-sync.description', {
                            state: t('operations.settings:price-sync.state', {
                                context: sync ? (sync.serverDefault ? 'on' : 'off') : undefined,
                            }),
                        })}
                    </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                    {/* Not disabled while saving: that would take the keyboard's focus. */}
                    <Switch
                        checked={sync?.enabled ?? false}
                        disabled={!sync}
                        aria-busy={busy}
                        onCheckedChange={(checked) => {
                            if (!busy) {
                                void save(checked);
                            }
                        }}
                    />
                    {t('operations.settings:price-sync.switch')}
                </label>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                {sync?.saved && (
                    <div>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            {t('operations.settings:price-sync.reset', {
                                state: t('operations.settings:price-sync.state', {
                                    context: sync.serverDefault ? 'on' : 'off',
                                }),
                            })}
                        </Button>
                    </div>
                )}
            </div>
        </SettingsCard>
    );
}
