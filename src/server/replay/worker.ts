import { parentPort, workerData } from 'node:worker_threads';

import type { ReplayRequest, ReplayResponse } from './protocol.js';
import { ReplayCache } from './replay.js';

// The replay worker (CB-318): rebuilds conversations' messages from their
// stored runs off the main thread, with the AG-UI client's own replay, and
// keeps each one's last replay so the next replays only what came since.
// One request at a time, in order.

const cache = new ReplayCache((workerData as { maxBytes?: number } | undefined)?.maxBytes);
let queue = Promise.resolve();

parentPort?.on('message', (request: ReplayRequest) => {
    if (request.kind === 'forget') {
        cache.forget(request.key);
        return;
    }
    if (request.kind === 'forgetPrefix') {
        cache.forgetPrefix(request.prefix);
        return;
    }
    queue = queue.then(async () => {
        let response: ReplayResponse;
        try {
            const { messages, stats } = await cache.messages(request.key, request.threadId, request.rows);
            response = { id: request.id, ok: true, messages, stats };
        } catch (error) {
            response = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        parentPort?.postMessage(response);
    });
});
