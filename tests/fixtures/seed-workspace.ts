// Before any @copilotkit module loads: no vendor telemetry from the bench.
import '@socio/foundation/no-vendor-telemetry';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrateDatabase } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';
import type { User } from '@socio/shared/types';

import type { AppWorkspace as WorkspaceStore } from '../../src/server/composition/workspace-parts.js';
import type { AppEdge } from '../../src/server/main.js';
import { schemas } from '../../src/server/modules/index.js';
import type { Config } from '../../src/server/web/research.js';
import type { PageViews } from '../../src/server/web/services.js';
import { testPageViews } from '../helpers/page-views.js';
import { LocalAgentRunner } from '../helpers/runners.js';
import type { Store } from '../helpers/stores.js';
import type { TestPlatform } from '../helpers/test-platform.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

import { PNG } from './media.js';

/**
 * A throwaway workspace the size of a 200-person team after a year, for
 * the page loader budget. The sizes
 * are the bench's defaults and can be raised. Everything is made the way
 * the app makes it: through the stores where they take the values, and
 * with plain inserts into the same tables where only a running agent
 * would write (runs, approvals, job runs). Media files are written
 * through the data space as uploads are, each a tiny real file of its
 * type, so their content (thumbnails) can be served (CB-69).
 *
 * Per-user data is not spread evenly. The two bench users, the first
 * admin and the first member, each own a tenth of it (a heavy user), the
 * rest share what is left. Content comes from a seeded generator, so two
 * runs make the same sizes.
 */
export const SEED_SIZES = {
    users: 200,
    admins: 10,
    dots: 40,
    spaces: 12,
    pages: 2000,
    pageBytes: 4000,
    conversations: 5000,
    tasks: 600,
    issues: 3000,
    comments: 15000,
    approvals: 300,
    schedules: 150,
    jobRuns: 2000,
    agentRuns: 20000,
    datasets: 60,
    mediaFiles: 20000,
    mediaFolders: 400,
    memories: 500,
    proposals: 300,
};
export type SeedSizes = typeof SEED_SIZES;

const DAY = 86_400_000;
/** The seed's "now": a fixed day, so times have the same digits each run. */
export const SEED_NOW = Date.UTC(2026, 9, 1, 12);

/** A small seeded generator (mulberry32). */
function generator(seed: number) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (max: number) => Math.floor(next() * max);
    const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
    return { next, int, pick };
}

const WORDS =
    'plan launch review customer budget invoice roadmap meeting hiring vendor contract policy release report quarter metrics design research notes onboarding support ticket pricing travel offsite security audit backup migration feedback survey forecast pipeline partner renewal training campaign'.split(
        ' ',
    );

function writer(seed: number) {
    const random = generator(seed);
    const words = (count: number) => Array.from({ length: count }, () => random.pick(WORDS)).join(' ');
    const title = (count = 4) => {
        const text = words(count);
        return text[0]!.toUpperCase() + text.slice(1);
    };
    /** Markdown of about `bytes` characters: headings, paragraphs, lists. */
    const markdown = (bytes: number) => {
        const parts: string[] = [];
        let size = 0;
        while (size < bytes) {
            const part =
                parts.length % 5 === 0
                    ? `## ${title(3)}`
                    : parts.length % 5 === 3
                      ? Array.from({ length: 4 }, () => `- ${words(6)}`).join('\n')
                      : `${title(1)} ${words(25 + random.int(20))}.`;
            parts.push(part);
            size += part.length + 2;
        }
        return parts.join('\n\n').slice(0, bytes);
    };
    return { ...random, words, title, markdown };
}

/** A tiny real file of each seeded media type: a 1x1 PNG and JPEG, and so on. */
const MEDIA_BODIES: Record<string, Buffer> = {
    'image/png': PNG,
    'image/jpeg': Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKQAH//Z',
        'base64',
    ),
    'application/pdf': Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    ),
    'text/markdown': Buffer.from('# Notes\n\n- plan the launch\n'),
    'text/csv': Buffer.from('month,total\n2026-09,42\n'),
};

/** Who owns the n-th of `total` per-user rows: the heavy users first. */
function ownerOf(index: number, total: number, users: User[], heavy: User[]) {
    const share = Math.floor(total / 10);
    const slot = Math.floor(index / Math.max(share, 1));
    if (slot < heavy.length) {
        return heavy[slot]!;
    }
    const rest = users.filter((user) => !heavy.includes(user));
    return rest[index % rest.length]!;
}

export interface SeededWorkspace {
    dir: string;
    database: string;
    store: Store;
    workspace: WorkspaceStore;
    platform: TestPlatform;
    /** The app's runtime and its services, for `createApp` (main.ts). */
    edge: AppEdge;
    /** The views the pages answer with, over `platform` (tests/helpers/page-views.ts). */
    views: PageViews;
    config: Config;
    users: User[];
    /** The bench's admin and member: each owns a tenth of per-user data. */
    admin: User;
    member: User;
    /** One operator, for the platform page. */
    operator: User;
    /** Disposes the runtime, closes the stores and removes the directory, unless `keep`. */
    close(options?: { keep?: boolean }): Promise<void>;
}

/**
 * Seeds a workspace in a temporary directory and opens it as the server
 * does (index.ts): the migrated database file, the stores, the runner and
 * the app's runtime (`makeTestRuntime`), not started. `close()` disposes it
 * and removes the directory.
 */
export async function seedWorkspace(sizes: Partial<SeedSizes> = {}): Promise<SeededWorkspace> {
    const size = { ...SEED_SIZES, ...sizes };
    const dir = mkdtempSync(join(tmpdir(), 'cb-seed-'));
    const database = join(dir, 'company-brain.sqlite');
    migrateDatabase(database, schemas, { backupDirectory: join(dir, 'backups') });
    const config: Config = {
        mode: 'live',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'seed-model-key',
        model: 'fake-model',
    };
    // The app's runtime over the file, the store and the workspace on a
    // connection each; the runner on the same file.
    const runtime = await makeTestRuntime({
        database: { store: database, workspace: database },
        runner: new LocalAgentRunner(database),
        config: {
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model,
            runtimeUrl: 'http://127.0.0.1:1/api/copilotkit',
            sessionSecret: 'seed-session-secret-0123456789abcdef',
            data: { userDataDir: join(dir, 'userdata') },
        },
    });
    const { store, workspace, platform, edge } = runtime;
    // The workspace's rows in one transaction on its connection (the plain
    // inserts too), then the core store's on its own.
    const db = workspace.db;
    const core = (store as unknown as { db: DatabaseSync }).db;
    db.exec('PRAGMA synchronous=OFF');
    const text = writer(61);
    const at = (daysAgo: number) => SEED_NOW - Math.floor(daysAgo * DAY) - text.int(DAY);
    const yearAgo = () => at(text.next() * 365);

    // People: the first `admins` are admins.
    const users: User[] = Array.from({ length: size.users }, (_, index) => {
        const n = String(index + 1).padStart(3, '0');
        return {
            id: `seed-user-${n}`,
            name: `Person ${n}`,
            role: index < size.admins ? 'admin' : 'member',
        };
    });
    const operator: User = {
        id: 'seed-operator',
        name: 'Operator',
        role: 'admin',
    };
    for (const user of [...users, operator]) {
        workspace.recordUser(user);
    }
    const admin = users[0]!;
    const member = users[size.admins]!;
    const heavy = [admin, member];
    const owner = (index: number, total: number) => ownerOf(index, total, users, heavy);

    // Spaces and Dots: the default Everyday Space and Dot, and the rest.
    const spaces = [...workspace.spaces()];
    while (spaces.length < size.spaces) {
        spaces.push(workspace.createSpace(text.title(2), text.words(10)));
    }
    const containers = ['support', 'sales', 'engineering', 'finance'];
    const dots = [...workspace.dots()];
    while (dots.length < size.dots) {
        const space = spaces[dots.length % spaces.length]!;
        const learning = dots.length % 4 === 0 ? containers[dots.length % containers.length]! : null;
        dots.push(
            workspace.createDot(
                space.id,
                `${text.title(1)} Dot ${dots.length + 1}`,
                text.words(40),
                true,
                true,
                [space.id],
                learning,
                false,
            ),
        );
    }

    // Pages: a tree in each Space, about `pageBytes` of markdown each,
    // through their repositories in a unit of work of their own (CB-110).
    const parents = new Map<string, string[]>();
    await workspace.data.uow.run(async () => {
        for (let index = 0; index < size.pages; index++) {
            const space = spaces[index % spaces.length]!;
            const siblings = parents.get(space.id) ?? [];
            const parentId = siblings.length > 3 && text.next() < 0.6 ? text.pick(siblings) : null;
            const page = await workspace.pages.create(
                space.id,
                {
                    title: text.title(3),
                    content: text.markdown(size.pageBytes),
                    parentId,
                },
                null,
                text.pick(users).id,
            );
            siblings.push(page.id);
            parents.set(space.id, siblings);
        }
    });
    db.exec('BEGIN');
    const updatePage = db.prepare('UPDATE pages SET createdAt=?, updatedAt=? WHERE id=?');
    for (const row of db.prepare('SELECT id FROM pages').all()) {
        updatePage.run(yearAgo(), at(text.next() * 60), String(row.id));
    }

    // Conversations: per user, on the user's Dots.
    const threads: Array<{ id: string; ownerId: string; dotId: string }> = [];
    for (let index = 0; index < size.conversations; index++) {
        const user = owner(index, size.conversations);
        const dot = dots[index % dots.length]!;
        // One width, so no id is the start of another (the ssr smoke looks
        // for ids in the page).
        const id = `seed-thread-${String(index).padStart(5, '0')}`;
        workspace.bindThread(id, dot.id, text.title(5), user.id);
        threads.push({ id, ownerId: user.id, dotId: dot.id });
    }
    const updateThread = db.prepare('UPDATE thread_bindings SET createdAt=? WHERE id=?');
    for (const thread of threads) {
        updateThread.run(yearAgo(), thread.id);
    }

    // Issues: most of a year's are closed; five comments each on average.
    const issueNumbers: number[] = [];
    const statuses: IssueStatus[] = [
        'done',
        'done',
        'done',
        'done',
        'done',
        'done',
        'wont_fix',
        'triage',
        'open',
        'open',
        'ready',
        'in_progress',
        'in_review',
        'blocked',
    ];
    // The board through its services, in a unit of work of their own (CB-110):
    // it can't join the plain transaction.
    db.exec('COMMIT');
    await workspace.data.uow.run(async () => {
        for (let index = 0; index < size.issues; index++) {
            const issue = await platform.board.issues.create(
                {
                    title: text.title(6),
                    body: text.markdown(300 + text.int(1200)),
                    status: text.pick(statuses),
                    priority: text.pick(ISSUE_PRIORITIES),
                    kind: text.pick(ISSUE_KINDS.filter((kind) => kind !== 'request')),
                    area: text.pick(ISSUE_AREAS),
                    labels: text.next() < 0.4 ? [text.pick(ISSUE_LABELS.slice(0, 8))] : [],
                    assigneeId: text.next() < 0.7 ? users[text.int(size.admins)]!.id : null,
                },
                text.pick(users).id,
                yearAgo(),
            );
            issueNumbers.push(issue.number);
        }
        for (let index = 0; index < size.comments; index++) {
            await platform.board.issues.addComment(
                text.pick(issueNumbers),
                text.markdown(80 + text.int(500)),
                text.pick(users).id,
                yearAgo(),
            );
        }
    });
    db.exec('BEGIN');

    // Approval requests, decided and pending, with their audit.
    const capabilities = ['email.send', 'data.write', 'web.post', 'app.publish'];
    const insertApproval = db.prepare(
        `INSERT INTO approval_requests(id, userId, dotId, capability, summary, details, payload, threadId, status, decidedVia, outcome, createdAt, expiresAt, decidedAt)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAudit = db.prepare(
        `INSERT INTO approval_audit(id, userId, dotId, capability, requestId, event, actor, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < size.approvals; index++) {
        const user = owner(index, size.approvals);
        const thread = threads.find((item) => item.ownerId === user.id)!;
        const status = index % 10 === 0 ? 'pending' : text.pick(['approved', 'denied', 'expired']);
        const created = status === 'pending' ? SEED_NOW - text.int(DAY) : yearAgo();
        const id = randomUUID();
        const capability = text.pick(capabilities);
        insertApproval.run(
            id,
            user.id,
            thread.dotId,
            capability,
            text.title(8),
            JSON.stringify([`To: ${text.words(2)}`, `Subject: ${text.title(6)}`, text.words(60)]),
            thread.id,
            status,
            status === 'pending' ? null : 'web',
            status === 'approved' ? text.words(8) : null,
            created,
            created + DAY,
            status === 'pending' ? null : created + text.int(DAY),
        );
        insertAudit.run(
            randomUUID(),
            user.id,
            thread.dotId,
            capability,
            id,
            'requested',
            `dot:${thread.dotId}`,
            null,
            created,
        );
        if (status !== 'pending') {
            insertAudit.run(randomUUID(), user.id, thread.dotId, capability, id, status, user.id, null, created + 1000);
        }
    }

    // Jobs with their runs (their schedules are the core store's, below).
    const jobs: Array<{ id: string; userId: string; dotId: string }> = [];
    const insertJob = db.prepare(
        'INSERT INTO jobs(id, userId, dotId, name, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, ?, ?)',
    );
    const insertVersion = db.prepare(
        `INSERT INTO job_versions(jobId, version, entry, files, digest, timeoutSeconds, datasets, createdAt) VALUES (?, 1, 'main.py', '["main.py"]', ?, 300, '[]', ?)`,
    );
    for (let index = 0; index < Math.ceil(size.schedules / 3); index++) {
        const user = owner(index, Math.ceil(size.schedules / 3));
        const job = {
            id: randomUUID(),
            userId: user.id,
            dotId: text.pick(dots).id,
        };
        const created = yearAgo();
        insertJob.run(job.id, job.userId, job.dotId, `job-${index}`, created, created);
        insertVersion.run(job.id, randomUUID().replaceAll('-', ''), created);
        jobs.push(job);
    }
    const insertJobRun = db.prepare(
        `INSERT INTO job_runs(id, jobId, version, userId, dotId, trigger, status, queuedAt, startedAt, finishedAt, exitCode, stdout, stderr) VALUES (?, ?, 1, ?, ?, 'schedule', ?, ?, ?, ?, ?, ?, '')`,
    );
    for (let index = 0; index < size.jobRuns; index++) {
        const job = jobs[index % jobs.length]!;
        const queued = yearAgo();
        const failed = text.next() < 0.1;
        insertJobRun.run(
            randomUUID(),
            job.id,
            job.userId,
            job.dotId,
            failed ? 'failed' : 'succeeded',
            queued,
            queued + 500,
            queued + 500 + text.int(60_000),
            failed ? 1 : 0,
            text.words(80),
        );
    }

    // Agent runs: a turn's events, a few kilobytes each; some failed.
    const insertRun = db.prepare(
        `INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const runs = Array.from({ length: size.agentRuns }, () => ({
        thread: text.pick(threads),
        started: yearAgo(),
        status: text.next() < 0.06 ? 'failed' : 'finished',
    })).sort((a, b) => a.started - b.started);
    for (const run of runs) {
        const events = [
            { type: 'RUN_STARTED' },
            ...Array.from({ length: 6 }, () => ({
                type: 'TEXT_MESSAGE_CONTENT',
                delta: text.words(60),
            })),
            run.status === 'failed'
                ? { type: 'RUN_ERROR', message: `The model failed: ${text.words(8)}` }
                : { type: 'RUN_FINISHED' },
        ];
        insertRun.run(
            run.thread.id,
            randomUUID(),
            run.status,
            JSON.stringify(events),
            run.started,
            run.started + text.int(120_000),
            'web',
        );
    }

    // Media: files in folders, per user. The folders here; the files after
    // the transaction, through the data space (`putFile` is async).
    const folderCount = new Map<string, string[]>();
    const insertFolder = db.prepare(
        'INSERT OR IGNORE INTO media_folders(ownerUserId, path, createdAt) VALUES (?, ?, ?)',
    );
    for (let index = 0; index < size.mediaFolders; index++) {
        const user = owner(index, size.mediaFolders);
        const list = folderCount.get(user.id) ?? [];
        const parent = list.length && text.next() < 0.4 ? text.pick(list) : '';
        const path = `${parent}${text.pick(WORDS)}-${index}/`;
        list.push(path);
        folderCount.set(user.id, list);
        insertFolder.run(user.id, path, yearAgo());
    }
    const types = [
        ['png', 'image/png'],
        ['jpg', 'image/jpeg'],
        ['pdf', 'application/pdf'],
        ['md', 'text/markdown'],
        ['csv', 'text/csv'],
    ] as const;
    const mediaFiles: Array<{
        user: User;
        path: string;
        name: string;
        mediaType: string;
        dotId: string | null;
        created: number;
    }> = [];
    for (let index = 0; index < size.mediaFiles; index++) {
        const user = owner(index, size.mediaFiles);
        const folders = folderCount.get(user.id) ?? [''];
        const folder = text.next() < 0.2 ? '' : text.pick(folders);
        const [extension, mediaType] = text.pick(types);
        const name = `${text.words(3).replaceAll(' ', '-')}-${index}.${extension}`;
        mediaFiles.push({
            user,
            path: `${folder}${name}`,
            name,
            mediaType,
            dotId: text.next() < 0.3 ? text.pick(dots).id : null,
            created: yearAgo(),
        });
    }

    // Learning: analysis runs and their proposals, per container.
    const insertLearningRun = db.prepare(
        `INSERT INTO learning_runs(id, containerId, trigger, status, startedAt, finishedAt, threads, proposals, dropped, startedBy) VALUES (?, ?, 'manual', 'succeeded', ?, ?, 40, 10, 2, ?)`,
    );
    const insertProposal = db.prepare(
        `INSERT INTO learning_proposals(id, containerId, runId, name, description, skillMd, rationale, evidenceThreadIds, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let learningRun = '';
    for (let index = 0; index < size.proposals; index++) {
        const containerId = containers[index % containers.length]!;
        if (index % 10 === 0) {
            learningRun = randomUUID();
            const started = yearAgo();
            insertLearningRun.run(learningRun, containerId, started, started + 60_000, admin.id);
        }
        insertProposal.run(
            randomUUID(),
            containerId,
            learningRun,
            `${text.pick(WORDS)}-${text.pick(WORDS)}-${index}`,
            text.words(20),
            text.markdown(1500),
            text.words(40),
            JSON.stringify([text.pick(threads).id, text.pick(threads).id]),
            index % 6 === 0 ? 'pending' : text.pick(['published', 'rejected']),
            yearAgo(),
        );
    }

    db.exec('COMMIT');

    // The media files' bodies, sealed and stored as an upload's are, each
    // in a unit of work of its own (CB-110), then the rows' Dot and times
    // (an upload is a person's, made now) in one plain transaction.
    const stampFile = db.prepare(
        'UPDATE data_files SET createdByDotId=?, createdAt=?, updatedAt=? WHERE ownerUserId=? AND path=? AND deletedAt IS NULL',
    );
    // The data space writes one person's files one at a time; people in
    // parallel.
    const byOwner = new Map<string, typeof mediaFiles>();
    for (const file of mediaFiles) {
        const list = byOwner.get(file.user.id) ?? [];
        list.push(file);
        byOwner.set(file.user.id, list);
    }
    await Promise.all(
        [...byOwner.values()].map(async (files) => {
            for (const file of files) {
                await platform.data.putFile(
                    { kind: 'user', userId: file.user.id },
                    file.path,
                    MEDIA_BODIES[file.mediaType]!,
                    file.mediaType,
                    { name: file.name },
                );
            }
        }),
    );
    db.exec('BEGIN');
    for (const file of mediaFiles) {
        stampFile.run(file.dotId, file.created, file.created, file.user.id, file.path);
    }
    db.exec('COMMIT');

    // Datasets, made by the data space (each is its own SQLite file).
    for (let index = 0; index < size.datasets; index++) {
        const user = owner(index, size.datasets);
        platform.data.createDataset(user.id, {
            name: `${text.title(2)} ${index}`,
            description: text.words(12),
        });
    }

    // Memories, per user, through their repository in a unit of work of
    // their own (CB-110): it can't join the plain transaction.
    await sqliteData(core).uow.run(async () => {
        for (let index = 0; index < size.memories; index++) {
            await store.memoryItems.add({
                text: `${text.title(1)} ${text.words(18)}.`,
                userId: owner(index, size.memories).id,
                source: 'person',
            });
        }
    });
    // Research tasks and schedules (scheduled turns), per user, through the
    // Scheduling context's service in a unit of work of their own (CB-110).
    await sqliteData(core).uow.run(async () => {
        for (let index = 0; index < size.tasks; index++) {
            await store.createTask(text.words(20), null, owner(index, size.tasks).id);
        }
        for (let index = 0; index < size.schedules; index++) {
            const user = owner(index, size.schedules);
            await store.createSchedule({
                userId: user.id,
                title: text.title(4),
                prompt: text.words(30),
                cadence: '0 8 * * 1',
                timezone: 'UTC',
                dotId: text.pick(dots).id,
                kind: 'turn',
            });
        }
    });
    db.exec('PRAGMA synchronous=FULL');
    return {
        dir,
        database,
        store,
        workspace,
        platform,
        edge,
        views: testPageViews(platform),
        config,
        users,
        admin,
        member,
        operator,
        close: async ({ keep = false } = {}) => {
            await runtime.dispose();
            if (!keep) {
                rmSync(dir, { recursive: true, force: true });
            }
        },
    };
}
