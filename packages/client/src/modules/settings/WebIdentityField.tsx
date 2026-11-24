import { useEffect, useState } from 'react';

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
    if (!status || choice === undefined) {
        return null;
    }
    return (
        <DialogFieldset legend="Web identity">
            <label
                className="mt-[23px] mb-2 block text-[11px] font-medium text-muted-foreground"
                htmlFor="web-identity"
            >
                How this socio reads websites
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
                    Workspace default ({status.defaultIdentity === 'agent' ? 'declared agent' : 'browser'})
                </option>
                <option value="agent">Declared agent (http_get, http_json)</option>
                <option value="browser">Browser (the socio’s computer)</option>
            </select>
            <p className="text-[11px] leading-[1.7] text-muted-foreground" id="web-identity-help">
                As a declared agent it says so in its User-Agent (<code>{status.userAgent}</code>), which links the
                public /agents page. As a browser it uses its computer’s browser tools. Neither identifies the user. At
                most {status.limits.perHostPerMinute} reads a minute per site; a site that refuses is left alone for a
                while.
            </p>
        </DialogFieldset>
    );
}
