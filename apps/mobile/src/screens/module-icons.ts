import type { ModuleIconName } from '../shell/modules';
import type { SymbolName } from '../ui/symbols';

// The module table's icons (src/shell/modules.ts): the web names each by its
// lucide export, and the app by its own name for it (src/ui/symbols.ts: its SF
// Symbol on iOS, lucide's icon on Android). tests/shell/module-table.test.ts
// checks that each name the table uses maps to its lucide file's name.
export const MODULE_ICONS: Readonly<Record<ModuleIconName, SymbolName>> = {
    AppWindow: 'app-window',
    BookOpen: 'book-open',
    Bot: 'bot',
    CalendarClock: 'calendar-clock',
    Clock3: 'clock-3',
    Database: 'database',
    Folder: 'folder',
    Gauge: 'gauge',
    GraduationCap: 'graduation-cap',
    History: 'history',
    Images: 'images',
    ListTodo: 'list-todo',
    MessageCircle: 'message-circle',
    MessageCircleQuestion: 'message-circle-question',
    PlugZap: 'plug-zap',
    Puzzle: 'puzzle',
    Send: 'send',
    ServerCog: 'server-cog',
    Settings2: 'settings-2',
    ShieldCheck: 'shield-check',
};
