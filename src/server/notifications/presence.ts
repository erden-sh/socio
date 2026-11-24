/**
 * Whether a person is using the brain right now (CB-114), in memory: a
 * notification goes to their channels only when they're away.
 *
 * - A tab reports itself on each `/api/state` poll (every 3 s) in the
 *   presence header (`PRESENCE_HEADER`): `<tab id> <path>` while it is
 *   visible and focused and had input in the last minute, else
 *   `<tab id> -`. That, or the beacon sent when the tab is hidden or
 *   closed, ends the tab's presence.
 * - A message from the person in a Telegram conversation counts as being
 *   in that chat for two minutes.
 *
 * Anything missing or old counts as away, so a closed laptop or a lost
 * connection never keeps a notification back. Nothing here is stored: a
 * restart starts everyone away.
 */

import type { Presence, UserPresenceShape } from './contract.js';

/** A tab's report counts this long (three polls and some). */
export const TAB_FRESH_MS = 10_000;
/** A Telegram message counts this long. */
export const TELEGRAM_FRESH_MS = 2 * 60_000;

export class PresenceTracker implements UserPresenceShape {
    private tabs = new Map<string, Map<string, { path: string; at: number }>>();
    private telegram = new Map<string, Map<string, number>>();

    /** A poll from one of the person's tabs: active on `path`, or not (undefined). */
    tab(userId: string, tab: string, path: string | undefined, now = Date.now()) {
        let tabs = this.tabs.get(userId);
        if (path === undefined) {
            tabs?.delete(tab);
            if (tabs?.size === 0) {
                this.tabs.delete(userId);
            }
            return;
        }
        if (!tabs) {
            this.tabs.set(userId, (tabs = new Map()));
        }
        tabs.set(tab, { path, at: now });
    }
    /** The tab was hidden or closed. */
    away(userId: string, tab: string) {
        this.tab(userId, tab, undefined);
    }
    /** The person wrote in a Telegram conversation (its app thread). */
    telegramMessage(userId: string, threadId: string, now = Date.now()) {
        let threads = this.telegram.get(userId);
        if (!threads) {
            this.telegram.set(userId, (threads = new Map()));
        }
        threads.set(threadId, now);
    }

    /**
     * `present`: looking at the chat the turn is in; `in_app`: using the
     * brain elsewhere; `away`: neither, as far as anything here knows.
     */
    judge(userId: string, threadId?: string, now = Date.now()): Presence {
        this.forgetOld(userId, now);
        const tabs = [...(this.tabs.get(userId)?.values() ?? [])];
        if (threadId) {
            const chat = `/chats/${encodeURIComponent(threadId)}`;
            if (tabs.some((tab) => tab.path === chat)) {
                return 'present';
            }
            const told = this.telegram.get(userId)?.get(threadId);
            if (told !== undefined && now - told <= TELEGRAM_FRESH_MS) {
                return 'present';
            }
        }
        return tabs.length ? 'in_app' : 'away';
    }

    /**
     * Who is looking at the chat now (CB-216: a room's presence): the
     * people with a tab in use on it. Only tabs count, never a Telegram
     * message, and only while their report is fresh, so a closed tab, a
     * lost connection or a restart clears it within `TAB_FRESH_MS`.
     */
    viewing(threadId: string, now = Date.now()): string[] {
        const chat = `/chats/${encodeURIComponent(threadId)}`;
        const people: string[] = [];
        for (const userId of [...this.tabs.keys()]) {
            this.forgetOld(userId, now);
            const tabs = this.tabs.get(userId);
            if ([...(tabs?.values() ?? [])].some((tab) => tab.path === chat)) {
                people.push(userId);
            }
        }
        return people;
    }

    private forgetOld(userId: string, now: number) {
        const tabs = this.tabs.get(userId);
        for (const [id, tab] of tabs ?? []) {
            if (now - tab.at > TAB_FRESH_MS) {
                tabs!.delete(id);
            }
        }
        if (tabs?.size === 0) {
            this.tabs.delete(userId);
        }
        const threads = this.telegram.get(userId);
        for (const [id, at] of threads ?? []) {
            if (now - at > TELEGRAM_FRESH_MS) {
                threads!.delete(id);
            }
        }
        if (threads?.size === 0) {
            this.telegram.delete(userId);
        }
    }
}
