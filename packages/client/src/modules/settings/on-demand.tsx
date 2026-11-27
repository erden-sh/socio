import type { ComponentType } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { useHydrated } from '../../lib/client-only';

type Namespaces = Parameters<typeof useTranslation>[0];

/**
 * `Component`, once its namespaces are in: for words no route inlines
 * (route-namespaces.json), so a page's inlined dictionaries stay within
 * the budget. Dialogs opened by a click, and cards below the fold, load
 * theirs from this server when they mount and render nothing until then
 * (docs/I18N.md). Nothing on the server or while the page hydrates either:
 * the server's instance has no backend, so it would call a missing
 * namespace ready and render its keys, which the browser (still loading
 * it) wouldn't match.
 */
export function onDemand<P extends object>(namespaces: Namespaces, Component: ComponentType<P>) {
    function OnDemand(props: P) {
        const { ready } = useTranslation(namespaces);
        const hydrated = useHydrated();
        return hydrated && ready ? <Component {...props} /> : null;
    }
    OnDemand.displayName = `OnDemand(${Component.displayName ?? Component.name})`;
    return OnDemand;
}
