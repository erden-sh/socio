import { normalizeRole } from '@socio/shared/roles';
import type { Dot } from '@socio/shared/types';

import type { MenuAction } from '../chat/long-press';
import type { PageChatContext, PageChatOutcome } from '../sync/page-conversation';
import type { ShellWorkspace } from '../sync/shell';

// The page conversation's view (CB-499; the web's PageConversation in
// packages/client/src/modules/pages): the page's bar button, the socio picker,
// what to set up first, and the words for an open that didn't go. The chat
// itself is the app's chat screen (screens/chat.tsx), with the page as its
// banner ("Working on <title>", the web's `page-chat-context`).
// - **The socios** are the web's choices: every socio not archived that works in
//   the page's Space (`spaceIds`), oldest first as the server lists them. The
//   web's dock opens on the first; the phone's bar button opens the chat with the
//   only one at once, and with several is a menu of them (a UIMenu on iOS,
//   Material's popup on Android), as the web's Select.
// - **Set up first** (the web's ChatSetup): no socio in the Space says so (an
//   admin is pointed at the web, where they make one), and a workspace whose
//   assistant isn't set up (`setup.missing`) says to connect it there.
// - **A save still waiting** holds the open (the web saves first, `beforeChat`,
//   and refuses with its line while it can't): the socio reads the saved page.
// No React Native, so tests/shell runs it under Node.

/** The bar button's words (the web's "Ask about this page"), and its menu's title. */
export const PAGE_CHAT_LABEL = 'Ask about this page';
export const PAGE_CHAT_HINT = 'Opens your conversation about this page with a socio';
/** The web's heading over the open chat, the menu's title. */
export const PAGE_CHAT_TITLE = 'Page conversation';
/** The chat's banner: "Working on" and the page's title, which opens it. */
export const PAGE_CONTEXT_LEAD = 'Working on';
export const PAGE_CONTEXT_HINT = 'Opens the page';

/** The web's ChatSetup lines, with "socio" for the web's "specialist". */
export const NO_PAGE_SOCIO_ADMIN = 'Add a socio to work with this Space.';
export const NO_PAGE_SOCIO = 'Ask an admin to add a socio to this Space.';
export const PAGE_CHAT_SETUP = 'Connect your assistant to chat about this page.';
/** The web's `beforeChat` refusal: the page has a save that hasn't gone. */
export const PAGE_CHAT_UNSAVED = 'Save or resolve your document changes before starting page chat.';

export const PAGE_CHAT_NEEDS_CONNECTION = 'Needs a connection: the workspace opens page conversations.';
export const PAGE_CHAT_NO_ANSWER = 'No answer from the workspace. Try again.';
export const PAGE_CHAT_FAILED = 'Could not open page chat.';

/** A socio the person may ask about the page. */
export interface PageChatSocio {
    readonly id: string;
    readonly name: string;
}

/** What the bar button does. */
export type PageChatEntry =
    /** Opens the chat with a socio: the only one at once, else from the menu. */
    | { readonly kind: 'socios'; readonly socios: readonly PageChatSocio[] }
    /** Something to set up first: its line, and whether the web is where to do it. */
    | { readonly kind: 'setup'; readonly line: string; readonly web: boolean };

const byOldest = (a: Dot, b: Dot) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The web's `dots`: not archived, in the page's Space, oldest first. */
export function pageChatSocios(dots: readonly Dot[], spaceId: string): PageChatSocio[] {
    return dots
        .filter((dot) => !dot.archivedAt && dot.spaceIds.includes(spaceId))
        .sort(byOldest)
        .map((dot) => ({ id: dot.id, name: dot.name }));
}

/** The bar button's entry, as the web's PageConversation picks its view. */
export function pageChatEntry(input: {
    readonly dots: readonly Dot[];
    readonly spaceId: string;
    readonly workspace: Pick<ShellWorkspace, 'setup'> | null;
    readonly role: string | null | undefined;
}): PageChatEntry {
    const socios = pageChatSocios(input.dots, input.spaceId);
    if (socios.length === 0) {
        // An older server may still send the retired `operator` role (CB-390).
        const admin = normalizeRole(input.role) === 'admin';
        return { kind: 'setup', line: admin ? NO_PAGE_SOCIO_ADMIN : NO_PAGE_SOCIO, web: admin };
    }
    const missing: unknown = input.workspace?.setup?.missing;
    if (Array.isArray(missing) && missing.length > 0) {
        return { kind: 'setup', line: PAGE_CHAT_SETUP, web: true };
    }
    return { kind: 'socios', socios };
}

const SOCIO_ACTION = 'socio:';

/** The menu's actions for several socios: one per socio, by name. */
export const pageChatActions = (socios: readonly PageChatSocio[]): MenuAction[] =>
    socios.map((socio) => ({ name: `${SOCIO_ACTION}${socio.id}`, label: socio.name }));

/** The socio a menu action names, or null. */
export const socioOfAction = (name: string): string | null =>
    name.startsWith(SOCIO_ACTION) && name.length > SOCIO_ACTION.length ? name.slice(SOCIO_ACTION.length) : null;

/** The words for an open that didn't go, by status (the route's errors carry no code), never the server's text. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
    'http-400': 'Choose a socio in this Space with access enabled.',
    'http-401': 'Sign in again to do this',
    'http-403': 'You can’t open this page’s conversation.',
    'http-404': 'This page isn’t here any more.',
    'http-409': 'This page conversation is being created. Try again shortly.',
    'http-410': 'This page isn’t here any more.',
    'http-429': 'Too many tries. Wait a moment.',
};

/** What an open says, or null when it worked. */
export function pageChatCopy(outcome: PageChatOutcome): string | null {
    switch (outcome.kind) {
        case 'done':
            return null;
        case 'blocked':
            return outcome.reason === 'sign-in'
                ? 'Sign in again to do this'
                : outcome.reason === 'update'
                  ? 'Update Socio to do this'
                  : PAGE_CHAT_NEEDS_CONNECTION;
        case 'no-answer':
            return PAGE_CHAT_NO_ANSWER;
        case 'refused':
            return REFUSAL_COPY[outcome.reason] ?? PAGE_CHAT_FAILED;
    }
}

/** A route in the stack, as React Navigation's state has it. */
export interface StackRoute {
    readonly name: string;
    readonly params?: object;
}

/**
 * What the banner's title does: back to the page when the chat was opened from it (the route
 * under the chat), else the page pushed. A second copy of the page under itself is never made.
 */
export function pageContextTap(routes: readonly StackRoute[], index: number, page: PageChatContext): 'back' | 'push' {
    const under = index > 0 ? routes[index - 1] : undefined;
    const params = (under?.params ?? {}) as { spaceId?: unknown; pageId?: unknown };
    return under?.name === 'Page' && params.pageId === page.id && params.spaceId === page.spaceId ? 'back' : 'push';
}

/** The banner's words for screen readers: "Working on Roadmap". */
export const pageContextLabel = (page: PageChatContext) => `${PAGE_CONTEXT_LEAD} ${page.title}`;
