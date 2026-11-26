import type { SFSymbol } from 'expo-symbols';

// The app's icons by name (the owner, 2026-11-18: SF Symbols on iOS, in
// rows, menus and buttons as well as the bars and the tab bar): each name, the
// lucide icon's own (`chevron-right`, as the web and the server's trace name
// them), says the SF Symbol iOS draws and, in symbol-glyphs.ts, the lucide
// icon Android's Material components draw. `AppSymbol` (app-symbol.tsx) draws
// either. Where a bar (`symbol`) or a menu (MENU_SYMBOLS) already names a
// symbol for the same thing, this table names the same one, so a screen never
// speaks two icon languages. `sf: null` keeps lucide on iOS too, only for an
// icon SF Symbols 5 (iOS 17.4, the deployment target) lacks: a robot, a
// heading's H1 to H3, a picture that failed. `fill` is the symbol's filled
// form, for a chosen state (a vote cast). No React Native here, so the Node
// tests read it as the app does; tests/ui/symbols.test.ts checks every name
// against SF Symbols 5 and lucide 1.80.0.

export interface SymbolSpec {
    /** The SF Symbol iOS draws; null where SF Symbols has none, and iOS draws the lucide icon. */
    readonly sf: SFSymbol | null;
    /** Its filled form, for a chosen state. */
    readonly fill?: SFSymbol;
}

export const SYMBOLS = {
    'app-window': { sf: 'macwindow' },
    archive: { sf: 'archivebox' },
    'arrow-down': { sf: 'arrow.down' },
    'arrow-left': { sf: 'arrow.left' },
    'arrow-left-right': { sf: 'arrow.left.arrow.right' },
    'arrow-right-left': { sf: 'arrow.right.arrow.left' },
    'arrow-up': { sf: 'arrow.up' },
    'arrow-up-down': { sf: 'arrow.up.arrow.down' },
    'arrow-up-right': { sf: 'arrow.up.right' },
    'at-sign': { sf: 'at' },
    bell: { sf: 'bell' },
    'bell-off': { sf: 'bell.slash' },
    bold: { sf: 'bold' },
    'book-open': { sf: 'book' },
    bot: { sf: null },
    brain: { sf: 'brain' },
    bug: { sf: 'ladybug' },
    'building-2': { sf: 'building.2' },
    calendar: { sf: 'calendar' },
    'calendar-clock': { sf: 'calendar.badge.clock' },
    camera: { sf: 'camera' },
    'chart-column': { sf: 'chart.bar' },
    check: { sf: 'checkmark' },
    'check-check': { sf: 'checkmark.circle' },
    'chevron-down': { sf: 'chevron.down' },
    'chevron-left': { sf: 'chevron.backward' },
    'chevron-right': { sf: 'chevron.forward' },
    'chevron-up': { sf: 'chevron.up' },
    'circle-alert': { sf: 'exclamationmark.circle' },
    'circle-check': { sf: 'checkmark.circle' },
    'circle-dot': { sf: 'record.circle' },
    'circle-help': { sf: 'questionmark.circle' },
    'circle-user-round': { sf: 'person.crop.circle' },
    clock: { sf: 'clock' },
    'clock-3': { sf: 'clock' },
    'cloud-check': { sf: 'checkmark.icloud' },
    'cloud-download': { sf: 'icloud.and.arrow.down' },
    code: { sf: 'chevron.left.forwardslash.chevron.right' },
    'code-xml': { sf: 'chevron.left.forwardslash.chevron.right' },
    compass: { sf: 'safari' },
    copy: { sf: 'doc.on.doc' },
    database: { sf: 'cylinder' },
    'door-open': { sf: 'door.left.hand.open' },
    download: { sf: 'arrow.down.to.line' },
    ellipsis: { sf: 'ellipsis' },
    'external-link': { sf: 'arrow.up.right.square' },
    eye: { sf: 'eye' },
    'eye-off': { sf: 'eye.slash' },
    file: { sf: 'doc' },
    'file-check': { sf: 'checkmark.rectangle' },
    'file-code': { sf: 'curlybraces.square' },
    'file-code-2': { sf: 'curlybraces.square' },
    'file-pen': { sf: 'pencil.and.outline' },
    'file-plus': { sf: 'doc.badge.plus' },
    'file-text': { sf: 'doc.text' },
    'file-up': { sf: 'arrow.up.doc' },
    files: { sf: 'doc.on.doc' },
    flashlight: { sf: 'flashlight.on.fill' },
    'flashlight-off': { sf: 'flashlight.off.fill' },
    'flask-conical': { sf: 'flask' },
    folder: { sf: 'folder' },
    'folder-input': { sf: 'folder' },
    'folder-open': { sf: 'folder' },
    'folder-plus': { sf: 'folder.badge.plus' },
    gauge: { sf: 'gauge.with.dots.needle.33percent' },
    'git-pull-request': { sf: 'arrow.triangle.pull' },
    globe: { sf: 'globe' },
    'graduation-cap': { sf: 'graduationcap' },
    'heading-1': { sf: null },
    'heading-2': { sf: null },
    'heading-3': { sf: null },
    history: { sf: 'clock.arrow.circlepath' },
    hourglass: { sf: 'hourglass' },
    house: { sf: 'house' },
    image: { sf: 'photo' },
    'image-off': { sf: null },
    'image-plus': { sf: 'photo.badge.plus' },
    images: { sf: 'photo.on.rectangle' },
    info: { sf: 'info.circle' },
    italic: { sf: 'italic' },
    kanban: { sf: 'rectangle.split.3x1' },
    'key-round': { sf: 'key' },
    keyboard: { sf: 'keyboard' },
    'layout-grid': { sf: 'square.grid.2x2' },
    library: { sf: 'books.vertical' },
    lightbulb: { sf: 'lightbulb' },
    'link-2': { sf: 'link' },
    list: { sf: 'list.bullet' },
    'list-checks': { sf: 'checklist' },
    'list-filter': { sf: 'line.3.horizontal.decrease' },
    'list-ordered': { sf: 'list.number' },
    'list-todo': { sf: 'checklist' },
    'loader-circle': { sf: 'circle.dotted' },
    lock: { sf: 'lock' },
    'lock-keyhole': { sf: 'lock' },
    'log-in': { sf: 'person.badge.key' },
    'log-out': { sf: 'rectangle.portrait.and.arrow.right' },
    mail: { sf: 'envelope' },
    'message-circle': { sf: 'bubble.left' },
    'message-circle-question': { sf: 'questionmark.bubble' },
    'message-square': { sf: 'text.bubble' },
    'message-square-check': { sf: 'checkmark.bubble' },
    'message-square-more': { sf: 'ellipsis.bubble' },
    'messages-square': { sf: 'bubble.left.and.bubble.right' },
    monitor: { sf: 'desktopcomputer' },
    'mouse-pointer-click': { sf: 'cursorarrow.click' },
    'notebook-pen': { sf: 'note.text' },
    paperclip: { sf: 'paperclip' },
    'pen-line': { sf: 'pencil.line' },
    pencil: { sf: 'pencil' },
    'phone-off': { sf: 'phone.down' },
    pilcrow: { sf: 'paragraphsign' },
    play: { sf: 'play' },
    'plug-zap': { sf: 'powerplug' },
    plus: { sf: 'plus' },
    puzzle: { sf: 'puzzlepiece' },
    'qr-code': { sf: 'qrcode' },
    quote: { sf: 'text.quote' },
    'redo-2': { sf: 'arrow.uturn.forward' },
    'refresh-cw': { sf: 'arrow.clockwise' },
    'rotate-ccw': { sf: 'arrow.counterclockwise' },
    'rotate-cw': { sf: 'arrow.clockwise' },
    'rows-3': { sf: 'rectangle.grid.1x2' },
    'scroll-text': { sf: 'scroll' },
    search: { sf: 'magnifyingglass' },
    send: { sf: 'paperplane' },
    'server-cog': { sf: 'server.rack' },
    settings: { sf: 'gearshape' },
    'settings-2': { sf: 'gearshape' },
    share: { sf: 'square.and.arrow.up' },
    'shield-alert': { sf: 'exclamationmark.shield' },
    'shield-check': { sf: 'checkmark.shield' },
    'sliders-horizontal': { sf: 'slider.horizontal.3' },
    sparkles: { sf: 'sparkles' },
    square: { sf: 'square' },
    'square-pen': { sf: 'square.and.pencil' },
    stethoscope: { sf: 'stethoscope' },
    strikethrough: { sf: 'strikethrough' },
    table: { sf: 'tablecells' },
    target: { sf: 'target' },
    terminal: { sf: 'terminal' },
    'thumbs-down': { sf: 'hand.thumbsdown', fill: 'hand.thumbsdown.fill' },
    'thumbs-up': { sf: 'hand.thumbsup', fill: 'hand.thumbsup.fill' },
    'trash-2': { sf: 'trash' },
    'triangle-alert': { sf: 'exclamationmark.triangle' },
    type: { sf: 'textformat' },
    'undo-2': { sf: 'arrow.uturn.backward' },
    'user-round': { sf: 'person' },
    users: { sf: 'person.2' },
    wrench: { sf: 'wrench.adjustable' },
    x: { sf: 'xmark' },
} as const satisfies Readonly<Record<string, SymbolSpec>>;

export type SymbolName = keyof typeof SYMBOLS;

/** The SF Symbol iOS draws for a name (its filled form when `filled` and it has one), or null for lucide's. */
export function sfSymbolOf(name: SymbolName, filled = false): SFSymbol | null {
    const spec: SymbolSpec = SYMBOLS[name];
    return filled && spec.fill !== undefined ? spec.fill : spec.sf;
}

/**
 * An SF Symbol's weight beside text (the HIG: a symbol takes the weight of the
 * text next to it). A row's title (the Headline) and a button's words are
 * semibold; the Body and the lines under it are regular.
 */
export type SymbolWeight = 'regular' | 'medium' | 'semibold' | 'bold';
