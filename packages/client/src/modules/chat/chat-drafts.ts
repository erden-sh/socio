import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

import { forgetOnSignOut } from '../../shell/auth-channel';

/**
 * Unsent composer text (CB-153): one draft per conversation, and one per
 * Dot for its new-chat box, kept in this browser's `localStorage` for the
 * signed-in person, so it is there again after switching chats, during a
 * running turn, after a reload or a reconnect.
 *
 * - A draft is only ever put back in its box, never sent on its own. It
 *   goes when its text is deleted, or once a send is settled.
 * - Sending marks the draft `sending` with the text that went: a send
 *   that never reached the server (CB-108) puts it back, even when the
 *   chat closed in the meantime; one the server may have waits for the
 *   chat's next connect to tell (`Chat`). Up to `SENDS_KEPT` at once
 *   (CB-154: a message shown as not sent stays here while you send
 *   others); text given back joins what the box holds, never replaces it.
 * - Keyed by person: someone else on this browser never sees them, and
 *   the first use for another person drops the last one's. Signing out
 *   drops them all. The browser's storage is per site, so per workspace.
 * - Signing out warns first about drafts less than a day old (CB-171);
 *   older ones, and any stored without a time, are cleared quietly.
 * - Text only: attachments stay in the tray of the box that holds them.
 * - Kept in this browser only: no other device sees them.
 */

/** `localStorage` key prefix: a draft is `<prefix><person>:<scope>`. */
export const DRAFT_KEY_PREFIX = 'socio:draft:';
/** At most this many drafts a person; the oldest go first. */
export const DRAFTS_KEPT = 50;

/** At most this many sends a draft remembers; an older one's text goes
 * back into the box rather than be forgotten. */
export const SENDS_KEPT = 5;

/** A conversation's draft scope. */
export const chatDraft = (threadId: string) => `chat:${threadId}`;
/** A Dot's new-chat draft scope. */
export const newChatDraft = (dotId: string) => `new:${dotId}`;

export interface DraftRecord {
    /** What the box holds. */
    text: string;
    /** When it last changed: the bound drops the oldest. */
    at: number;
    /** Messages sent from it, oldest first, not yet known to have arrived. */
    sending?: Sent[];
}

/** A message sent from a draft: its id and the text that went. */
export interface Sent {
    id: string;
    text: string;
}

/** `text` given back to a box holding `box`: after it, never instead. */
export const joinDraft = (box: string, text: string) => (box.trim() ? `${box}\n\n${text}` : text);

const EMPTY: DraftRecord = { text: '', at: 0 };
const personPrefix = (userId: string) => `${DRAFT_KEY_PREFIX}${encodeURIComponent(userId)}:`;
const keyOf = (userId: string, scope: string) => `${personPrefix(userId)}${scope}`;

// What this tab knows, by key (also all there is without storage).
const memory = new Map<string, DraftRecord>();
const listeners = new Set<() => void>();
let owner: string | undefined;

function storage(): Storage | undefined {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
        return undefined;
    }
}

function storedKeys(): string[] {
    const store = storage();
    if (!store) {
        return [...memory.keys()];
    }
    const keys: string[] = [];
    try {
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key?.startsWith(DRAFT_KEY_PREFIX)) {
                keys.push(key);
            }
        }
    } catch {
        // Unreadable: nothing to list.
    }
    return keys;
}

function parse(raw: string | null): DraftRecord | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        const value = JSON.parse(raw) as {
            text?: unknown;
            at?: unknown;
            sending?: unknown;
        };
        if (typeof value?.text !== 'string') {
            return undefined;
        }
        // One send, as the first version kept it, or several.
        const listed: unknown[] = Array.isArray(value.sending) ? value.sending : value.sending ? [value.sending] : [];
        const sending = listed.flatMap((item) => {
            const sent = item as Partial<Sent> | null;
            return sent && typeof sent.id === 'string' && typeof sent.text === 'string'
                ? [{ id: sent.id, text: sent.text }]
                : [];
        });
        return {
            text: value.text,
            at: typeof value.at === 'number' ? value.at : 0,
            ...(sending.length ? { sending } : {}),
        };
    } catch {
        return undefined;
    }
}

/** The first use for a person drops every other person's drafts. */
function claim(userId: string) {
    if (owner === userId) {
        return;
    }
    owner = userId;
    const mine = personPrefix(userId);
    for (const key of storedKeys()) {
        if (!key.startsWith(mine)) {
            drop(key);
        }
    }
    for (const key of [...memory.keys()]) {
        if (!key.startsWith(mine)) {
            memory.delete(key);
        }
    }
}

function drop(key: string) {
    memory.delete(key);
    try {
        storage()?.removeItem(key);
    } catch {
        // Not kept anyway.
    }
}

function emit() {
    for (const listener of listeners) {
        listener();
    }
}

/** A person's draft for `scope`, or an empty one. */
export function readDraft(userId: string, scope: string): DraftRecord {
    claim(userId);
    const key = keyOf(userId, scope);
    let record = memory.get(key);
    if (!record) {
        let raw: string | null = null;
        try {
            raw = storage()?.getItem(key) ?? null;
        } catch {
            // Unreadable: an empty draft.
        }
        record = parse(raw) ?? EMPTY;
        memory.set(key, record);
    }
    return record;
}

function save(userId: string, scope: string, record: DraftRecord) {
    claim(userId);
    const key = keyOf(userId, scope);
    if (!record.text && !record.sending?.length) {
        drop(key);
        memory.set(key, EMPTY);
        emit();
        return;
    }
    const store = storage();
    const known = store ? store.getItem(key) !== null : memory.has(key);
    memory.set(key, record);
    try {
        store?.setItem(key, JSON.stringify(record));
    } catch {
        // Full or refused: this tab still has it.
    }
    if (!known) {
        bound(userId);
    }
    emit();
}

/** Keeps a person's newest `DRAFTS_KEPT` drafts. */
function bound(userId: string) {
    const mine = personPrefix(userId);
    const keys = storedKeys().filter((key) => key.startsWith(mine));
    if (keys.length <= DRAFTS_KEPT) {
        return;
    }
    const at = (key: string) => memory.get(key)?.at ?? parse(storage()?.getItem(key) ?? null)?.at ?? 0;
    const oldest = keys.sort((a, b) => at(a) - at(b));
    for (const key of oldest.slice(0, keys.length - DRAFTS_KEPT)) {
        drop(key);
    }
}

/** Sets the text of a person's draft for `scope`; empty text deletes it. */
export function writeDraft(userId: string, scope: string, text: string) {
    const current = readDraft(userId, scope);
    if (current.text === text) {
        return;
    }
    save(userId, scope, { ...current, text, at: Date.now() });
}

/**
 * `record` once message `id` was sent with `text`: the box empties (unless
 * `keep`: a retry, the box holding something else) and the send is
 * remembered. Past `SENDS_KEPT`, the oldest's text goes back in the box.
 */
export function markedSending(record: DraftRecord, id: string, text: string, keep = false): DraftRecord {
    const sending = [...(record.sending ?? []).filter((sent) => sent.id !== id), { id, text }];
    let box = keep ? record.text : '';
    while (sending.length > SENDS_KEPT) {
        box = joinDraft(box, sending.shift()!.text);
    }
    return { text: box, at: Date.now(), sending };
}

/**
 * `record` once message `id`'s send is settled: with `restore` (it never
 * arrived) its text joins the box's; otherwise it is forgotten.
 */
export function settledSending(record: DraftRecord, id: string, restore: boolean): DraftRecord {
    const sent = record.sending?.find((item) => item.id === id);
    if (!sent) {
        return record;
    }
    const sending = record.sending!.filter((item) => item !== sent);
    return {
        text: restore ? joinDraft(record.text, sent.text) : record.text,
        at: Date.now(),
        ...(sending.length ? { sending } : {}),
    };
}

/** The box was sent as message `id` (`markedSending`). */
export function markSending(userId: string, scope: string, id: string, text: string, keep = false) {
    save(userId, scope, markedSending(readDraft(userId, scope), id, text, keep));
}

/** Message `id`'s send is settled (`settledSending`). */
export function settleSending(userId: string, scope: string, id: string, restore: boolean) {
    const current = readDraft(userId, scope);
    const next = settledSending(current, id, restore);
    if (next !== current) {
        save(userId, scope, next);
    }
}

/** A draft younger than this is worth a warning at sign-out. */
export const RECENT_DRAFT_MS = 24 * 60 * 60 * 1000;

/**
 * The person's unsent drafts less than a day old (CB-171), newest first:
 * text in a box, or a message sent that is not known to have arrived. One
 * with no time (stored before drafts had one) counts as old.
 */
export function recentDrafts(userId: string, now = Date.now()): Array<{ scope: string; at: number }> {
    claim(userId);
    const mine = personPrefix(userId);
    const found: Array<{ scope: string; at: number }> = [];
    for (const key of storedKeys()) {
        if (!key.startsWith(mine)) {
            continue;
        }
        const record = memory.get(key) ?? parse(storage()?.getItem(key) ?? null) ?? EMPTY;
        const unsent = record.text.trim() !== '' || !!record.sending?.length;
        if (unsent && record.at > 0 && now - record.at < RECENT_DRAFT_MS) {
            found.push({ scope: key.slice(mine.length), at: record.at });
        }
    }
    return found.sort((a, b) => b.at - a.at);
}

/** Drops every draft in this browser (sign-out). */
export function forgetDrafts() {
    for (const key of storedKeys()) {
        drop(key);
    }
    memory.clear();
    owner = undefined;
    emit();
}

forgetOnSignOut(forgetDrafts);

// Another tab's change to a draft shows here too.
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
        if (event.key === null) {
            memory.clear();
        } else if (event.key.startsWith(DRAFT_KEY_PREFIX)) {
            memory.delete(event.key);
        } else {
            return;
        }
        emit();
    });
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};

type SetDraft = (next: string | ((current: string) => string)) => void;

export interface Draft {
    text: string;
    setText: SetDraft;
    /** The text in the box was sent as message `id` (`markedSending`). */
    sending: (id: string, text: string, keep?: boolean) => void;
    /** Message `id`'s send is settled (`settledSending`). */
    settle: (id: string, restore: boolean) => void;
    /** The messages sent from this box not yet known to have arrived. */
    unsettled: () => Sent[];
}

/**
 * A composer's draft for `scope`, kept for the signed-in person
 * (`userId`). Without one, in this mount's memory only.
 */
export function useDraft(userId: string | undefined, scope: string): Draft {
    const [local, setLocal] = useState<DraftRecord>(EMPTY);
    // Without a person, the same record in this mount's state; read
    // through a ref, as storage is, so a call sees the one before it.
    const latest = useRef(local);
    latest.current = local;
    const update = (next: (current: DraftRecord) => DraftRecord) => {
        latest.current = next(latest.current);
        setLocal(latest.current);
    };
    const kept = useSyncExternalStore(
        subscribe,
        () => (userId ? readDraft(userId, scope).text : ''),
        () => '',
    );
    const text = userId ? kept : local.text;
    const setText = useCallback<SetDraft>(
        (next) => {
            if (!userId) {
                update((current) => ({
                    ...current,
                    text: typeof next === 'function' ? next(current.text) : next,
                }));
                return;
            }
            const current = readDraft(userId, scope).text;
            writeDraft(userId, scope, typeof next === 'function' ? next(current) : next);
        },
        [userId, scope],
    );
    const sending = useCallback(
        (id: string, sent: string, keep = false) => {
            if (userId) {
                markSending(userId, scope, id, sent, keep);
            } else {
                update((current) => markedSending(current, id, sent, keep));
            }
        },
        [userId, scope],
    );
    const settle = useCallback(
        (id: string, restore: boolean) => {
            if (userId) {
                settleSending(userId, scope, id, restore);
            } else {
                update((current) => settledSending(current, id, restore));
            }
        },
        [userId, scope],
    );
    const unsettled = useCallback(
        () => (userId ? readDraft(userId, scope) : latest.current).sending ?? [],
        [userId, scope],
    );
    return { text, setText, sending, settle, unsettled };
}
