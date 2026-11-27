import { Smartphone, X } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { renderSVG } from 'uqr';

import { useTranslation } from '@socio/i18n/react';

import { onDemand, useOnDemand } from '../i18n/on-demand';
import { api } from '../lib/api';

import { SignInSetup } from './current-user';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The workspace's link for the Socio app (CB-352, WB): `…/w/<host>`, which
 * fills in the workspace and signs nobody in. None where the workspace
 * doesn't send app links. Asked once per page, and only with real
 * accounts (the mock sign-in has no such route).
 */
let asked: Promise<string | null> | undefined;
export const forgetAppLink = () => {
    asked = undefined;
};
export function appLink() {
    asked ??= api<{ url: string | null }>('/auth/device/app-link')
        .then(({ url }) => (url && !new URL(url).hash ? url : null))
        .catch(() => null);
    return asked;
}
export function useAppLink() {
    const accounts = !!useContext(SignInSetup);
    const [link, setLink] = useState<string | null>(null);
    useEffect(() => {
        if (!accounts) {
            return;
        }
        let live = true;
        void appLink().then((found) => live && setLink(found));
        return () => {
            live = false;
        };
    }, [accounts]);
    return link;
}

/** A phone's browser: the banner's audience. */
export const onPhone = (userAgent: string) => /iPhone|iPod|Android.+Mobile/i.test(userAgent);

/**
 * "Get the app": the workspace's QR code, to show a colleague. Their
 * phone's camera opens the Socio app with this workspace filled in; they
 * sign in their own way. It carries no code, so it never signs anyone in
 * as you.
 */
export const GetTheAppDialog = onDemand(
    ['shell.help'],
    function GetTheAppDialog({ link, onClose }: { link: string; onClose: () => void }) {
        const { t } = useTranslation(['shell.help']);
        const image = `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}`;
        return (
            <Dialog open onOpenChange={(open) => !open && onClose()}>
                <DialogContent data-slot="get-the-app" className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('shell.help:get-the-app.title')}</DialogTitle>
                        <DialogDescription>{t('shell.help:get-the-app.description')}</DialogDescription>
                    </DialogHeader>
                    <div className="grid justify-items-center gap-2">
                        <img
                            src={image}
                            alt={t('shell.help:get-the-app.code')}
                            className="size-56 rounded-md border bg-white p-2"
                            data-slot="get-the-app-code"
                        />
                        <a href={link} className="text-xs break-all text-muted-foreground" data-slot="get-the-app-link">
                            {link}
                        </a>
                    </div>
                </DialogContent>
            </Dialog>
        );
    },
);

const DISMISSED_KEY = 'socio-get-the-app-banner';

/** Whether the banner was put away; storage a browser blocks counts as not. */
const dismissed = () => {
    try {
        return !!localStorage.getItem(DISMISSED_KEY);
    } catch {
        return false;
    }
};
/** Remembers it was put away, where the browser lets it (else for this page only). */
const dismiss = () => {
    try {
        localStorage.setItem(DISMISSED_KEY, 'dismissed');
    } catch {
        // Blocked or full storage: put away for now.
    }
};

/** On a phone's browser: a banner offering the app, until dismissed. */
export function GetTheAppBanner() {
    const { t } = useTranslation(['shell.help']);
    const ready = useOnDemand(['shell.help']);
    const link = useAppLink();
    const [show, setShow] = useState(false);
    useEffect(() => {
        setShow(onPhone(navigator.userAgent) && !dismissed());
    }, []);
    if (!link || !show || !ready) {
        return null;
    }
    return (
        <div
            className="flex items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
            data-slot="get-the-app-banner"
            role="region"
            aria-label={t('shell.help:get-the-app.title')}
        >
            <Smartphone className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{t('shell.help:get-the-app.banner')}</span>
            <Button asChild size="sm">
                <a href={link}>{t('shell.help:get-the-app.get')}</a>
            </Button>
            <Button
                variant="ghost"
                size="icon"
                aria-label={t('shell.help:get-the-app.not-now')}
                onClick={() => {
                    dismiss();
                    setShow(false);
                }}
            >
                <X />
            </Button>
        </div>
    );
}
