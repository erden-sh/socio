// Testing only: a long conversation for alice shaped like the CRM
// Analyst's (CB-136: 32 turns, about 1.5 MB, tool results up to 250 KB),
// to measure how fast a long chat opens and to screenshot its paging.
// Before any @copilotkit module loads.
import '@socio/foundation/no-vendor-telemetry';
import { LocalAgentRunner } from '../helpers/runners.js';
import { WorkspaceStore } from '../helpers/stores.js';

import { longChatRuns } from './long-chat.js';

//   node --import tsx tests/fixtures/seed-long-chat.ts <database> [thread id]
//
// Run it on the database of a local server that has started once (it may
// be running). Prints the chat's path.
const [database, threadId = 'long-chat'] = process.argv.slice(2);
if (!database) {
    console.error('usage: seed-long-chat.ts <database> [thread id]');
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
    workspace.bindThread(threadId, dot.id, 'Pipeline review', 'alice');
    for (const run of longChatRuns({ threadId })) {
        db.prepare(
            "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, 'finished', ?, ?, ?, NULL)",
        ).run(threadId, `${threadId}-${run.runId}`, JSON.stringify(run.events), run.startedAt, run.finishedAt);
    }
    console.log(`Pipeline review: /chats/${threadId}`);
} finally {
    runner.close();
    workspace.close();
}
