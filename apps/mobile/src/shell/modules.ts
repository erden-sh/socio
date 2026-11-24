import { MODULE_IDS, type ModuleId } from '@socio/shared/modules';

import type { ToneName } from '../theme/theme';

// The web's modules as the app names and draws them: each client module's
// title, its title for members, its label in the navigation, its lucide icon
// and its tone (packages/client/src/modules/*/ module.ts*), in the web's order.
// The app has no module registry of its own: it draws the web's identity, and
// tests/shell/module-table.test.ts reads every module file as text and fails
// when this table drifts from them, or names an icon lucide-react-native
// doesn't have. The icons' components are in src/screens/module-icons.ts; no
// React Native here.

/** A lucide icon, by its export's name (`ListTodo`). */
export type ModuleIconName =
    | 'AppWindow'
    | 'BookOpen'
    | 'Bot'
    | 'CalendarClock'
    | 'Clock3'
    | 'Database'
    | 'Folder'
    | 'Gauge'
    | 'GraduationCap'
    | 'History'
    | 'Images'
    | 'ListTodo'
    | 'MessageCircle'
    | 'MessageCircleQuestion'
    | 'PlugZap'
    | 'Puzzle'
    | 'Send'
    | 'ServerCog'
    | 'Settings2'
    | 'ShieldCheck';

export interface ModuleEntry {
    readonly id: ModuleId;
    readonly title: string;
    /** Its title for members, where it differs (Learning is Skills). */
    readonly memberTitle?: string;
    /** Its label in the navigation, where it differs from the title. */
    readonly navLabel?: string;
    readonly icon: ModuleIconName;
    /** One of the web's tones (shell/tones.ts), which theme.json carries. */
    readonly tone: ToneName;
}

export const MODULES: readonly ModuleEntry[] = [
    { id: MODULE_IDS.chat, title: 'Chat', icon: 'MessageCircle', tone: 'mint' },
    { id: MODULE_IDS.spaces, title: 'Spaces', icon: 'Folder', tone: 'sky' },
    { id: MODULE_IDS.activity, title: 'Activity', navLabel: 'Scheduled & activity', icon: 'Clock3', tone: 'amber' },
    { id: MODULE_IDS.memories, title: 'Memories', icon: 'BookOpen', tone: 'violet' },
    { id: MODULE_IDS.data, title: 'Data', icon: 'Database', tone: 'emerald' },
    { id: MODULE_IDS.approvals, title: 'Approvals', icon: 'ShieldCheck', tone: 'amber' },
    { id: MODULE_IDS.media, title: 'Media', icon: 'Images', tone: 'sky' },
    { id: MODULE_IDS.apps, title: 'Apps', icon: 'AppWindow', tone: 'violet' },
    {
        id: MODULE_IDS.schedules,
        title: 'Schedules & jobs',
        navLabel: 'Schedules',
        icon: 'CalendarClock',
        tone: 'violet',
    },
    { id: MODULE_IDS.plugins, title: 'Plugins', icon: 'Puzzle', tone: 'violet' },
    { id: MODULE_IDS.learning, title: 'Learning', memberTitle: 'Skills', icon: 'GraduationCap', tone: 'emerald' },
    { id: MODULE_IDS.issues, title: 'Issues', icon: 'ListTodo', tone: 'orange' },
    { id: MODULE_IDS.runs, title: 'Runs', icon: 'History', tone: 'slate' },
    { id: MODULE_IDS.dots, title: 'Socios', icon: 'Bot', tone: 'indigo' },
    { id: MODULE_IDS.connectedAgents, title: 'Connected agents', icon: 'PlugZap', tone: 'slate' },
    { id: MODULE_IDS.telegram, title: 'Telegram', icon: 'Send', tone: 'sky' },
    { id: MODULE_IDS.settings, title: 'Settings', navLabel: 'Settings & setup', icon: 'Settings2', tone: 'slate' },
    { id: MODULE_IDS.operations, title: 'Operations', icon: 'Gauge', tone: 'sky' },
    { id: MODULE_IDS.operator, title: 'Platform', icon: 'ServerCog', tone: 'indigo' },
    { id: MODULE_IDS.ask, title: 'Ask a socio', icon: 'MessageCircleQuestion', tone: 'mint' },
    { id: MODULE_IDS.help, title: 'Help', icon: 'BookOpen', tone: 'sky' },
];

/** A module's entry. Throws for an id the table doesn't have. */
export function moduleEntry(id: ModuleId): ModuleEntry {
    const entry = MODULES.find((module) => module.id === id);
    if (entry === undefined) {
        throw new Error(`No module ${id} in the table.`);
    }
    return entry;
}

/** What a person sees a module called: its member title for members, else its title. */
export const moduleTitle = (entry: ModuleEntry, admin: boolean) =>
    admin ? entry.title : (entry.memberTitle ?? entry.title);

/** Its label in the navigation. */
export const moduleNavLabel = (entry: ModuleEntry, admin: boolean) => entry.navLabel ?? moduleTitle(entry, admin);
