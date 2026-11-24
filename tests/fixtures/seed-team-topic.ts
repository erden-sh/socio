// Testing only: a Telegram team topic for the `chat` smoke scenario
// (CB-73), without Telegram. Before any @copilotkit module loads.
import '@socio/foundation/no-vendor-telemetry';
import { randomUUID } from 'node:crypto';

import { teamOwner } from '@socio/foundation/telegram/team-owner';
import { SENDER_METADATA } from '@socio/shared/types';

import { LocalAgentRunner } from '../helpers/runners.js';
import { WorkspaceStore } from '../helpers/stores.js';

//   node --import tsx tests/fixtures/seed-team-topic.ts <database> [member…]
//
// Run it on the database of a local server that has started once (it may
// be running). It binds forum topic 7 of a made-up group chat to the
// first Dot, as the Telegram channel does, records the members (default:
// alice and bob) as having spoken there, and stores one finished turn:
// bob asks and the Dot answers. Running it again changes nothing.
const [database, ...given] = process.argv.slice(2);
if (!database) {
    console.error('usage: seed-team-topic.ts <database> [member…]');
    process.exit(2);
}
const members = given.length ? given : ['alice', 'bob'];
const chatId = '-1005550000073';
const key = `tg:${chatId}:topic:7`;
const workspace = new WorkspaceStore(database);
const runner = new LocalAgentRunner(database);
try {
    const existing = await workspace.telegram.threadFor(key);
    const threadId = existing ?? randomUUID();
    if (!existing) {
        const dot = workspace.dots()[0];
        if (!dot) {
            throw new Error('No Dot yet: start the server once first.');
        }
        workspace.bindThread(threadId, dot.id, 'Smoke team topic', teamOwner(chatId));
        await workspace.telegram.bindThread(key, threadId, 'topic', chatId, '7');
        const runId = randomUUID();
        const now = Date.now();
        const events = [
            {
                type: 'RUN_STARTED',
                threadId,
                runId,
                input: {
                    threadId,
                    runId,
                    state: {},
                    tools: [],
                    context: [],
                    forwardedProps: {},
                    messages: [
                        {
                            id: randomUUID(),
                            role: 'user',
                            content: 'What is on the team agenda?',
                            metadata: { [SENDER_METADATA]: members.at(-1) },
                        },
                    ],
                },
            },
            { type: 'TEXT_MESSAGE_START', messageId: runId, role: 'assistant' },
            {
                type: 'TEXT_MESSAGE_CONTENT',
                messageId: runId,
                delta: 'The smoke team topic agenda: plan the offsite.',
            },
            { type: 'TEXT_MESSAGE_END', messageId: runId },
            { type: 'RUN_FINISHED', threadId, runId },
        ];
        (runner as unknown as { db: import('node:sqlite').DatabaseSync }).db
            .prepare(
                "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, 'finished', ?, ?, ?, 'telegram')",
            )
            .run(threadId, runId, JSON.stringify(events), now, now);
    }
    for (const member of members) {
        await workspace.telegram.recordMember(chatId, member);
    }
    console.log(`team topic ${threadId}: ${members.join(', ')}`);
} finally {
    runner.close();
    workspace.close();
}
