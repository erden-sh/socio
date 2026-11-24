import { useParams } from 'react-router';

import type { RouteHandle } from '../../shell/shell-context';

import { INSTALLED_PATH } from './plugin-rows';
import { PluginManagePage } from './PluginManagePage';

// An installed plugin's admin page (CB-393): Plugins › Plugin name.
export const handle: RouteHandle = {
    crumb: ({ workspace, params }) => [
        { label: 'Plugins', to: INSTALLED_PATH },
        {
            label: workspace.plugins?.find((item) => item.id === params.pluginId)?.name ?? 'Plugin',
        },
    ],
};

export default function PluginManageRoute() {
    const { pluginId = '' } = useParams();
    // Keyed by id: another plugin's page starts fresh.
    return <PluginManagePage key={pluginId} id={pluginId} />;
}
