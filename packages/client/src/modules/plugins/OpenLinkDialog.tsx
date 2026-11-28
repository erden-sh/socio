import { useEffect, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * How long **Open** stays off after the dialog appears, so a click the
 * person meant for the plugin (which can raise the dialog at any moment)
 * never lands on it.
 */
export const OPEN_LINK_ARM_MS = 500;

/**
 * The workspace's own confirmation before it opens a link a plugin with
 * `bridge.openAnyHttps` asked for, outside its `bridge.open` list. The host
 * draws it, outside the plugin's frame, so the frame can neither draw nor
 * press it. It names the full destination host (as the URL parser writes
 * it, so an international name shows as `xn--…`), the plugin, and the
 * whole link. Cancel has the focus; **Open** opens the tab with
 * `noopener,noreferrer`.
 */
export function OpenLinkDialog({
    url,
    pluginName,
    onOpen,
    onCancel,
}: {
    url: string;
    pluginName: string;
    onOpen: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation(['plugins.frame']);
    const host = new URL(url).host;
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        setArmed(false);
        const timer = window.setTimeout(() => setArmed(true), OPEN_LINK_ARM_MS);
        return () => window.clearTimeout(timer);
    }, [url]);
    return (
        <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
            <AlertDialogContent data-slot="plugin-open-link">
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        <Trans
                            t={t}
                            i18nKey="plugins.frame:link.title"
                            values={{ host }}
                            components={{ host: <span data-slot="plugin-open-link-host" /> }}
                        />
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {t('plugins.frame:link.description', { plugin: pluginName, host })}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <p
                    className="max-h-24 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
                    data-slot="plugin-open-link-url"
                >
                    {url}
                </p>
                <AlertDialogFooter>
                    <AlertDialogCancel data-slot="plugin-open-link-cancel">
                        {t('plugins.frame:link.cancel')}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        disabled={!armed}
                        data-slot="plugin-open-link-open"
                        onClick={() => {
                            if (armed) {
                                onOpen();
                            }
                        }}
                    >
                        {t('plugins.frame:link.open')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
