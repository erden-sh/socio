import { Navigate, redirect } from 'react-router';

import { SETTINGS_HOME } from './sections';

/**
 * `/settings`, the old Settings dialog's address (CB-18): it opens the
 * first settings page. The server redirects a page load; the component
 * covers a client navigation that skipped the loader.
 */
export const loader = () => redirect(SETTINGS_HOME);

export default function SettingsIndex() {
    return <Navigate to={SETTINGS_HOME} replace />;
}
