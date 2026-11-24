import { layout, route } from '@react-router/dev/routes';

export default layout('modules/settings/gate.route.tsx', { id: 'module:settings' }, [
    route('settings', 'modules/settings/SettingsPage.route.tsx', {
        id: 'settings',
    }),
    route('settings/:section', 'modules/settings/SettingsSection.route.tsx', {
        id: 'settings:section',
    }),
    // A person's page under People (CB-360).
    route('settings/people/:id', 'modules/settings/people/PersonPage.route.tsx', {
        id: 'settings:person',
    }),
]);
