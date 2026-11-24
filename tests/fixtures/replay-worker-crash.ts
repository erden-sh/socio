// The replay worker (CB-318) with two faults for tests: a request for the
// thread 'crash' stops the worker, one for 'hang' never returns. Others
// go to the real worker, which registered its listener first.
import { parentPort } from 'node:worker_threads';

import '../../src/server/replay/worker.js';

parentPort?.on('message', (request: { kind: string; threadId?: string }) => {
    if (request.kind !== 'messages') {
        return;
    }
    if (request.threadId === 'crash') {
        process.exit(3);
    }
    if (request.threadId === 'hang') {
        for (;;) {
            // Busy forever: only terminate() stops it.
        }
    }
});
