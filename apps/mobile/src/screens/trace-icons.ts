import type { TraceIcon } from '../chat/turn-trace';
import type { SymbolName } from '../ui/symbols';

// The trace's icons: shared's tool icons by lucide name
// (@socio/shared/runs/tool-labels) and reasoning's, each from its own
// module so Metro bundles only these. Typed by the name list, so a name shared
// adds fails the typecheck until it is here.
export const TRACE_ICONS: Readonly<Record<TraceIcon, SymbolName>> = {
    'app-window': 'app-window',
    'book-open': 'book-open',
    'calendar-clock': 'calendar-clock',
    'chart-column': 'chart-column',
    'circle-dot': 'circle-dot',
    copy: 'copy',
    database: 'database',
    'file-check': 'file-check',
    'file-code': 'file-code',
    'file-pen': 'file-pen',
    'file-plus': 'file-plus',
    'file-text': 'file-text',
    'file-up': 'file-up',
    files: 'files',
    'folder-input': 'folder-input',
    'folder-open': 'folder-open',
    'folder-plus': 'folder-plus',
    globe: 'globe',
    'key-round': 'key-round',
    keyboard: 'keyboard',
    library: 'library',
    lightbulb: 'lightbulb',
    'list-checks': 'list-checks',
    'message-square': 'message-square',
    monitor: 'monitor',
    'mouse-pointer-click': 'mouse-pointer-click',
    paperclip: 'paperclip',
    play: 'play',
    'scroll-text': 'scroll-text',
    search: 'search',
    'square-pen': 'square-pen',
    table: 'table',
    target: 'target',
    terminal: 'terminal',
    'thumbs-up': 'thumbs-up',
    wrench: 'wrench',
    brain: 'brain',
    'loader-circle': 'loader-circle',
};
