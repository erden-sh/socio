import { Navigate, redirect, useParams, type LoaderFunctionArgs } from 'react-router';

import { routeI18n } from '../../i18n/page-i18n';
import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { SETTINGS_CRUMB, sectionCrumb } from './crumbs';
import { allowed, findSection, movedSection, SETTINGS_HOME, settingsAccess } from './sections';
import { SettingsLayout, useSettingsAccess } from './SettingsLayout';
import { SettingsSection } from './SettingsSection';

export const handle: RouteHandle = {
    crumb: ({ params }) => [
        { label: SETTINGS_CRUMB, to: '/settings' },
        { label: sectionCrumb(findSection(params.section)?.item.id) },
    ],
};

/**
 * `/settings/:section`: an unknown section, or one this person may not
 * open (People is admins'), goes to the first page; an old section's
 * address (Service accounts) to where it moved. Its page's namespaces
 * (route-namespaces.json, `settings:section:<section>`) come inlined
 * with it.
 */
export async function loader({ params, context }: LoaderFunctionArgs) {
    const moved = movedSection(params.section);
    const found = findSection(moved?.section ?? params.section);
    if (!found) {
        throw redirect(SETTINGS_HOME);
    }
    const { services } = web(context);
    // Each page inlines its own namespaces (route-namespaces.json).
    const i18n = await routeI18n(context, `settings:section:${found.item.id}`);
    if (!(await services.user())) {
        return { i18n };
    }
    const workspace = await services.workspace();
    if (workspace && !allowed(found.item, settingsAccess(workspace, false))) {
        throw redirect(SETTINGS_HOME);
    }
    if (moved) {
        throw redirect(moved.to);
    }
    return { i18n };
}
export const shouldRevalidate = revalidateOn({ params: ['section'] });

export default function SettingsSectionRoute() {
    const { section } = useParams();
    const access = useSettingsAccess();
    const moved = movedSection(section);
    const found = findSection(moved?.section ?? section);
    // A role change between polls, or a client navigation.
    if (!found || !allowed(found.item, access)) {
        return <Navigate to={SETTINGS_HOME} replace />;
    }
    if (moved) {
        return <Navigate to={moved.to} replace />;
    }
    return (
        <SettingsLayout group={found.group}>
            <SettingsSection id={found.item.id} access={access} />
        </SettingsLayout>
    );
}
