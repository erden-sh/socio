import { pktLine } from '@socio/foundation/github/pkt-lines';

/**
 * Git's pkt-line framing over a web stream (CB-239): read one line at
 * a time from a request or a response without holding the rest, and hand
 * what is left on as a stream (a push's pack after its commands).
 */

export { pktLine };
export const FLUSH = Buffer.from('0000', 'ascii');

export class PktError extends Error {}

export class PktReader {
    private buffer = Buffer.alloc(0);
    private done = false;
    private read = 0;
    constructor(
        private reader: ReadableStreamDefaultReader<Uint8Array>,
        /** The most `next` may read in all, before `rest`. */
        private limit = Infinity,
    ) {}

    private async fill(size: number) {
        while (this.buffer.length < size && !this.done) {
            const chunk = await this.reader.read();
            if (chunk.done) {
                this.done = true;
                break;
            }
            this.read += chunk.value.length;
            if (this.read > this.limit) {
                throw new PktError('Too many pkt-lines.');
            }
            this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk.value)]);
        }
        return this.buffer.length >= size;
    }

    /**
     * The next pkt-line's payload; null for a flush (`0000`), `delim` and
     * `end` for protocol v2's `0001` and `0002`; undefined at the end of the
     * stream. Throws on a malformed length.
     */
    async next(): Promise<Buffer | null | 'delim' | 'end' | undefined> {
        if (!(await this.fill(4))) {
            if (this.buffer.length) {
                throw new PktError('A pkt-line was cut short.');
            }
            return undefined;
        }
        const text = this.buffer.toString('ascii', 0, 4);
        if (!/^[0-9a-f]{4}$/.test(text)) {
            throw new PktError('Not a pkt-line.');
        }
        const length = Number.parseInt(text, 16);
        if (length === 0 || length === 1 || length === 2) {
            this.buffer = this.buffer.subarray(4);
            return length === 0 ? null : length === 1 ? 'delim' : 'end';
        }
        if (length < 4) {
            throw new PktError('Not a pkt-line.');
        }
        if (!(await this.fill(length))) {
            throw new PktError('A pkt-line was cut short.');
        }
        const payload = Buffer.from(this.buffer.subarray(4, length));
        this.buffer = this.buffer.subarray(length);
        return payload;
    }

    /** Whatever follows, unread, as a stream (the buffered bytes first). */
    rest(): ReadableStream<Uint8Array> {
        let left: Buffer | undefined = this.buffer.length ? this.buffer : undefined;
        this.buffer = Buffer.alloc(0);
        const reader = this.reader;
        const done = this.done;
        return new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (left) {
                    controller.enqueue(left);
                    left = undefined;
                    return;
                }
                if (done) {
                    return controller.close();
                }
                const chunk = await reader.read();
                if (chunk.done) {
                    controller.close();
                } else {
                    controller.enqueue(chunk.value);
                }
            },
            cancel(reason) {
                return reader.cancel(reason);
            },
        });
    }

    cancel() {
        return this.reader.cancel().catch(() => undefined);
    }
}

/**
 * The payloads of side-band channel 1 of a response (a pack), as a
 * stream; channel 2 (progress) dropped, channel 3 (an error) fails it.
 * Stops at the flush that ends the side-band.
 */
export function sideBandData(reader: PktReader, first?: Buffer): ReadableStream<Uint8Array> {
    let pending = first;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            for (;;) {
                const line = pending ?? (await reader.next());
                pending = undefined;
                if (line === undefined || line === null || typeof line === 'string') {
                    return controller.close();
                }
                const band = line[0];
                if (band === 1) {
                    controller.enqueue(line.subarray(1));
                    return;
                }
                if (band === 3) {
                    return controller.error(new PktError('GitHub reported an error.'));
                }
            }
        },
        cancel() {
            return reader.cancel();
        },
    });
}

/** `payload` in side-band channel `band`, in pkt-lines of at most 65519 bytes. */
export function sideBand(band: 1 | 2 | 3, payload: Buffer) {
    const lines: Buffer[] = [];
    for (let at = 0; at < payload.length || at === 0; at += 65515) {
        const part = payload.subarray(at, at + 65515);
        const data = Buffer.concat([Buffer.from([band]), part]);
        lines.push(Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii'), data);
        if (!payload.length) {
            break;
        }
    }
    return Buffer.concat(lines);
}
