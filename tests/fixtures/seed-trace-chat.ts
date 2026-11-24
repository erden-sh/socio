// Testing only: two conversations for alice with one scripted Dot turn
// each (CB-72), for screenshots of how a turn's work shows in the chat.
// Before any @copilotkit module loads.
import '@socio/foundation/no-vendor-telemetry';
import { randomUUID } from 'node:crypto';

import { traceTurnEvents } from '../../packages/client/tests/fixtures/trace-turn.js';
import { LocalAgentRunner } from '../helpers/runners.js';
import { WorkspaceStore } from '../helpers/stores.js';

//   node --import tsx tests/fixtures/seed-trace-chat.ts <database>
//
// Run it on the database of a local server that has started once (it may
// be running). The turn reasons, searches the board and the pages, reads a
// page, runs a script in the computer, fails a query and answers. "Smoke
// trace" has its events stamped with times, as runs are stored now; "Smoke
// trace (old)" has none, as runs stored before CB-72.
const [database] = process.argv.slice(2);
if (!database) {
    console.error('usage: seed-trace-chat.ts <database>');
    process.exit(2);
}
const workspace = new WorkspaceStore(database);
const runner = new LocalAgentRunner(database);
try {
    const dot = workspace.dots()[0];
    if (!dot) {
        throw new Error('No Dot yet: start the server once first.');
    }
    const db = (runner as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    for (const [title, timed] of [
        ['Smoke trace (old)', false],
        ['Smoke trace', true],
    ] as const) {
        const threadId = randomUUID();
        const runId = randomUUID();
        workspace.bindThread(threadId, dot.id, title, 'alice');
        const startedAt = Date.now() - 60 * 60_000;
        const events = traceTurnEvents({ threadId, runId, startedAt, timed });
        db.prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, 'finished', ?, ?, ?, NULL)",
        ).run(threadId, runId, JSON.stringify(events), startedAt, startedAt + 41_000);
        console.log(`${title}: /chats/${threadId}`);
    }
} finally {
    runner.close();
    workspace.close();
}
