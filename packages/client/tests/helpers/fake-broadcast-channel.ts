/**
 * A BroadcastChannel stand-in for tests: channels with the same name
 * deliver to each other (never to themselves), asynchronously, with a
 * structured clone of the message, as browsers do. `FakeBroadcastChannel
 * .posted` records every message by channel name.
 */
export class FakeBroadcastChannel extends EventTarget {
    static open = new Set<FakeBroadcastChannel>();
    static posted: { name: string; data: unknown }[] = [];
    static reset() {
        FakeBroadcastChannel.open.clear();
        FakeBroadcastChannel.posted = [];
    }

    onmessage: ((event: MessageEvent) => void) | null = null;
    private closed = false;

    constructor(readonly name: string) {
        super();
        FakeBroadcastChannel.open.add(this);
    }

    postMessage(data: unknown) {
        if (this.closed) {
            throw new DOMException('Channel closed', 'InvalidStateError');
        }
        FakeBroadcastChannel.posted.push({ name: this.name, data });
        const copy = structuredClone(data);
        for (const other of FakeBroadcastChannel.open) {
            if (other !== this && other.name === this.name) {
                setTimeout(() => other.deliver(copy), 0);
            }
        }
    }

    private deliver(data: unknown) {
        if (this.closed) {
            return;
        }
        const event = new MessageEvent('message', { data });
        this.onmessage?.(event);
        this.dispatchEvent(event);
    }

    close() {
        this.closed = true;
        FakeBroadcastChannel.open.delete(this);
    }
}
