import { useState } from 'react';

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
 * identity go; rows it stored in Socio and its datasets stay.
 */
export function UninstallPluginDialog({
    plugin,
    onClose,
    onConfirm,
}: {
    plugin: Pick<InstalledRow, 'name' | 'mode'>;
    onClose: () => void;
    onConfirm: () => Promise<void>;
}) {
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
                    <DialogTitle>Uninstall {plugin.name}?</DialogTitle>
                    <DialogDescription>
                        {bundled
                            ? 'It is removed from this instance and nobody can open it. '
                            : 'Its service stops and is removed, with its volumes and its identity. '}
                        The rows it saved stay, and so do its datasets, the workspace’s: installing it again offers them
                        back.
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
                            Type <strong className="select-all">{plugin.name}</strong> to confirm
                        </span>
                        <Input
                            aria-label="Plugin name"
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            autoFocus
                        />
                    </label>
                    {typed && !matches && (
                        <span className="text-xs text-muted-foreground" data-slot="uninstall-name-mismatch">
                            Type it exactly as shown.
                        </span>
                    )}
                </form>
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        Keep it
                    </Button>
                    <Button variant="destructive" disabled={busy || !matches} onClick={() => void confirm()}>
                        {busy ? 'Uninstalling…' : 'Uninstall'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
