import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { freeName, ownedList, type OwnedItem } from '@socio/shared/auth';

import type { ScheduleOwnershipShape } from '../../contract.js';

/**
 * A person's scheduled tasks, saved jobs and goals, and moving them to
 * another person (CB-360). A job's name is unique per person and socio
 * among live jobs: one the new owner has already is renamed (`name 2`).
 * Runs that happened stay attributed to whoever they ran for; a run in
 * progress finishes as it started.
 */
export function scheduleOwnership(db: DatabaseSync): ScheduleOwnershipShape {
    return {
        owned(userId) {
            const tasks = db
                .prepare(
                    "SELECT id, coalesce(nullif(title, ''), substr(prompt, 1, 80)) AS name, kind, deletedAt FROM tasks WHERE userId=? ORDER BY createdAt, id",
                )
                .all(userId) as { id: string; name: string; kind: string | null; deletedAt: number | null }[];
            const jobs = db
                .prepare('SELECT id, name, deletedAt FROM jobs WHERE userId=? ORDER BY createdAt, id')
                .all(userId) as { id: string; name: string; deletedAt: number | null }[];
            const goals = db
                .prepare('SELECT id, title AS name, status FROM goals WHERE userId=? ORDER BY createdAt, id')
                .all(userId) as { id: string; name: string; status: string }[];
            const items: OwnedItem[] = [
                ...goals.map((row) => ({ id: row.id, name: row.name, type: 'goal' })),
                ...tasks.map((row) => ({
                    id: row.id,
                    name: row.name,
                    type: 'task',
                    deleted: row.deletedAt !== null,
                })),
                ...jobs.map((row) => ({ id: row.id, name: row.name, type: 'job', deleted: row.deletedAt !== null })),
            ];
            return ownedList(items);
        },
        threadsOf(userId) {
            return (
                db
                    .prepare(
                        'SELECT DISTINCT t.threadId FROM task_threads t JOIN tasks k ON k.id=t.taskId WHERE k.userId=?',
                    )
                    .all(userId) as { threadId: string }[]
            ).map((row) => row.threadId);
        },
        transfer({ from, to }, paused) {
            return transactionSync(db, 'transfer schedules', () => {
                const now = Date.now();
                const notes: string[] = [];
                // Live jobs whose name the new owner uses for the same socio get
                // a free one, free of both people's names: the rename happens
                // while the job is still the old owner's.
                const names = (userId: string) =>
                    new Set(
                        (
                            db
                                .prepare('SELECT dotId, name FROM jobs WHERE userId=? AND deletedAt IS NULL')
                                .all(userId) as { dotId: string; name: string }[]
                        ).map((row) => `${row.dotId}\u0000${row.name}`),
                    );
                const theirs = names(to);
                const taken = new Set([...theirs, ...names(from)]);
                const live = db
                    .prepare(
                        'SELECT id, dotId, name FROM jobs WHERE userId=? AND deletedAt IS NULL ORDER BY createdAt, id',
                    )
                    .all(from) as { id: string; dotId: string; name: string }[];
                const rename = db.prepare('UPDATE jobs SET name=?, updatedAt=? WHERE id=?');
                let renamed = 0;
                for (const job of live) {
                    if (!theirs.has(`${job.dotId}\u0000${job.name}`)) {
                        continue;
                    }
                    const name = freeName(job.name, (candidate) => taken.has(`${job.dotId}\u0000${candidate}`));
                    taken.add(`${job.dotId}\u0000${name}`);
                    rename.run(name, now, job.id);
                    renamed++;
                    notes.push(`Job “${job.name}” is now “${name}”: the new owner has a job by that name.`);
                }
                const jobs = db.prepare('UPDATE jobs SET userId=?, updatedAt=? WHERE userId=?').run(to, now, from);
                if (paused) {
                    db.prepare('UPDATE tasks SET error=? WHERE userId=? AND error=?').run(
                        paused.becomes,
                        from,
                        paused.reason,
                    );
                }
                const tasks = db.prepare('UPDATE tasks SET userId=?, updatedAt=? WHERE userId=?').run(to, now, from);
                const goals = db.prepare('UPDATE goals SET userId=?, updatedAt=? WHERE userId=?').run(to, now, from);
                return {
                    moved: {
                        tasks: Number(tasks.changes),
                        jobs: Number(jobs.changes),
                        goals: Number(goals.changes),
                        ...(renamed ? { jobsRenamed: renamed } : {}),
                    },
                    notes,
                };
            });
        },
    };
}
