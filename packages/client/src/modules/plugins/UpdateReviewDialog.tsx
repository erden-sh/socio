import { useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import type { PluginUpdateAddition, PluginUpdateReview } from '@socio/shared/plugins/plugin-update';

import { onDemand } from '../../i18n/on-demand';

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
 * review; the page reloads it when the server says it is stale. Its
 * words load on demand (plugins.dialogs).
 */
function UpdateReview({
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
    const { t } = useTranslation(['plugins.dialogs']);
    const additionLabel = useAdditionLabel();
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
                    <DialogTitle>{t('plugins.dialogs:update.title', { name, version: review.version })}</DialogTitle>
                    <DialogDescription>
                        {adds ? t('plugins.dialogs:update.adds') : t('plugins.dialogs:update.adds-nothing')}
                    </DialogDescription>
                </DialogHeader>
                {adds && (
                    <div className="grid gap-1.5">
                        <p className="font-medium">{t('plugins.dialogs:update.additions')}</p>
                        <ul className="grid list-disc gap-1 pl-5" data-slot="plugin-update-additions">
                            {review.additions.map((addition) => (
                                <li key={addition.key} data-key={addition.key}>
                                    {additionLabel(addition)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {review.addsOpenAnyHttps && <OpenAnyHttpsScope />}
                {review.removedSettings.length > 0 && (
                    <div className="grid gap-1.5">
                        <p className="font-medium">{t('plugins.dialogs:update.removed')}</p>
                        <p className="text-muted-foreground">{t('plugins.dialogs:update.removed-intro')}</p>
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
                        {t('plugins.dialogs:update.cancel')}
                    </Button>
                    <Button disabled={busy} onClick={() => void confirm()} data-slot="plugin-update-confirm">
                        {busy ? t('plugins.dialogs:update.updating') : t('plugins.dialogs:update.update')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The update review (`UpdateReview`), once its words are in. */
export const UpdateReviewDialog = onDemand(['plugins.dialogs', 'plugins'], UpdateReview);

/**
 * One addition in plain words, in the reader's language (the server's
 * English is `pluginUpdateAdditionLabel`, which its refusals quote).
 */
function useAdditionLabel() {
    const { t } = useTranslation(['plugins.dialogs']);
    return (addition: PluginUpdateAddition): string => {
        switch (addition.kind) {
            case 'egress':
                return t('plugins.dialogs:additions.egress', { host: addition.host });
            case 'egress-setting':
                return addition.host
                    ? t('plugins.dialogs:additions.egress-setting', { field: addition.field, host: addition.host })
                    : t('plugins.dialogs:additions.egress-setting-any', { field: addition.field });
            case 'permission':
                return t('plugins.dialogs:additions.permission', { permission: addition.permission });
            case 'bridge-open':
                return t('plugins.dialogs:additions.bridge-open', { url: addition.url });
            case 'bridge-open-any-https':
                return t('plugins.dialogs:additions.bridge-open-any-https');
            case 'embed':
                return t('plugins.dialogs:additions.embed');
            case 'action':
                return addition.from
                    ? t('plugins.dialogs:additions.action-changed', {
                          action: addition.action,
                          from: addition.from,
                          tier: addition.tier,
                      })
                    : t('plugins.dialogs:additions.action', { action: addition.action, tier: addition.tier });
            case 'always-ask-dropped':
                return t('plugins.dialogs:additions.always-ask-dropped');
            case 'bridge-routes':
                return t('plugins.dialogs:additions.bridge-routes');
            case 'secret':
                return t('plugins.dialogs:additions.secret', {
                    name: addition.name,
                    context: addition.required ? 'required' : 'optional',
                });
            case 'service-secret':
                return t('plugins.dialogs:additions.service-secret', { name: addition.name });
            case 'dataset':
                return t('plugins.dialogs:additions.dataset', { name: addition.name, context: addition.access });
            case 'dataset-write':
                return t('plugins.dialogs:additions.dataset-write', { name: addition.name });
            case 'webhook':
                return t('plugins.dialogs:additions.webhook', { method: addition.method, path: addition.path });
            case 'webhook-limit':
                return t('plugins.dialogs:additions.webhook-limit', { method: addition.method, path: addition.path });
            case 'public-path':
                return t('plugins.dialogs:additions.public-path', { path: addition.path });
            case 'cpus':
                return t('plugins.dialogs:additions.cpus', { from: addition.from, to: addition.to });
            case 'memory':
                return t('plugins.dialogs:additions.memory', { from: addition.from, to: addition.to });
            case 'volume':
                return t('plugins.dialogs:additions.volume', { name: addition.name });
        }
    };
}
