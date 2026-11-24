import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

import { CALENDAR_PLUGIN_ID } from '@socio/shared/calendar';

/**
 * Pages of the plugins this build ships to run inside Socio (`mode:
 * 'bundled'`), by plugin id. Each is its own chunk, loaded only when a
 * person opens an installed one; the server decides who may.
 */
export const bundledPluginPages: Record<string, LazyExoticComponent<ComponentType>> = {
    [CALENDAR_PLUGIN_ID]: lazy(() =>
        import('./calendar/CalendarPage').then((module) => ({
            default: module.CalendarPage,
        })),
    ),
};
