import { createReadStream } from 'node:fs';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';

import { SEALED_START, type SecretBox } from './secret-box.js';

/** How much of a file a seal or an open holds at once. */
const CHUNK = 1024 * 1024;
/** The GCM tag's length. */
const TAG = 16;

/**
 * All of `data` written to `file`, at `position` or where the last write
 * ended: a write may take fewer bytes than it was given (a full disk, a
 * file size limit), so it goes on until every byte is down and fails when
 * one can't be (CB-378).
 */
export async function writeAll(file: FileHandle, data: Uint8Array, position?: number) {
    let done = 0;
    while (done < data.length) {
        const { bytesWritten } = await file.write(
            data,
            done,
            data.length - done,
            position === undefined ? null : position + done,
        );
        if (bytesWritten <= 0) {
            throw Object.assign(new Error('A write stopped short.'), { code: 'EIO' });
        }
        done += bytesWritten;
    }
}

/**
 * `box.sealBytes` from file to file, a chunk at a time (CB-378): the same
 * format, but memory stays flat however large the file. The tag goes in
 * its place once the whole file is read. `output` is created 0600
 * (replaced when it exists). Returns the sealed size.
 */
export async function sealFile(box: SecretBox, input: string, output: string, context: string): Promise<number> {
    const { start, cipher } = box.beginSeal(context);
    const out = await open(output, 'w', 0o600);
    try {
        await out.chmod(0o600);
        // The tag's place, filled once it is known.
        await writeAll(out, Buffer.concat([start, Buffer.alloc(TAG)]));
        let size = start.length + TAG;
        for await (const chunk of createReadStream(input, { highWaterMark: CHUNK })) {
            const body = cipher.update(chunk as Buffer);
            await writeAll(out, body);
            size += body.length;
        }
        const last = cipher.final();
        if (last.length) {
            await writeAll(out, last);
            size += last.length;
        }
        await writeAll(out, cipher.getAuthTag(), start.length);
        return size;
    } finally {
        await out.close();
    }
}

/**
 * `box.openBytes` from file to file, a chunk at a time (CB-378). Written
 * to `<output>.partial` (0600) first: `output` appears only once the tag
 * checks out, so a damaged or swapped file leaves nothing behind.
 */
export async function openFile(box: SecretBox, input: string, output: string, context: string): Promise<void> {
    const source = await open(input, 'r');
    const partial = `${output}.partial`;
    try {
        const head = Buffer.alloc(SEALED_START);
        const { bytesRead } = await source.read(head, 0, head.length, 0);
        const { decipher, body } = box.beginOpen(head.subarray(0, bytesRead), context);
        const out = await open(partial, 'w', 0o600);
        try {
            await out.chmod(0o600);
            const chunks = source.createReadStream({ start: body, highWaterMark: CHUNK, autoClose: false });
            for await (const chunk of chunks) {
                await writeAll(out, decipher.update(chunk as Buffer));
            }
            await writeAll(out, decipher.final());
        } finally {
            await out.close();
        }
        await rename(partial, output);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    } finally {
        await source.close();
    }
}
