import { notesForWrite } from '@socio/shared/live/change-notes';

import { type AppStateSource, createNetworkWatch, isForeground, type NetworkSource } from './triggers';

// The outbox's drain triggers: the outbox
// looks for work on `start` and after each write by itself; these add the app
// coming back to the foreground ('inactive' counts) and the network coming
// back or changing type (Wi-Fi to cellular), through triggers.ts's AppState
// and NetInfo sources, which src/platform binds. Each is a `poke`, which also
// ends `interrupt`'s pause (iOS's grace expiry). The network's are a `wake`:
// a lane waiting out its back-off from while the phone had no network goes at
// once (otherwise a message could wait up to a minute after the network came
// back).
//
// `notesToPull` is the trigger "after this device's own write": the
// topics shared's `notesForWrite` names for a write's path, as on the web.

export interface OutboxTriggerOptions {
    readonly appState: AppStateSource;
    readonly network: NetworkSource;
    /** The outbox's `poke`. */
    readonly poke: () => void;
    /** The outbox's `wake`, for the network back or changed: a plain back-off ends. Else `poke`. */
    readonly wake?: () => void;
}

/** Pokes the outbox on a return to the foreground and on the network back or changed. Returns the unbind. */
export function bindOutboxTriggers({ appState, network, poke, wake = poke }: OutboxTriggerOptions): () => void {
    let foreground = isForeground(appState.current());
    const watch = createNetworkWatch();
    let bound = true;
    network
        .current()
        .then((state) => {
            if (bound) {
                watch.seed(state);
            }
        })
        .catch(() => {});
    const unsubscribes = [
        appState.subscribe((state) => {
            const next = isForeground(state);
            if (next && !foreground) {
                poke();
            }
            foreground = next;
        }),
        network.subscribe((state) => {
            const change = watch.report(state);
            if (change === 'back' || change === 'changed') {
                wake();
            }
        }),
    ];
    return () => {
        bound = false;
        for (const unsubscribe of unsubscribes.splice(0)) {
            unsubscribe();
        }
    };
}

/** What a write to `path` (an `/api` path) changed: the chats and issue details to read, and whether the shell's lists did. */
export function notesToPull(path: string): { conversations: string[]; issues: string[]; shell: boolean } {
    const notes = notesForWrite(path.replace(/^\/api(?=\/)/, ''));
    const ids = (topic: string) => [
        ...new Set(notes.flatMap((note) => (note.topic === topic && note.id !== undefined ? [note.id] : []))),
    ];
    return { conversations: ids('conversation'), issues: ids('issue'), shell: notes.length > 0 };
}
