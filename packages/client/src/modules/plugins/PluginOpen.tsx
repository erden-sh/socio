import { useEffect, useRef, useState } from 'react';

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
    const [error, setError] = useState<string>();
    const [opened, setOpened] = useState(false);
    const launched = useRef<string | undefined>(undefined);
    const open = (id: string, next: string) => {
        api<{ url: string }>(`/plugins/${id}/launch`, 'POST', { next })
            .then((body) => {
                const tab = window.open(body.url, '_blank', 'noopener,noreferrer');
                setOpened(true);
                if (!tab) {
                    setError('The browser blocked the new tab.');
                }
            })
            .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not open the plugin.'));
    };
    useEffect(() => {
        if (launched.current === plugin.id) {
            return;
        }
        launched.current = plugin.id;
        open(plugin.id, plugin.entryPath || '/');
    }, [plugin]);
    return (
        <WorkspacePage
            slot="plugin-open"
            module={MODULE_IDS.plugins}
            title={plugin.name}
            description={
                opened && !error ? 'Opened in a new tab. You can close this page.' : error || 'Opening in a new tab.'
            }
        >
            <Button type="button" onClick={() => open(plugin.id, plugin.entryPath || '/')}>
                Open in a new tab
            </Button>
        </WorkspacePage>
    );
}
