import { fitName } from '@socio/shared/rooms/room-view';

import { COMPOSER_PLACEHOLDER } from './composer';
import type { MenuAction } from './long-press';

// A private chat's header (the web's ChatHeader in modules/chat/Chat.tsx; the
// PWA comparison's 2.1 and 2.5): the socio's mascot, name and status line
// ("Here with you"), the model picker (model-picker.ts), the web's Save as page
// and Schedule a task as icon buttons after it, and the "…" menu with both too. The composer names the socio
// ("Message Sebas…"). No React Native: tests/chat runs it under Node.

/** The web's status line under the socio's name while it can answer. */
export const HERE_WITH_YOU = 'Here with you';
/** The web's status line while the workspace pauses every socio. */
export const SOCIO_PAUSED = 'Paused';

/** The socio's status line: the web's words. */
export function socioStatus(paused: boolean): string {
    return paused ? SOCIO_PAUSED : HERE_WITH_YOU;
}

/** The socio line's one screen-reader label: its name and status ("Sebas, Here with you"). */
export const socioLineLabel = (socio: string | null, status: string) => `${socio ?? 'Your socio'}, ${status}`;

/** The composer's placeholder: the web's "Message Sebas…", else the plain "Message" while the socio isn't known. */
export function chatPlaceholder(socio: string | null): string {
    return socio === null || socio.trim() === '' ? COMPOSER_PLACEHOLDER : `Message ${fitName(socio.trim())}…`;
}

/** The composer's label for screen readers: the placeholder without its ellipsis. */
export function chatInputLabel(socio: string | null): string {
    return socio === null || socio.trim() === '' ? COMPOSER_PLACEHOLDER : `Message ${fitName(socio.trim())}`;
}

/** The header's "…" button. */
export const CHAT_MENU_LABEL = 'Chat actions';
export const SAVE_AS_PAGE: MenuAction = { name: 'save-page', label: 'Save as page' };
/** Schedule a task opens the web: the app has no way to make a task yet. */
export const SCHEDULE_TASK: MenuAction = { name: 'schedule', label: 'Schedule a task (opens in your browser)' };

/** Save as page while a reply is still being written: the web's words, not choosable until it ends. */
export const SAVE_AS_PAGE_RUNNING: MenuAction = {
    name: 'save-page',
    label: 'Save as a page once the reply is done',
    disabled: true,
};

/**
 * The "…" menu of a private chat: Save as page, and Schedule a task. A new chat
 * not created yet has neither. While a reply runs, Save as page shows but can't
 * be chosen (the web's ChatHeader disables it then).
 */
export function chatMenu(local: boolean, running = false): MenuAction[] {
    if (local) {
        return [];
    }
    return [running ? SAVE_AS_PAGE_RUNNING : SAVE_AS_PAGE, SCHEDULE_TASK];
}

/** The web's title prompt for Save as page. */
export const SAVE_PAGE_TITLE = 'Save as page';
export const SAVE_PAGE_LABEL = 'Page title';
/** The server's limit on a page title (`POST /conversations/:id/page`). */
export const PAGE_TITLE_MAX = 160;

/** Where Schedule a task opens: the chat on the web, whose header schedules it (its dialog has no path). */
export const scheduleTaskHref = (threadId: string) => `/chats/${encodeURIComponent(threadId)}`;
