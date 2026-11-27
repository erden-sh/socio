import type { ComponentType } from 'react';

import { useTranslation } from '@socio/i18n/react';

type Namespaces = Parameters<typeof useTranslation>[0];

/**
 * `Component`, once its namespaces are in: for words no route inlines
 * (route-namespaces.json), so a page's inlined dictionaries stay within
 * the budget. Dialogs opened by a click, and cards below the fold, load
 * theirs from this server when they mount and render nothing until then
 * (docs/I18N.md).
 */
export function onDemand<P extends object>(namespaces: Namespaces, Component: ComponentType<P>) {
    function OnDemand(props: P) {
        const { ready } = useTranslation(namespaces);
        return ready ? <Component {...props} /> : null;
    }
    OnDemand.displayName = `OnDemand(${Component.displayName ?? Component.name})`;
    return OnDemand;
}
