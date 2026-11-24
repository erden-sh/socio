import { PassThrough, type Readable } from 'node:stream';

/**
 * How the app and `coding-git` send a request with metadata and a pack in
 * one body (CB-239): four bytes of length (big endian), that many
 * bytes of JSON, then the pack, streamed. Neither side
 * holds the pack in memory.
 */

export const MAX_FRAME_META = 4 * 1024 * 1024;

/** The header of a framed body: the length and the JSON. */
export function frameHead(meta: unknown) {
    const json = Buffer.from(JSON.stringify(meta), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json]);
}

/** A framed body as a web stream: the header, then `payload` if any. */
export function framed(meta: unknown, payload?: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> {
    const head = frameHead(meta);
    const reader = payload?.getReader();
    let sentHead = false;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (!sentHead) {
                sentHead = true;
                controller.enqueue(head);
                return;
            }
            if (!reader) {
                return controller.close();
            }
            const chunk = await reader.read();
            if (chunk.done) {
                controller.close();
            } else {
                controller.enqueue(chunk.value);
            }
        },
        async cancel(reason) {
            await reader?.cancel(reason);
        },
    });
}

/**
 * Reads a framed body: its metadata, and the rest as a stream. Throws when
 * the header is missing, too long or not JSON.
 */
export async function readFrame<T>(stream: Readable, maxMeta = MAX_FRAME_META): Promise<{ meta: T; rest: Readable }> {
    const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let buffer = Buffer.alloc(0);
    let need: number | undefined;
    for (;;) {
        if (need === undefined && buffer.length >= 4) {
            need = buffer.readUInt32BE(0);
            if (need > maxMeta) {
                throw new Error('The request’s header is too long.');
            }
        }
        if (need !== undefined && buffer.length >= 4 + need) {
            break;
        }
        const next = await iterator.next();
        if (next.done) {
            throw new Error('The request ended before its header.');
        }
        buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
    }
    const meta = JSON.parse(buffer.toString('utf8', 4, 4 + need)) as T;
    const rest = new PassThrough();
    const left = buffer.subarray(4 + need);
    // Back-pressure, and a consumer that stops early stops the pump.
    const room = () =>
        new Promise((resolve) => {
            rest.once('drain', resolve);
            rest.once('close', resolve);
        });
    void (async () => {
        try {
            if (left.length && !rest.write(left)) {
                await room();
            }
            while (!rest.destroyed) {
                const next = await iterator.next();
                if (next.done) {
                    break;
                }
                if (!rest.write(next.value)) {
                    await room();
                }
            }
            if (rest.destroyed) {
                await iterator.return?.();
            } else {
                rest.end();
            }
        } catch (error) {
            rest.destroy(error as Error);
        }
    })();
    return { meta, rest };
}
