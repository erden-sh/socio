import { useState } from 'react';

import { pluginUpdateAdditionLabel, type PluginUpdateReview } from '@socio/shared/plugins/plugin-update';

import { OpenAnyHttpsScope } from './plugin-rows';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Review an update before **Update** adopts it (CB-531): what the new
 * version adds over the installed one, in plain words, and the settings
 * whose stored values it deletes. Confirming acknowledges exactly this
 * review; the page reloads it when the server says it is stale.
 */
export function UpdateReviewDialog({
    name,
    review,
    onClose,
    onConfirm,
}: {
    name: string;
    review: PluginUpdateReview;
    onClose: () => void;
    onConfirm: (review: PluginUpdateReview) => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const confirm = async () => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            await onConfirm(review);
        } finally {
            setBusy(false);
        }
    };
    const adds = review.additions.length > 0;
    return (
        <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <DialogContent data-slot="plugin-update-review">
                <DialogHeader>
                    <DialogTitle>
                        Update {name} to {review.version}?
                    </DialogTitle>
                    <DialogDescription>
                        {adds
                            ? 'This version can do more than the installed one. Review what it adds.'
                            : 'This version adds no access the installed one doesn’t have.'}
                    </DialogDescription>
                </DialogHeader>
                {adds && (
                    <div className="grid gap-1.5">
                        <p className="font-medium">What it adds</p>
                        <ul className="grid list-disc gap-1 pl-5" data-slot="plugin-update-additions">
                            {review.additions.map((addition) => (
                                <li key={addition.key} data-key={addition.key}>
                                    {pluginUpdateAdditionLabel(addition)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {review.addsOpenAnyHttps && <OpenAnyHttpsScope />}
                {review.removedSettings.length > 0 && (
                    <div className="grid gap-1.5">
                        <p className="font-medium">Settings it deletes</p>
                        <p className="text-muted-foreground">
                            The new version no longer has these settings, so their saved values are deleted:
                        </p>
                        <ul className="grid list-disc gap-1 pl-5" data-slot="plugin-update-removed-settings">
                            {review.removedSettings.map((key) => (
                                <li key={key}>
                                    <code>{key}</code>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="ghost" disabled={busy} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button disabled={busy} onClick={() => void confirm()} data-slot="plugin-update-confirm">
                        {busy ? 'Updating…' : 'Update'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
