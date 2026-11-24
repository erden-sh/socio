import type {
    ActivityFacts,
    ApprovalFact,
    MemoryFact,
    ReactionFact,
    SpaceWriteFact,
} from '../../src/server/operations/infra/memory/activity.js';

import { PEOPLE, random, SOCIOS, type Seeded } from './seed-ops-runs.js';

// Activity's sources for a seeded database (CB-190): approvals with their
// requests' chats, reactions to socios' answers, pages made and edited,
// and memories kept in chats, written as the modules store them. Returns
// the facts it meant, in MemoryOpsReader's shape, with the dimensions'
// names.

const MINUTE = 60_000;
const CAPABILITIES = ['pages.write', 'data.create_dataset', 'web.post'];

export function seedOpsActivity(seeded: Seeded, seed = 11): ActivityFacts {
    const { db } = seeded;
    const rand = random(seed);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
    const approvals: ApprovalFact[] = [];
    const reactions: ReactionFact[] = [];
    const spaceWrites: SpaceWriteFact[] = [];
    const memories: MemoryFact[] = [];
    const request = db.prepare(
        `INSERT INTO approval_requests (id, userId, dotId, capability, summary, payload, threadId, status, createdAt, expiresAt)
    VALUES (?, ?, ?, ?, 'Do it', '{}', ?, 'pending', ?, ?)`,
    );
    const audit = db.prepare(
        `INSERT INTO approval_audit (id, userId, dotId, capability, requestId, event, actor, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 'person', ?)`,
    );
    const reaction = db.prepare(
        `INSERT OR IGNORE INTO message_reactions (threadId, messageId, userId, kind, createdAt) VALUES (?, ?, ?, ?, ?)`,
    );
    const page = db.prepare(
        `INSERT INTO pages (id, spaceId, title, content, revision, createdAt, updatedAt, sourceThreadId, createdBy)
    VALUES (?, ?, 'A page', '', 1, ?, ?, ?, ?)`,
    );
    const revision = db.prepare(
        `INSERT INTO page_revisions (pageId, spaceId, revision, title, body, encoding, authorId, createdAt, replacedAt)
    VALUES (?, ?, 1, 'A page', X'', 'utf8', ?, ?, ?)`,
    );
    const review = db.prepare(`INSERT INTO page_reviews (threadId, toolCallId, pageId, spaceId) VALUES (?, ?, ?, ?)`);
    const traceOf = db.prepare('SELECT trace FROM agent_runs WHERE runId = ?');
    const setTrace = db.prepare('UPDATE agent_runs SET trace = ? WHERE runId = ?');
    const memory = db.prepare(
        `INSERT INTO memories (id, text, createdAt, userId, status, source, threadId, confirmedAt)
    VALUES (?, 'A fact', ?, ?, ?, 'socio', ?, ?)`,
    );
    const pages: { id: string; spaceId: string }[] = [];
    let n = 0;
    db.exec('BEGIN');
    for (const turn of seeded.turns) {
        const chat = seeded.chats.find((c) => c.id === turn.threadId)!;
        if (chat.automation || turn.status === 'running') {
            continue;
        }
        const at = turn.finishedAt ?? turn.startedAt;
        const who = turn.personId ?? chat.ownerId;
        const roll = rand();
        if (roll < 0.25) {
            // A reaction to the answer, a few minutes on.
            const kind = pick(['up', 'up', 'up', 'down', 'retry', 'needs-work']);
            const when = at + Math.floor(rand() * 20 * MINUTE);
            const reactor = pick(chat.members.length ? chat.members : PEOPLE);
            reaction.run(turn.threadId, `a-${turn.runId}`, reactor, kind, when);
            reactions.push({
                threadId: turn.threadId,
                messageId: `a-${turn.runId}`,
                personId: reactor,
                kind,
                at: when,
            });
        } else if (roll < 0.4) {
            // An approval: decided, then carried out, failed or left to expire.
            const id = `req-${n++}`;
            const capability = pick(CAPABILITIES);
            request.run(id, who, turn.socioId, capability, turn.threadId, at, at + 60 * MINUTE);
            const end = rand();
            const events: [string, number][] = [['requested', at]];
            if (end < 0.2) {
                events.push(['expired', at + 60 * MINUTE]);
            } else if (end < 0.35) {
                events.push(['denied', at + 2 * MINUTE]);
            } else if (end < 0.45) {
                events.push(['auto_approved', at + MINUTE], ['failed', at + 2 * MINUTE]);
            } else {
                events.push(['approved', at + 3 * MINUTE], ['executed', at + 4 * MINUTE]);
            }
            for (const [event, when] of events) {
                const eventId = `aud-${n++}`;
                audit.run(eventId, who, turn.socioId, capability, id, event, when);
                approvals.push({
                    id: eventId,
                    at: when,
                    threadId: turn.threadId,
                    socioId: turn.socioId,
                    personId: who,
                    capability,
                    event,
                });
            }
        } else if (roll < 0.5) {
            // A page from the chat, as the app records each way of making one.
            const id = `page-${n++}`;
            const spaceId = SOCIOS.find((s) => s.id === turn.socioId)!.spaceId;
            const how = rand();
            if (how < 0.6) {
                // The socio's create_space_page, during its turn: made for the
                // chat's owner with no chat (page-tools.ts), the call in the trace.
                const startedAt = turn.startedAt + 600;
                const when = startedAt + 40;
                const row = traceOf.get(turn.runId) as { trace: string };
                const trace = JSON.parse(row.trace) as { tools: unknown[] };
                trace.tools.push({
                    kind: 'tool',
                    round: 1,
                    name: 'create_space_page',
                    startedAt,
                    endedAt: startedAt + 80,
                    outcome: 'ok',
                });
                setTrace.run(JSON.stringify(trace), turn.runId);
                turn.toolCalls = (turn.toolCalls ?? 0) + 1;
                seeded.tools.push({
                    runId: turn.runId,
                    threadId: turn.threadId,
                    socioId: turn.socioId,
                    spaceId,
                    source: turn.source,
                    personId: turn.personId,
                    tool: 'create_space_page',
                    outcome: 'ok',
                    startedAt,
                });
                page.run(id, spaceId, when, when, null, chat.ownerId);
                spaceWrites.push({
                    at: when,
                    spaceId,
                    pageId: id,
                    authorKind: 'socio',
                    authorId: turn.socioId,
                    threadId: turn.threadId,
                });
            } else {
                // Saved from the chat: the socio's draft a person approved
                // (page_reviews), or a person's "Save conversation as page".
                const reviewed = how < 0.8;
                const when = at + MINUTE;
                page.run(id, spaceId, when, when, turn.threadId, chat.ownerId);
                if (reviewed) {
                    review.run(turn.threadId, `call-${id}`, id, spaceId);
                }
                spaceWrites.push({
                    at: when,
                    spaceId,
                    pageId: id,
                    authorKind: reviewed ? 'socio' : 'person',
                    authorId: reviewed ? turn.socioId : chat.ownerId,
                    threadId: turn.threadId,
                });
            }
            pages.push({ id, spaceId });
        } else if (roll < 0.58 && pages.length) {
            // An edit, by the socio's page tool or a person.
            const target = pick(pages);
            const bySocio = rand() < 0.5;
            const when = at + 2 * MINUTE;
            revision.run(target.id, target.spaceId, bySocio ? `dot:${turn.socioId}` : who, when - MINUTE, when);
            spaceWrites.push({
                at: when,
                spaceId: target.spaceId,
                pageId: target.id,
                authorKind: bySocio ? 'socio' : 'person',
                authorId: bySocio ? turn.socioId : who,
                threadId: null,
            });
        } else if (roll < 0.64) {
            // A memory, kept at once or proposed and left.
            const id = `mem-${n++}`;
            const kept = rand() < 0.7;
            memory.run(id, at, who, kept ? 'active' : 'proposed', turn.threadId, kept ? at + 5 * MINUTE : null);
            memories.push({
                threadId: turn.threadId,
                status: kept ? 'active' : 'proposed',
                at: kept ? at + 5 * MINUTE : at,
                deletedAt: null,
            });
        }
    }
    // A person makes a page outside any chat.
    page.run('page-own', 'space-1', seeded.turns[0]!.startedAt, 0, null, 'alice');
    spaceWrites.push({
        at: seeded.turns[0]!.startedAt,
        spaceId: 'space-1',
        pageId: 'page-own',
        authorKind: 'person',
        authorId: 'alice',
        threadId: null,
    });
    db.exec('COMMIT');
    return {
        tools: seeded.tools,
        approvals,
        reactions,
        spaceWrites,
        memories,
        people: PEOPLE.map((id) => ({
            id,
            name: id[0]!.toUpperCase() + id.slice(1),
        })),
        socios: SOCIOS,
        spaces: ['space-1', 'space-2'].map((id) => ({
            id,
            name: id.toUpperCase(),
        })),
        chats: seeded.chats.map((chat) => ({
            id: chat.id,
            socioId: chat.socioId,
            ownerKind: PEOPLE.includes(chat.ownerId) ? 'person' : 'team',
        })),
    };
}
