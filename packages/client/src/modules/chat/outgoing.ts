import type { Message } from '@ag-ui/core';

/**
 * A message of yours the server doesn't have yet (CB-154): `sending` until
 * its turn starts, or `failed`, never taken, its text kept for a retry or
 * to edit. Shown in its place in the transcript either way, so it neither
 * vanishes while its request is out nor when it fails.
 */
export interface Outgoing {
    message: Message;
    /** What was typed, for the composer when it is taken back to edit. */
    text: string;
    status: 'sending' | 'failed';
    /** The message shown before it when it was sent; none: the first. */
    after?: string;
}

/**
 * The transcript with each outgoing message that `messages` doesn't have
 * (one never sent leaves the agent, so the next turn doesn't carry it)
 * after the message it followed, or at the end once that is gone; the
 * same list when there are none.
 */
export function placeOutgoing(messages: readonly Message[], outgoing: readonly Outgoing[]): readonly Message[] {
    // Nothing pending (every streamed token): the same list, not a copy.
    if (!outgoing.length) {
        return messages;
    }
    const shown = new Set(messages.map((message) => message.id));
    const missing = outgoing.filter((item) => !shown.has(item.message.id));
    if (!missing.length) {
        return messages;
    }
    const placed = missing.filter((item) => item.after === undefined || shown.has(item.after));
    const result: Message[] = [];
    const after = (id: string | undefined) => {
        for (const item of placed) {
            if (item.after === id) {
                result.push(item.message);
            }
        }
    };
    after(undefined);
    for (const message of messages) {
        result.push(message);
        after(message.id);
    }
    for (const item of missing) {
        if (!placed.includes(item)) {
            result.push(item.message);
        }
    }
    return result;
}
