/**
 * A plugin's ready snapshot over the protocol (CB-458), as the store reads
 * it: `GET /__cb/backup/{snapshotId}` for the `ready` answer, `GET
 * /__cb/backup/{snapshotId}/items/{index}` (with `?chunk=<n>` for a chunk)
 * for the bytes, and `DELETE /__cb/backup/{snapshotId}` at the end.
 *
 * `call` is the caller's: one host call to the plugin, with the host
 * envelope and the task pin (`PluginHostShape.hostTarget`). Begin, polling
 * and quiesce come with the scheduled run.
 */
import { PLUGIN_SNAPSHOT_ID, PluginSnapshotError } from '@socio/shared/plugins/plugin-snapshot';

import type { PluginSnapshotSource } from './plugin-store.js';

/** One host call to the plugin: its answer, as `fetch` gives it. */
export type PluginHostCall = (request: {
    method: 'GET' | 'DELETE';
    target: string;
    signal?: AbortSignal;
}) => Promise<Response>;

const empty: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
        // No body.
    },
};

const bodyOf = (response: Response): AsyncIterable<Uint8Array> =>
    (response.body as AsyncIterable<Uint8Array> | null) ?? empty;

export function httpSnapshotSource(snapshotId: string, call: PluginHostCall): PluginSnapshotSource {
    if (!PLUGIN_SNAPSHOT_ID.test(snapshotId)) {
        throw new PluginSnapshotError('A snapshot id is a ULID.');
    }
    const base = `/__cb/backup/${snapshotId}`;
    const get = async (target: string, what: string, signal: AbortSignal) => {
        const response = await call({ method: 'GET', target, signal });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new PluginSnapshotError(`The plugin answered ${response.status} for ${what}.`);
        }
        return bodyOf(response);
    };
    return {
        manifest: (signal) => get(base, 'its snapshot', signal),
        item: (index, chunk, signal) =>
            get(
                `${base}/items/${index}${chunk === undefined ? '' : `?chunk=${chunk}`}`,
                chunk === undefined ? `item ${index}` : `item ${index} chunk ${chunk}`,
                signal,
            ),
        async end(signal) {
            const response = await call({ method: 'DELETE', target: base, signal });
            await response.body?.cancel().catch(() => undefined);
            // Already gone (its lease ran out) is ended too.
            if (!response.ok && response.status !== 404) {
                throw new PluginSnapshotError(`The plugin answered ${response.status} to ending its snapshot.`);
            }
        },
    };
}
