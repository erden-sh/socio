import { useEffect, useSyncExternalStore } from 'react';

import { ISSUE_CARDS_MAX, type IssueCard } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';
import { forgetOnSignOut } from '../../shell/auth-channel';
import { resolveLink } from '../pages/page-navigation';

/**
 * Chat's issue cards (CB-87), and the chips for "#n" in an issue's text
 * (CB-274): the issues they name, read with the viewer's own session
 * (`GET /api/issues/cards`). Every card asked for
 * in one render goes out in one request, and the answers are kept for the
 * tab, so a message with several links (or a transcript with many) costs
 * one call. Null when the viewer can't have the issue (missing, deleted,
 * no access, or the call failed): the card is then the plain link.
 */

/** A card shown again after this long is asked for again (its status moves). */
export const ISSUE_CARD_TTL_MS = 60_000;

interface Entry {
    card: IssueCard | null;
    at: number;
}
const cache = new Map<number, Entry>();
const pending = new Set<number>();
const queued = new Set<number>();
const listeners = new Set<() => void>();
let scheduled = false;
// Bumped on sign-out, so an answer for the last user is dropped.
let generation = 0;

const notify = () => {
    for (const listener of listeners) {
        listener();
    }
};

/** `/issues/CB-85` (or this app's absolute URL for it) as 85. */
export function issueLinkNumber(href: string | null | undefined) {
    const target = resolveLink(href);
    if (target?.kind !== 'page') {
        return undefined;
    }
    const match = /^\/issues\/CB-([1-9]\d{0,8})$/.exec(target.path);
    return match ? Number(match[1]) : undefined;
}

async function load(numbers: number[]) {
    const asked = generation;
    let cards: IssueCard[] | undefined;
    try {
        cards = await api<IssueCard[]>(`/issues/cards?numbers=${numbers.join(',')}`);
    } catch {
        // Signed out, the module off, or the network: the plain links stay.
    }
    if (asked !== generation) {
        return;
    }
    const at = Date.now();
    const found = new Map(cards?.map((card) => [card.number, card]));
    for (const number of numbers) {
        pending.delete(number);
        cache.set(number, { card: found.get(number) ?? null, at });
    }
    notify();
}

function flush() {
    scheduled = false;
    const numbers = [...queued];
    queued.clear();
    for (let start = 0; start < numbers.length; start += ISSUE_CARDS_MAX) {
        void load(numbers.slice(start, start + ISSUE_CARDS_MAX));
    }
}

/** Queues the issue for the next batch, unless it is fresh or on its way. */
function request(number: number) {
    const entry = cache.get(number);
    if (entry && Date.now() - entry.at < ISSUE_CARD_TTL_MS) {
        return;
    }
    if (pending.has(number) || queued.has(number)) {
        return;
    }
    queued.add(number);
    pending.add(number);
    if (scheduled) {
        return;
    }
    scheduled = true;
    // After this render's effects: every card in it rides the same request.
    queueMicrotask(flush);
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * The issue's card, or null when there is none to show (yet, or at all).
 * A stale card stays shown while it is asked for again. Null on the server
 * and while hydrating, so the first paint is the plain link.
 */
export function useIssueCard(number: number): IssueCard | null {
    const entry = useSyncExternalStore(
        subscribe,
        () => cache.get(number),
        () => undefined,
    );
    useEffect(() => request(number), [number]);
    return entry?.card ?? null;
}

/** Drops every kept card (on sign-out, and between tests). */
export function forgetIssueCards() {
    generation++;
    cache.clear();
    queued.clear();
    pending.clear();
    notify();
}
forgetOnSignOut(forgetIssueCards);
