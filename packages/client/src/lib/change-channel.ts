import { useCallback, useLayoutEffect, useRef } from 'react';

import {
    changeNote,
    isChangeNote,
    liveTopicsOf,
    notesForWrite,
    topicMatches,
    type ChangeNote,
} from '@socio/shared/live/change-notes';

import { forgetOnSignOut } from '../shell/auth-channel';

/**
 * Writes shared by this browser's tabs, over one BroadcastChannel (CB-74).
 *
 * After a write succeeds, a tab posts a note: what changed, by topic and
 * id, never a title, body, name or anything a user typed. A tab that hears
 * one refetches what it shows of that topic through its own cookie, as
 * its poll would, a few seconds sooner. Only pages of this origin in the
 * same browser profile share the channel, and a tab never hears itself.
 *
 * The notes and topics are shared with the server, so its event stream
 * (step 2) can feed the same handlers.
 */

/** The channel's name, the same in every tab. */
export const CHANGES_CHANNEL = 'socio:changes';

/** At most this many notes in one message. */
const MAX_NOTES = 20;

let channel: BroadcastChannel | undefined;
let listening = false;
const open = () => {
    if (typeof BroadcastChannel !== 'function') {
        return undefined;
    }
    channel ??= new BroadcastChannel(CHANGES_CHANNEL);
    if (!listening) {
        listening = true;
        channel.addEventListener('message', (message: MessageEvent) => {
            const data: unknown = message.data;
            if (!Array.isArray(data) || data.length > MAX_NOTES) {
                return;
            }
            const notes = data.filter(isChangeNote);
            if (notes.length) {
                void deliver(notes.flatMap(liveTopicsOf));
            }
        });
    }
    return channel;
};

/** Tells the other tabs what this tab just changed. */
export function postChanges(notes: readonly ChangeNote[]) {
    const valid = notes.filter(isChangeNote).slice(0, MAX_NOTES);
    if (!valid.length) {
        return;
    }
    // Copied field by field: nothing but topic and ids leaves the tab.
    open()?.postMessage(valid.map(({ topic, id, spaceId }) => changeNote(topic, id, spaceId)));
}

/** Posts the notes a successful write to `path` makes (api.ts). */
export function postWrite(path: string) {
    postChanges(notesForWrite(path));
}

/** Notes that arrive within this many ms make one refetch per topic. */
export const COALESCE_MS = 100;
/** The longest the other topics wait for the shell to re-read. */
const SHELL_WAIT_MS = 5000;

interface Subscriber {
    topic: string;
    run: () => unknown;
}
const subscribers = new Set<Subscriber>();
let queued = new Set<string>();
let waiting: (() => void)[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
// The shell is re-reading after a note: single-item polls wait.
let settling = 0;
// A note for the shell is queued (its coalescing window): they wait too, or a
// tick there could ask for a chat another tab just deleted.
const shellQueued = () => [...queued].some((target) => topicMatches('shell', target));

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs the handlers of the tabs' topics hit by `targets`. The shell goes
 * first: a conversation deleted in another tab leaves the list (and the
 * chat page unmounts) before anything asks for that conversation alone.
 */
async function run(targets: string[]) {
    const hit = (subscriber: Subscriber) => targets.some((target) => topicMatches(subscriber.topic, target));
    const shell = [...subscribers].filter((subscriber) => subscriber.topic === 'shell' && hit(subscriber));
    if (shell.length) {
        settling += 1;
        try {
            await Promise.race([Promise.allSettled(shell.map((subscriber) => subscriber.run())), wait(SHELL_WAIT_MS)]);
        } finally {
            settling -= 1;
        }
    }
    // Read again: what the shell's new data unmounted is gone.
    await Promise.allSettled(
        [...subscribers]
            .filter((subscriber) => subscriber.topic !== 'shell' && hit(subscriber))
            .map((subscriber) => subscriber.run()),
    );
}

async function flush() {
    timer = undefined;
    running = true;
    const targets = [...queued];
    const done = waiting;
    queued = new Set();
    waiting = [];
    try {
        await run(targets);
    } finally {
        running = false;
        for (const resolve of done) {
            resolve();
        }
        if (queued.size) {
            timer = setTimeout(() => void flush(), 0);
        }
    }
}

/**
 * Queues a refetch of the topics in `targets` (coalesced for `delay` ms);
 * resolves once their handlers ran.
 */
function deliver(targets: string[], delay = COALESCE_MS): Promise<void> {
    for (const target of targets) {
        queued.add(target);
    }
    const done = new Promise<void>((resolve) => waiting.push(resolve));
    if (!timer && !running) {
        timer = setTimeout(() => void flush(), delay);
    }
    return done;
}

/**
 * Refetches everything this tab shows, the shell first (the tab came back
 * into view: use-tab-refresh.ts). Resolves once every handler ran.
 */
export function refreshShown() {
    return deliver(['*'], 0);
}

/**
 * Calls `handler` when another tab changes something on `topic` (`shell`,
 * `issues`, `space:<id>`, `conversation:<id>`…), and when this tab comes
 * back into view. No topic: nothing. The handler may return a promise (the
 * shell's does: the other topics wait for it).
 *
 * Returns `canPoll()`: false once the subscription ended, or from the
 * moment a note for the shell arrives until the shell re-read. A poll of
 * one item checks it before each tick, so a chat deleted in another tab
 * is never asked for.
 */
export function useLiveTopic(topic: string | undefined, handler: () => unknown) {
    const latest = useRef(handler);
    useLayoutEffect(() => {
        latest.current = handler;
    });
    const current = useRef<Subscriber | undefined>(undefined);
    // Layout effects: a view that unmounts leaves before the shell's commit
    // is over, so the topics after the shell never reach it.
    useLayoutEffect(() => {
        if (!topic) {
            return;
        }
        open();
        const subscriber: Subscriber = { topic, run: () => latest.current() };
        subscribers.add(subscriber);
        current.current = subscriber;
        return () => {
            subscribers.delete(subscriber);
            if (current.current === subscriber) {
                current.current = undefined;
            }
        };
    }, [topic]);
    return useCallback(
        () => !!current.current && subscribers.has(current.current) && settling === 0 && !shellQueued(),
        [],
    );
}

/** Whether the shell is re-reading after a note (tests). */
export const shellSettling = () => settling > 0;

/** Closes the channel and drops queued work (tests; sign-out). */
export function closeChangeChannel() {
    channel?.close();
    channel = undefined;
    listening = false;
    resetQueue();
}

function resetQueue() {
    if (timer) {
        clearTimeout(timer);
    }
    timer = undefined;
    queued = new Set();
    for (const resolve of waiting) {
        resolve();
    }
    waiting = [];
}

// Signed out, nothing waits to refetch for the old session.
forgetOnSignOut(resetQueue);
