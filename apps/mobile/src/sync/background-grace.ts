import type { ActiveScope } from './active-scope';
import type { Outbox } from './outbox';
import type { WorkspaceScope } from './scope';
import type { AppStateSource } from './triggers';

// The outbox's background grace.
// iOS suspends an app seconds after it leaves the screen, so a message sent
// just before the person locks the phone would be cut off mid-request and
// become an ambiguous attempt. socio-device holds a background task while
// some lane has a request in flight, and only then (its port of T3 Code's
// T3BackgroundGraceSubscriber), and says when the time is about to run out:
// the outbox then marks those rows `unknown`, on disk, stops their requests
// and pauses (`interrupt({ pause: true })`), so the outbox checks them on
// resume, when AppState is 'active' again (`unpause()`), and not in the last seconds
// of background time: a request aborted on the phone may still be running on
// the server, and a check before it lands would send the message twice.
// Android holds nothing in v1 (the platform binds no grace there).
//
// Only the open workspace's outbox sends, so the grace follows the active
// scope: a switch lets go of the old one's (its `dispose()` stops its requests
// anyway) and takes the new one's. No React Native: tests/sync runs it under
// Node with a fake grace.

/** The platform's background grace (src/platform/background-grace.ts: socio-device on iOS). */
export interface BackgroundGrace {
    /** Whether a request is in flight. Fire and forget: the platform reports its own failures. */
    hold(hold: boolean): void;
    /** Calls `listener` when the grace is about to run out. Returns the unsubscribe. */
    onExpiring(listener: () => void): () => void;
}

/** What the grace needs of an outbox. */
export type GraceOutbox = Pick<Outbox, 'status' | 'onStatus' | 'interrupt' | 'unpause'>;

/** What the grace needs of AppState: when the app is active again. */
export type GraceAppState = Pick<AppStateSource, 'current' | 'subscribe'>;

const isActive = (state: string) => state === 'active';

/**
 * Holds the grace while `outbox` has a request in flight, interrupts and
 * pauses it when the grace runs out, and unpauses it once `appState` is
 * active. Returns the unbind, which lets go.
 */
export function bindBackgroundGrace(
    outbox: GraceOutbox,
    grace: BackgroundGrace,
    appState: GraceAppState,
    onError: (error: unknown) => void = () => {},
): () => void {
    let held = false;
    let bound = true;
    const follow = (inflight: number) => {
        const next = bound && inflight > 0;
        if (next !== held) {
            held = next;
            grace.hold(next);
        }
    };
    follow(outbox.status().inflight);
    const offStatus = outbox.onStatus((status) => follow(status.inflight));
    const offExpiring = grace.onExpiring(() => {
        if (!bound) {
            return;
        }
        // The rows become `unknown` before their requests stop; the status that
        // follows lets go. Whatever happens, the hold ends up matching what is
        // still in flight.
        outbox
            .interrupt({ pause: true })
            .catch(onError)
            .finally(() => {
                follow(outbox.status().inflight);
                // Back on screen before the interrupt finished: no 'active' change is coming.
                if (bound && isActive(appState.current())) {
                    outbox.unpause();
                }
            });
    });
    const offAppState = appState.subscribe((state) => {
        if (bound && isActive(state)) {
            outbox.unpause();
        }
    });
    // An unbind leaves a pause as it is: it comes with the scope's dispose (a
    // switch), which stops the outbox for good anyway.
    return () => {
        bound = false;
        offStatus();
        offExpiring();
        offAppState();
        follow(0);
    };
}

/** Binds the grace to whichever scope `activeScope` has open. Returns the stop. */
export function followBackgroundGrace(
    activeScope: Pick<ActiveScope, 'get' | 'subscribe'>,
    grace: BackgroundGrace,
    appState: GraceAppState,
    onError?: (error: unknown) => void,
): () => void {
    let bound: { readonly scope: WorkspaceScope; readonly unbind: () => void } | null = null;
    const follow = () => {
        const state = activeScope.get();
        const scope = state.kind === 'open' ? state.scope : null;
        if (bound?.scope === scope) {
            return;
        }
        bound?.unbind();
        bound = scope === null ? null : { scope, unbind: bindBackgroundGrace(scope.outbox, grace, appState, onError) };
    };
    follow();
    const unsubscribe = activeScope.subscribe(follow);
    return () => {
        unsubscribe();
        bound?.unbind();
        bound = null;
    };
}
