import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { MODULE_IDS } from '@socio/shared/modules';
import type { PluginLauncherEntry } from '@socio/shared/plugins/plugins';

import { api } from '../../lib/api';
import { WorkspacePage } from '../../views/WorkspacePage';

import { Button } from '@/components/ui/button';

/**
 * `/plugins/:id` for a tab plugin (it was `/plugins/:id/open` until
 * CB-446): the launch URL opens in a new tab. Replacing this page's
 * location would nest Socio inside an embed, so this page never navigates
 * itself to the apps host.
 */
export function PluginOpen({ plugin }: { plugin: PluginLauncherEntry }) {
    const { t } = useTranslation(['plugins.frame']);
    const [error, setError] = useState<string>();
    const [opened, setOpened] = useState(false);
    const launched = useRef<string | undefined>(undefined);
    const open = useCallback(
        (id: string, next: string) => {
            api<{ url: string }>(`/plugins/${id}/launch`, 'POST', { next })
                .then((body) => {
                    const tab = window.open(body.url, '_blank', 'noopener,noreferrer');
                    setOpened(true);
                    if (!tab) {
                        setError(t('plugins.frame:open.blocked'));
                    }
                })
                .catch((reason) => setError(reason instanceof Error ? reason.message : t('plugins.frame:open.failed')));
        },
        [t],
    );
    useEffect(() => {
        if (launched.current === plugin.id) {
            return;
        }
        launched.current = plugin.id;
        open(plugin.id, plugin.entryPath || '/');
    }, [plugin, open]);
    return (
        <WorkspacePage
            slot="plugin-open"
            module={MODULE_IDS.plugins}
            title={plugin.name}
            description={opened && !error ? t('plugins.frame:open.opened') : error || t('plugins.frame:open.opening')}
        >
            <Button type="button" onClick={() => open(plugin.id, plugin.entryPath || '/')}>
                {t('plugins.frame:open-tab')}
            </Button>
        </WorkspacePage>
    );
}
