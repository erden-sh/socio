import type { BundledPlugin } from './bundle-types.js';
import { calendarBundle } from './calendar/bundle.js';
import { socialStrategyBundle } from './planner/bundle.js';

export type { BundledPlugin, PluginContext, PluginToolCall, PluginToolDefinition } from './bundle-types.js';

/** Plugins whose code ships in this build, by id. */
export const bundledPlugins: Record<string, BundledPlugin> = {
    'social-strategy': socialStrategyBundle,
    calendar: calendarBundle,
};
