import type { Conversation } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';

import { readAnswer } from './outbox-answers';
import type { WriteHold } from './session';
import type { NetworkSource } from './triggers';

// The page conversation (CB-499), the scope's `pageChats`: the web's two requests
// (packages/client's PageConversation and Chat, the server's
// src/server/pages/page-routes.ts), online only, never through the outbox:
// - **Open,** `POST /api/spaces/:spaceId/pages/:pageId/conversation {dotId}`:
//   the person's chat about the page with that socio, made on first use and the
//   same one after (the server's `pages.conversation`). The server picks its
//   id, so it is refused before any request (`blocked()`) offline, while the
//   server is away, and while writes wait (`writeHold`). Its answer is the
//   conversation; then the shell is pulled and the open resolves once the chat
//   list holds it (`listed`), so the chat screen opens on it, not "This chat
//   isn't here". Refusals by status, never the server's text (10.2).
// - **Its page,** `GET /api/conversations/:id/page-context`: the page a chat is
//   about (`{id, spaceId, title}`), or null for any other chat. The chat screen
//   shows it in its banner, as the web's does ("Working on <title>"). Read once
//   per chat while the scope is open (the web reads it as the chat mounts, with a
//   10 s limit), kept in memory only; a local id, offline or a failed read is
//   unknown, asked again next time.
// No React Native: tests/sync runs it under Node against a fake fetch.

/** The page a page chat is about: the web's PageContext. */
export interface PageChatContext {
    readonly id: string;
    readonly spaceId: string;
    readonly title: string;
}

/** Why nothing can be sent now. */
export type PageChatBlock = 'offline' | 'away' | 'sign-in' | 'update';

/** What opening a page's conversation came to. */
export type PageChatOutcome =
    /** The server answered the chat, and the chat list holds it (or a while passed). */
    | { readonly kind: 'done'; readonly chat: Pick<Conversation, 'id' | 'dotId'> }
    /** Nothing was sent. */
    | { readonly kind: 'blocked'; readonly reason: PageChatBlock }
    /** Refused: `http-<status>` (the route's errors carry no code), or its `code`. */
    | { readonly kind: 'refused'; readonly reason: string }
    /** It went and no answer came, or the server failed. */
    | { readonly kind: 'no-answer' };

export interface PageChatsOptions {
    readonly fetch: AuthedFetch;
    readonly network: NetworkSource;
    /** Whether the server is away (the scheduler's status). */
    readonly away: () => boolean;
    /** Why writes wait (session.ts's `writeHold`). */
    readonly hold: () => WriteHold;
    /** Pulls the shell; resolves once the chat list holds `chatId` (or a while passed). */
    readonly listed: (chatId: string) => Promise<void>;
    /** Whether `id` is a chat made on this phone whose create hasn't resolved (local-ids.ts). */
    readonly isLocal: (id: string) => boolean;
    /** How long the page's read may take: the web's 10 s. */
    readonly contextTimeoutMs?: number;
}

export interface PageChats {
    /** Why nothing can be sent now, or null. */
    blocked(): PageChatBlock | null;
    /** Opens (or makes) the person's chat about the page with `dotId`, as the web's page dock does. */
    open(spaceId: string, pageId: string, dotId: string): Promise<PageChatOutcome>;
    /** A chat's page as last read: the page, null for a chat about none, undefined while unknown. */
    known(chatId: string): PageChatContext | null | undefined;
    /** Reads a chat's page (once while the scope is open): the page, null for none, undefined when it couldn't. */
    context(chatId: string): Promise<PageChatContext | null | undefined>;
    /** Stops listening to the network. */
    dispose(): void;
}

export const pageConversationPath = (spaceId: string, pageId: string) =>
    `/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}/conversation`;

export const pageContextPath = (chatId: string) => `/api/conversations/${encodeURIComponent(chatId)}/page-context`;

/** The web's limit on the page's read (`AbortSignal.timeout(10000)`). */
export const PAGE_CONTEXT_TIMEOUT_MS = 10_000;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isChat = (value: unknown): value is Pick<Conversation, 'id' | 'dotId'> =>
    value !== null &&
    typeof value === 'object' &&
    nonEmpty((value as { id?: unknown }).id) &&
    nonEmpty((value as { dotId?: unknown }).dotId);

/** The answer's page, null for a chat about none, undefined for a body that isn't either. */
export function readPageContext(body: unknown): PageChatContext | null | undefined {
    if (body === null) {
        return null;
    }
    if (typeof body !== 'object') {
        return undefined;
    }
    const { id, spaceId, title } = body as { id?: unknown; spaceId?: unknown; title?: unknown };
    return nonEmpty(id) && nonEmpty(spaceId) && typeof title === 'string' ? { id, spaceId, title } : undefined;
}

export function createPageChats(options: PageChatsOptions): PageChats {
    const { fetch, network, away, hold, listed, isLocal } = options;
    const timeoutMs = options.contextTimeoutMs ?? PAGE_CONTEXT_TIMEOUT_MS;
    let connected: boolean | null = null;
    const contexts = new Map<string, PageChatContext | null>();
    const reading = new Map<string, Promise<PageChatContext | null | undefined>>();
    const unsubscribe = network.subscribe((next) => {
        if (next.connected !== null) {
            connected = next.connected;
        }
    });
    network
        .current()
        .then((next) => {
            if (connected === null && next.connected !== null) {
                connected = next.connected;
            }
        })
        .catch(() => {});

    const unreachable = (): 'offline' | 'away' | null => {
        if (connected === false) {
            return 'offline';
        }
        return away() ? 'away' : null;
    };
    const blocked = (): PageChatBlock | null => unreachable() ?? hold();

    const read = async (chatId: string): Promise<PageChatContext | null | undefined> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const answer = await readAnswer(
                await fetch(pageContextPath(chatId), { method: 'GET', signal: controller.signal }),
                controller.signal,
            );
            if (answer.status < 200 || answer.status >= 300) {
                return undefined;
            }
            const page = readPageContext(answer.body);
            if (page !== undefined) {
                contexts.set(chatId, page);
            }
            return page;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    };

    /** One read per chat at a time. */
    const ask = (chatId: string) => {
        const going = reading.get(chatId);
        if (going !== undefined) {
            return going;
        }
        const next = read(chatId).finally(() => reading.delete(chatId));
        reading.set(chatId, next);
        return next;
    };

    return {
        blocked,
        async open(spaceId, pageId, dotId) {
            const reason = blocked();
            if (reason !== null) {
                return { kind: 'blocked', reason };
            }
            let answer;
            try {
                answer = await readAnswer(
                    await fetch(pageConversationPath(spaceId, pageId), { method: 'POST', json: { dotId } }),
                );
            } catch {
                return { kind: 'no-answer' };
            }
            if (answer.status >= 200 && answer.status < 300) {
                if (!isChat(answer.body)) {
                    return { kind: 'no-answer' };
                }
                const chat = { id: answer.body.id, dotId: answer.body.dotId };
                // The page it is about is known now: the banner draws at once.
                if (!contexts.has(chat.id)) {
                    void ask(chat.id);
                }
                await listed(chat.id).catch(() => {});
                return { kind: 'done', chat };
            }
            if (answer.status >= 500) {
                return { kind: 'no-answer' };
            }
            return { kind: 'refused', reason: answer.code ?? `http-${answer.status}` };
        },
        known: (chatId) => contexts.get(chatId),
        context(chatId) {
            if (contexts.has(chatId)) {
                return Promise.resolve(contexts.get(chatId));
            }
            // A read: it still goes while writes wait, but never for a chat the server hasn't made.
            if (isLocal(chatId) || unreachable() !== null) {
                return Promise.resolve(undefined);
            }
            return ask(chatId);
        },
        dispose() {
            unsubscribe();
            contexts.clear();
            reading.clear();
        },
    };
}
