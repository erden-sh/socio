import { useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';

import { onDemand } from '../../i18n/on-demand';

import type { InstalledRow } from './plugin-rows';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

/**
 * Uninstall a plugin only after typing its name exactly (CB-397), as
 * cancelling a schedule and removing a person ask. What it removes and what
 * stays is the server's (docs/PLUGINS.md): the service, its volumes and its
 * identity go; rows it stored in Socio and its datasets stay. Its words
 * load on demand (plugins.dialogs).
 */
function UninstallPlugin({
    plugin,
    onClose,
    onConfirm,
}: {
    plugin: Pick<InstalledRow, 'name' | 'mode'>;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
    const { t } = useTranslation(['plugins.dialogs']);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const matches = typed === plugin.name;
    const bundled = plugin.mode === 'bundled';
    const confirm = async () => {
        if (!matches || busy) {
            return;
        }
        setBusy(true);
        try {
            await onConfirm();
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="plugin-uninstall">
                <DialogHeader>
                    <DialogTitle>{t('plugins.dialogs:uninstall.title', { name: plugin.name })}</DialogTitle>
                    <DialogDescription>
                        {bundled
                            ? t('plugins.dialogs:uninstall.description-bundled')
                            : t('plugins.dialogs:uninstall.description-service')}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-1 text-sm"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void confirm();
                    }}
                >
                    <label className="grid gap-1">
                        <span>
                            <Trans
                                t={t}
                                i18nKey="plugins.dialogs:uninstall.type"
                                values={{ name: plugin.name }}
                                components={{ name: <strong className="select-all" /> }}
                            />
                        </span>
                        <Input
                            aria-label={t('plugins.dialogs:uninstall.name')}
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            autoFocus
                        />
                    </label>
                    {typed && !matches && (
                        <span className="text-xs text-muted-foreground" data-slot="uninstall-name-mismatch">
                            {t('plugins.dialogs:uninstall.mismatch')}
                        </span>
                    )}
                </form>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        {t('plugins.dialogs:uninstall.keep')}
                    </Button>
                    <Button variant="destructive" disabled={busy || !matches} onClick={() => void confirm()}>
                        {busy ? t('plugins.dialogs:uninstall.uninstalling') : t('plugins.dialogs:uninstall.uninstall')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Uninstall (`UninstallPlugin`), once its words are in. */
export const UninstallPluginDialog = onDemand(['plugins.dialogs'], UninstallPlugin);
