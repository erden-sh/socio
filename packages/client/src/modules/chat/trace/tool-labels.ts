import {
    AppWindow,
    BookOpen,
    CalendarClock,
    ChartColumn,
    CircleDot,
    Copy,
    Database,
    FileCheck,
    FileCode,
    FilePen,
    FilePlus,
    FileText,
    FileUp,
    Files,
    FolderInput,
    FolderOpen,
    FolderPlus,
    Globe,
    Keyboard,
    KeyRound,
    Library,
    Lightbulb,
    ListChecks,
    MessageSquare,
    Monitor,
    MousePointerClick,
    Paperclip,
    Play,
    ScrollText,
    Search,
    SquarePen,
    Table,
    Target,
    Terminal,
    ThumbsUp,
    Wrench,
    type LucideIcon,
} from 'lucide-react';

import { toolLabel as labelOf, type Args, type ToolIcon } from '@socio/shared/runs/tool-labels';

export type { Args };

/** Shared's icon names as lucide-react's icons. */
const ICONS: Record<ToolIcon, LucideIcon> = {
    'app-window': AppWindow,
    'book-open': BookOpen,
    'calendar-clock': CalendarClock,
    'chart-column': ChartColumn,
    'circle-dot': CircleDot,
    copy: Copy,
    database: Database,
    'file-check': FileCheck,
    'file-code': FileCode,
    'file-pen': FilePen,
    'file-plus': FilePlus,
    'file-text': FileText,
    'file-up': FileUp,
    files: Files,
    'folder-input': FolderInput,
    'folder-open': FolderOpen,
    'folder-plus': FolderPlus,
    globe: Globe,
    'key-round': KeyRound,
    keyboard: Keyboard,
    library: Library,
    lightbulb: Lightbulb,
    'list-checks': ListChecks,
    'message-square': MessageSquare,
    monitor: Monitor,
    'mouse-pointer-click': MousePointerClick,
    paperclip: Paperclip,
    play: Play,
    'scroll-text': ScrollText,
    search: Search,
    'square-pen': SquarePen,
    table: Table,
    target: Target,
    terminal: Terminal,
    'thumbs-up': ThumbsUp,
    wrench: Wrench,
};

/**
 * A step's icon and sentence (shared's label, CB-72), split as it shows:
 * the verb, then what it acted on (muted). `done` picks the past tense.
 */
export function toolLabel(
    name: string,
    args: Args,
    result: Args,
    done: boolean,
): { icon: LucideIcon; verb: string; detail?: string; code?: boolean } {
    const label = labelOf(name, args, result, done);
    return { ...label, icon: ICONS[label.icon] };
}
