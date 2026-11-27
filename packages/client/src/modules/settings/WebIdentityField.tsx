import { useEffect, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import type { WebIdentity, WebStatus } from '@socio/shared/web/web-types';

import { api } from '../../lib/api';

import { DialogFieldset, dialogSelect } from '@/components/form-fields';

/** `''` keeps the workspace default (WEB_IDENTITY_DEFAULT). */
export type WebIdentityChoice = WebIdentity | '';

/** Loads a Dot's web identity; `choice` is undefined until it has. */
export function useWebIdentity(dotId?: string) {
    const [status, setStatus] = useState<WebStatus>();
    const [choice, setChoice] = useState<WebIdentityChoice>();
    useEffect(() => {
        if (!dotId) {
            return;
        }
        const controller = new AbortController();
        api<WebStatus>(`/dots/${encodeURIComponent(dotId)}/web`, 'GET', undefined, controller.signal)
            .then((next) => {
                setStatus(next);
                setChoice(next.source === 'dot' ? next.identity : '');
            })
            .catch(() => {});
        return () => controller.abort();
    }, [dotId]);
    const initial = status ? (status.source === 'dot' ? status.identity : '') : undefined;
    return {
        status,
        choice,
        setChoice,
        /** Saves the choice if it changed. */
        save: async () => {
            if (!dotId || choice === undefined || choice === initial) {
                return;
            }
            await api(`/dots/${encodeURIComponent(dotId)}/web`, 'PATCH', {
                identity: choice || null,
            });
        },
    };
}

/** How the Dot appears to websites: a declared agent or a browser. */
export function WebIdentityField({
    status,
    choice,
    onChange,
}: {
    status?: WebStatus;
    choice?: WebIdentityChoice;
    onChange: (choice: WebIdentityChoice) => void;
}) {
    const { t } = useTranslation(['settings.dialogs']);
    if (!status || choice === undefined) {
        return null;
    }
    return (
        <DialogFieldset legend={t('settings.dialogs:web.legend')}>
            <label
                className="mt-[23px] mb-2 block text-[11px] font-medium text-muted-foreground"
                htmlFor="web-identity"
            >
                {t('settings.dialogs:web.label')}
            </label>
            <select
                id="web-identity"
                data-slot="native-select"
                className={dialogSelect}
                value={choice}
                aria-describedby="web-identity-help"
                onChange={(event) => onChange(event.target.value as WebIdentityChoice)}
            >
                <option value="">
                    {t('settings.dialogs:web.default', {
                        context: status.defaultIdentity === 'agent' ? 'agent' : undefined,
                    })}
                </option>
                <option value="agent">{t('settings.dialogs:web.agent')}</option>
                <option value="browser">{t('settings.dialogs:web.browser')}</option>
            </select>
            <p className="text-[11px] leading-[1.7] text-muted-foreground" id="web-identity-help">
                <Trans
                    t={t}
                    i18nKey="settings.dialogs:web.help"
                    count={status.limits.perHostPerMinute}
                    values={{ count: status.limits.perHostPerMinute, userAgent: status.userAgent }}
                    components={{ ua: <code /> }}
                />
            </p>
        </DialogFieldset>
    );
}
