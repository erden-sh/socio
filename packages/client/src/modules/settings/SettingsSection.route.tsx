import { Navigate, redirect, useParams, type LoaderFunctionArgs } from 'react-router';

import { revalidateOn } from '../../lib/page-loader';
import { web } from '../../lib/web-context';
import type { RouteHandle } from '../../shell/shell-context';

import { allowed, findSection, movedSection, SETTINGS_HOME, settingsAccess } from './sections';
import { SettingsLayout, useSettingsAccess } from './SettingsLayout';
import { SettingsSection } from './SettingsSection';

export const handle: RouteHandle = {
    crumb: ({ params }) => [
        { label: 'Settings', to: '/settings' },
        { label: findSection(params.section)?.item.label ?? 'Settings' },
    ],
};

/**
 * `/settings/:section`: an unknown section, or one this person may not
 * open (People is admins'), goes to the first page; an old section's
 * address (Service accounts) to where it moved.
 */
export async function loader({ params, context }: LoaderFunctionArgs) {
    const moved = movedSection(params.section);
    const found = findSection(moved?.section ?? params.section);
    if (!found) {
        throw redirect(SETTINGS_HOME);
    }
    const { services } = web(context);
    if (!(await services.user())) {
        return null;
    }
    const workspace = await services.workspace();
    if (workspace && !allowed(found.item, settingsAccess(workspace, false))) {
        throw redirect(SETTINGS_HOME);
    }
    if (moved) {
        throw redirect(moved.to);
    }
    return null;
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
