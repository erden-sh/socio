import { Settings2 } from 'lucide-react';

import { MODULE_IDS } from '@socio/shared/modules';

import type { ClientModule } from '../types';

import { PausedWidget } from './PausedWidget';
import { SETTINGS_HOME } from './sections';

/** Settings & setup: the settings pages under `/settings` (CB-95). */
export const settingsModule: ClientModule = {
    id: MODULE_IDS.settings,
    title: 'Settings',
    navLabel: 'Settings & setup',
    description: 'Workspace settings, the model and setup status.',
    icon: Settings2,
    tone: 'slate',
    order: 90,
    opens: { path: SETTINGS_HOME },
    sidebar: 'settings',
    slots: { 'home.widgets': [PausedWidget] },
};
