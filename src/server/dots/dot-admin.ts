import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { z } from 'zod';

import { LIVE } from '@socio/data/soft-delete';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { DotActivity, DotAdminDetail, DotAdminRow } from '@socio/shared/dot-admin-types';
import { issueKey } from '@socio/shared/issues/issue-types';
import { isRoomOwnerId } from '@socio/shared/rooms/rooms';

import type { ApprovalsShape } from '../approvals/contract.js';
import type { ComputerRecordsShape } from '../computers/contract.js';
import type { BoardShape } from '../issues/contract.js';
import type { RoomsShape } from '../rooms/contract.js';
import type { GoalsShape, JobsShape } from '../schedules/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import type { WebReaderShape } from '../web/contract.js';
import type { PeopleShape, SociosShape, SpacesShape } from '../workspace/contract.js';

/**
 * What the admins' view of the socios reads, each a slice of its feature's
 * contract. The workspace routes pass them, from the graph's tags.
 */
export interface DotAdminSources {
    readonly workspace: Pick<SociosShape, 'dot' | 'allDots'> &
        Pick<PeopleShape, 'users'> &
        Pick<SpacesShape, 'spaces'> & {
            /** The workspace connection: the audit tables this view reads directly. */
            readonly db: DatabaseSync;
            readonly computers: Pick<ComputerRecordsShape, 'activity'>;
        };
    /** The Board (issues), typed by its contract. */
    readonly board: Pick<BoardShape, 'filings' | 'issues'>;
    readonly approvals: Pick<ApprovalsShape, 'dotActivity'>;
    readonly goals: Pick<GoalsShape, 'forDot' | 'lastDotGoalAt'>;
    readonly jobs: Pick<JobsShape, 'dotRuns' | 'lastDotRunAt'>;
    readonly rooms: Pick<RoomsShape, 'members'>;
    readonly runner: Pick<RunnerShape, 'runsOfThreads' | 'runTrace'>;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));

/**
 * What admins see of every Dot, the company's and each person's own (the
 * Dots admin page): settings, owner, use, and an audit merged from every log
 * that names the Dot. Metadata only: no chat, page or data contents.
 */
export class DotAdmin {
    constructor(
        private platform: DotAdminSources,
        /** The workspace's web reader (`WebReader`): its audit lines. */
        private web: Pick<WebReaderShape, 'activity'>,
    ) {}

    private get db() {
        return this.platform.workspace.db;
    }
    private has(table: string) {
        return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    }
    private threads(dotId: string) {
        return this.db
            .prepare(
                `SELECT id, ownerId, createdAt FROM thread_bindings WHERE dotId=? AND ${LIVE} ORDER BY createdAt DESC`,
            )
            .all(dotId)
            .map((row) => ({
                id: String(row.id),
                ownerId: String(row.ownerId),
                createdAt: Number(row.createdAt),
            }));
    }

    /**
     * A Dot's activity, newest first, before `before` (ms): its settings,
     * turns, board filings, comments and votes, approvals, computer, web and data actions, job
     * runs and goals, each with who acted and for whom.
     */
    async activity(
        dotId: string,
        { before = Number.MAX_SAFE_INTEGER, skip = 0, limit = 100 } = {},
    ): Promise<{
        lines: DotActivity[];
        next: { before: number; skip: number } | null;
    }> {
        const lines: DotActivity[] = [];
        // Each source's newest lines at or before the cursor: enough to fill a
        // page after skipping the ones at `before` already shown.
        const take = limit + skip + 1;
        const read = (table: string, sql: string, map: (row: Row) => DotActivity) => {
            if (!this.has(table)) {
                return;
            }
            for (const row of this.db.prepare(sql).all(dotId, before, take)) {
                lines.push(map(row));
            }
        };
        read(
            'dot_audit',
            'SELECT actor, action, detail, createdAt AS at FROM dot_audit WHERE dotId=? AND createdAt<=? ORDER BY createdAt DESC LIMIT ?',
            (row) => ({
                at: Number(row.at),
                kind: 'settings',
                actor: text(row.actor),
                onBehalfOf: null,
                summary: `${row.action === 'create' ? 'created' : `${row.action}d`}${row.detail ? `: ${row.detail}` : ''}`,
            }),
        );
        // Board filings, comments and votes (CB-31, CB-83, CB-84).
        const BOARD: Record<string, [DotActivity['kind'], string]> = {
            create: ['filing', 'filed'],
            comment: ['comment', 'commented on'],
            vote: ['vote', 'voted for'],
            unvote: ['vote', 'withdrew the vote on'],
            update: ['issue', 'updated dependencies on'],
        };
        // Through the Board's port (CB-110): its actions, then the items'
        // numbers and titles, deleted items' too.
        const { filings, issues } = this.platform.board;
        const actions = await filings.activity(dotId, before, take);
        const items = await issues.titlesById(
            actions.map((row) => row.issueId),
            { deleted: true },
        );
        for (const row of actions) {
            const [kind, verb] = BOARD[row.action] ?? BOARD.create!;
            const item = items.get(row.issueId);
            lines.push({
                at: row.createdAt,
                kind,
                actor: `dot:${dotId}`,
                onBehalfOf: row.userId,
                summary: `${verb} ${item ? issueKey(item.number) : 'an item'}${item?.title ? ` “${item.title}”` : ''} (${row.trigger}${row.causeId ? ` ${row.causeId}` : ''})`,
            });
        }
        // Through the approvals' port (CB-110).
        for (const row of await this.platform.approvals.dotActivity(dotId, before, take)) {
            lines.push({
                at: row.createdAt,
                kind: 'approval',
                actor: row.actor,
                onBehalfOf: row.userId,
                summary: `${row.capability}: ${row.event}`,
            });
        }
        // Through the computers' and web reads' ports (CB-110).
        if (this.has('computer_audit')) {
            for (const row of await this.platform.workspace.computers.activity(dotId, before, take)) {
                lines.push({
                    at: row.createdAt,
                    kind: 'computer',
                    actor: row.actor,
                    onBehalfOf: row.userId,
                    summary: `${row.action}: ${row.outcome}`,
                });
            }
        }
        if (this.has('web_audit')) {
            for (const row of await this.web.activity(dotId, before, take)) {
                lines.push({
                    at: row.createdAt,
                    kind: 'web',
                    actor: `dot:${dotId}`,
                    onBehalfOf: row.userId,
                    summary: `${row.method} ${row.host}${row.path} → ${row.status ?? row.outcome}`,
                });
            }
        }
        read(
            'data_audit',
            'SELECT ownerUserId, actorKind, actorId, action, target, outcome, createdAt AS at FROM data_audit WHERE dotId=? AND createdAt<=? ORDER BY createdAt DESC LIMIT ?',
            (row) => ({
                at: Number(row.at),
                kind: 'data',
                actor: row.actorKind === 'user' ? text(row.actorId) : `dot:${dotId}`,
                onBehalfOf: text(row.ownerUserId),
                summary: `${row.action}${row.target ? ` ${row.target}` : ''}: ${row.outcome}`,
            }),
        );
        // Job runs and goals through the Scheduling context's ports (CB-110);
        // a goal's status follows its schedule.
        for (const run of await this.platform.jobs.dotRuns(dotId, before, take)) {
            lines.push({
                at: run.queuedAt,
                kind: 'job',
                actor: `dot:${dotId}`,
                onBehalfOf: run.userId,
                summary: `job run ${run.status} (${run.trigger})`,
            });
        }
        for (const goal of await this.platform.goals.forDot(dotId)) {
            if (goal.createdAt <= before) {
                lines.push({
                    at: goal.createdAt,
                    kind: 'goal',
                    actor: goal.userId,
                    onBehalfOf: goal.userId,
                    summary: `goal ${goal.id} set (now ${goal.status})`,
                });
            }
        }
        const owners = new Map(this.threads(dotId).map((thread) => [thread.id, thread.ownerId]));
        for (const run of this.platform.runner.runsOfThreads([...owners.keys()], {
            before,
            limit: take,
        })) {
            const owner = owners.get(run.threadId) ?? null;
            lines.push({
                at: Number(run.startedAt),
                kind: 'turn',
                actor: `dot:${dotId}`,
                // A room's turn acted for the person whose message started it,
                // never the room's sentinel owner (CB-213).
                onBehalfOf: owner && isRoomOwnerId(owner) ? this.initiator(run.runId) : owner,
                summary: `turn ${run.status} (${run.source ?? 'web'})`,
            });
        }
        // A fixed order, ties included, so a page boundary inside one
        // millisecond falls in the same place on the next request.
        const order = (line: DotActivity) =>
            `${line.kind}\u0000${line.summary}\u0000${line.actor ?? ''}\u0000${line.onBehalfOf ?? ''}`;
        lines.sort((a, b) => b.at - a.at || order(a).localeCompare(order(b)));
        let dropped = 0;
        const rest = lines.filter((line) => !(line.at === before && dropped++ < skip));
        const page = rest.slice(0, limit);
        const last = page.at(-1);
        if (rest.length <= limit || !last) {
            return { lines: page, next: null };
        }
        const atLast = page.filter((line) => line.at === last.at).length;
        return {
            lines: page,
            next: {
                before: last.at,
                skip: atLast + (last.at === before ? skip : 0),
            },
        };
    }

    /** The person whose message started a turn (its trace's trigger), if any. */
    private initiator(runId: string): string | null {
        const trigger = this.platform.runner.runTrace(runId)?.trace?.trigger;
        return trigger?.kind === 'person' ? (trigger.id ?? null) : null;
    }

    /**
     * The people with chats with a socio: each private chat's owner, a team
     * topic as one, and a room's active members (CB-213), never its
     * sentinel owner (`room:<id>`), which is no person.
     */
    private async people(threads: readonly { id: string; ownerId: string }[]) {
        const people = new Set<string>();
        for (const thread of threads) {
            if (!isRoomOwnerId(thread.ownerId)) {
                people.add(thread.ownerId);
            } else {
                for (const member of await this.platform.rooms.members(thread.id)) {
                    if (member.status === 'active') {
                        people.add(member.userId);
                    }
                }
            }
        }
        return people.size;
    }

    /** The newest activity time over every source: one MAX each, indexed. */
    private async lastActivity(dotId: string, threadIds: string[]): Promise<number | null> {
        const sources: Array<[string, string]> = [
            ['dot_audit', 'createdAt'],
            ['issue_dot_actions', 'createdAt'],
            ['approval_audit', 'createdAt'],
            ['computer_audit', 'createdAt'],
            ['web_audit', 'createdAt'],
            ['data_audit', 'createdAt'],
        ];
        let newest: number | null = null;
        for (const [table, column] of sources) {
            if (!this.has(table)) {
                continue;
            }
            const row = this.db.prepare(`SELECT MAX(${column}) AS at FROM ${table} WHERE dotId=?`).get(dotId) as Row;
            if (row.at !== null && (newest === null || Number(row.at) > newest)) {
                newest = Number(row.at);
            }
        }
        // Job runs and goals through the Scheduling context's ports (CB-110).
        for (const at of [
            await this.platform.jobs.lastDotRunAt(dotId),
            await this.platform.goals.lastDotGoalAt(dotId),
        ]) {
            if (at !== null && (newest === null || at > newest)) {
                newest = at;
            }
        }
        const run = this.platform.runner.runsOfThreads(threadIds, { limit: 1 })[0];
        if (run && (newest === null || run.startedAt > newest)) {
            newest = run.startedAt;
        }
        return newest;
    }

    private async row(dotId: string): Promise<DotAdminRow | undefined> {
        const dot = this.platform.workspace.dot(dotId);
        if (!dot) {
            return undefined;
        }
        const threads = this.threads(dotId);
        const owner = dot.ownerId ? this.platform.workspace.users().find((user) => user.id === dot.ownerId) : undefined;
        return {
            dot,
            ownerName: dot.ownerId ? (owner?.name ?? dot.ownerId) : null,
            conversations: threads.length,
            people: await this.people(threads),
            lastActivityAt: await this.lastActivity(
                dotId,
                threads.map((t) => t.id),
            ),
        };
    }

    /** Every Dot, archived ones too: company Dots first, then everyone's. */
    async list(): Promise<DotAdminRow[]> {
        const rows: DotAdminRow[] = [];
        for (const dot of this.platform.workspace.allDots()) {
            const row = await this.row(dot.id);
            if (row) {
                rows.push(row);
            }
        }
        return rows;
    }

    async detail(dotId: string, cursor: { before?: number; skip?: number } = {}): Promise<DotAdminDetail | undefined> {
        const row = await this.row(dotId);
        if (!row) {
            return undefined;
        }
        const { workspace } = this.platform;
        const { lines: activity, next } = await this.activity(dotId, cursor);
        const conversations = this.threads(dotId);
        const goals = await this.platform.goals.forDot(dotId);
        const filings = await this.platform.board.filings.filedCount(dotId);
        const users = new Map(workspace.users().map((u) => [u.id, u.name]));
        const ids = new Set<string>(
            [
                ...activity.flatMap((line) => [line.actor, line.onBehalfOf]),
                ...conversations.map((thread) => thread.ownerId),
                ...(row.dot.archivedBy ? [row.dot.archivedBy] : []),
            ].filter((id): id is string => !!id),
        );
        return {
            row,
            spaces: workspace
                .spaces()
                .filter((space) => row.dot.spaceIds.includes(space.id))
                .map(({ id, name }) => ({ id, name })),
            conversations,
            goals: {
                active: goals.filter((goal) => goal.status === 'active').length,
                total: goals.length,
            },
            filings,
            activity,
            next,
            users: Object.fromEntries(
                [...ids].map((id) => [
                    id,
                    users.get(id) ??
                        (id.startsWith('dot:')
                            ? (workspace.dot(id.slice(4))?.name ?? 'A socio')
                            : isRoomOwnerId(id)
                              ? 'A room'
                              : id),
                ]),
            ),
        };
    }
}

/** `/api/admin/dots`: admins only. */
export function dotAdminRoutes(platform: DotAdminSources, web: Pick<WebReaderShape, 'activity'>) {
    const app = new Hono<AppEnv>();
    const admin = new DotAdmin(platform, web);
    app.use('/admin/dots', requireAdmin);
    app.use('/admin/dots/*', requireAdmin);
    app.get('/admin/dots', async (c) => c.json({ dots: await admin.list() }));
    app.get('/admin/dots/:id', async (c) => {
        const cursor = z
            .object({
                before: z.coerce.number().int().positive().optional(),
                skip: z.coerce.number().int().min(0).max(10_000).optional(),
            })
            .safeParse({
                before: c.req.query('before') || undefined,
                skip: c.req.query('skip') || undefined,
            });
        const detail = await admin.detail(c.req.param('id'), cursor.success ? cursor.data : {});
        return detail ? c.json(detail) : c.json({ error: 'Socio not found.' }, 404);
    });
    return app;
}
