/**
 * Sign-in state shared by this browser's tabs, over one BroadcastChannel.
 *
 * A tab says "signed-in" or "signed-out" when that happens in it. The
 * message is the event name and nothing else: no token, user id or name.
 * A tab that hears it never trusts it: it asks the server, through its own
 * cookie (the shell loader's revalidation). Only pages of this origin in
 * the same browser profile share the channel.
 *
 * A tab doesn't hear its own messages: it posts and listens through one
 * channel object, and a channel never delivers to itself.
 */
export type AuthEvent = 'signed-in' | 'signed-out';

/** The channel's name, the same in every tab. */
export const AUTH_CHANNEL = 'socio:auth';

const events: readonly unknown[] = ['signed-in', 'signed-out'];

let channel: BroadcastChannel | undefined;
const open = () => (channel ??= new BroadcastChannel(AUTH_CHANNEL));

/** Tells the other tabs that this tab signed in or out. */
export function postAuthEvent(event: AuthEvent) {
    open().postMessage(event);
}

/**
 * Calls `listener` for each event another tab posts; anything else on the
 * channel is ignored. Returns the unsubscribe.
 */
export function onAuthEvent(listener: (event: AuthEvent) => void) {
    const port = open();
    const handle = (message: MessageEvent) => {
        if (events.includes(message.data)) {
            listener(message.data as AuthEvent);
        }
    };
    port.addEventListener('message', handle);
    return () => port.removeEventListener('message', handle);
}

/** Closes the channel (tests; the next call opens a new one). */
export function closeAuthChannel() {
    channel?.close();
    channel = undefined;
}

const forgetters = new Set<() => void>();

/**
 * Registers what a module keeps for the visit (fetched attachments, for
 * instance), to drop when this tab signs out.
 */
export function forgetOnSignOut(forget: () => void) {
    forgetters.add(forget);
}

/** Drops what modules keep for the visit (the shell calls it on sign-out). */
export function forgetSessionMemory() {
    for (const forget of forgetters) {
        forget();
    }
}
