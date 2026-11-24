import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FetchRequestInit } from 'expo/fetch';

import { openCacheDb, type SqlConnection } from '../../src/data';
import { type Answered, createAuthedFetch } from '../../src/net/authed-fetch';
import { memoryJarStore, openCookieJar } from '../../src/net/cookie-jar';
import type { SessionEnd } from '../../src/net/session';
import { SHELL_SNAPSHOTS, STATE_SNAPSHOT, WORKSPACE_SNAPSHOT } from '../../src/sync/shell';
import { openSnapshotCache, type SnapshotCache, type SnapshotCacheOptions } from '../../src/sync/snapshot-cache';
import { createSnapshotSource } from '../../src/sync/snapshot-source';
import { createNodeSqliteDriver, type NodeSqliteDriver } from '../helpers/node-sqlite-driver';
import {
    clocks,
    cookieValue,
    DAY,
    fakeFetch,
    httpDate,
    ORIGIN,
    SESSION,
    sentHeaders,
    sessionSetCookie,
} from '../net/helpers';

// A fake workspace server for src/sync's tests, answering as Socio does:
// - a Space's pages: `GET /api/spaces/:id/pages` through the same
//   rules (its counter per Space), `GET /api/spaces/:spaceId/pages/:id` (410
//   for a deleted page, 404 for one the Space doesn't hold or a Space the
//   person doesn't read) and `GET /api/pages/:id/location`;
// - `GET /api/state`, `GET /api/workspace`, `GET /api/issues`, and
//   `GET /api/memories`, `GET /api/schedules` and `GET /api/runs` through conditionalJsonAsync's
//   rules (packages/foundation/src/http/conditional.ts): the tag is
//   `"<version>.<body>"`, the version a hash of the boot id, the path and query
//   and the view's change counter, the body a hash of the JSON. A sent tag whose
//   version matches answers 304 without building the body; one whose body hash
//   matches answers 304 with the new tag; otherwise a 200. With `gzip` on, the
//   200's tag is weak (`W/`, compression.ts), never the 304's. If-None-Match is
//   read as a comma list, W/ or not;
// - /api/state lists the person's unseen notices of the last 24 h, at most 5,
//   oldest first (notifications/service.ts);
// - Better Auth's sessions (7 days, renewed once a day of use) on every /api
//   answer, 304s included, and a 401 `sign_in` with a clearing cookie for a
//   session it doesn't have;
// - `GET /api/auth/session`, before the session check: always 200, with
//   `user: null` when the cookie is dead;
// - /api/state's `version`, the running build's release: a deploy starts a new
//   build (a new boot id and its version), and during a start-first deploy the
//   old build answers too (`answerAs`).

export const CACHE_KEY = '0f'.repeat(32);
const HOUR = DAY / 24;

export interface Notice {
    id: string;
    title: string;
    body: string;
    link: string;
    createdAt: number;
}

export interface WorkspaceData {
    settings: Record<string, unknown>;
    notices: Notice[];
    conversations: Record<string, unknown>[];
    archived: Record<string, unknown>[];
    spaces: Record<string, unknown>[];
    dots: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    /** The board's summaries (IssueSummary), in the server's order, and the assignees' names. */
    issues: Record<string, unknown>[];
    users: Record<string, string>;
    /** Memories (MemoriesState): the active ones, the proposals, the profile and the moved time zone. */
    memories: Record<string, unknown>[];
    proposals: Record<string, unknown>[];
    profile: Record<string, unknown> | null;
    timeZoneMoved?: string;
    /** Schedules (SchedulesState). */
    schedules: Record<string, unknown>[];
    goals: Record<string, unknown>[];
    jobs: Record<string, unknown>[];
    limits: Record<string, number>;
    /** Runs (RunsList's runs). */
    runs: Record<string, unknown>[];
    /** `GET /api/learning/skills` (PublishedSkills), which the server sends with no ETag. */
    skills: Record<string, unknown>[];
    /** Each Space's live pages (Page, with their bodies), by Space id. */
    pages: Record<string, Record<string, unknown>[]>;
    /** Deleted pages' ids: their body answers 410. */
    deletedPages: string[];
    /** The person's approval requests (ApprovalView), newest first. */
    approvals: Record<string, unknown>[];
}

/** An approval request as the server's ApprovalView gives it. */
export const approval = (id: string, status = 'pending', fields: Record<string, unknown> = {}) => ({
    id,
    dotId: 'sebas',
    dotName: 'Sebas',
    capability: 'data.create_dataset',
    capabilityLabel: 'Create dataset',
    summary: `Create dataset “${id}”`,
    details: [],
    status,
    decidedVia: status === 'pending' ? null : 'user',
    createdAt: 1,
    expiresAt: 7 * DAY,
    ...fields,
});

export const memory = (id: string, text: string, updatedAt = 1, status = 'active') => ({
    id,
    text,
    createdAt: 1,
    status,
    source: status === 'active' ? 'person' : 'socio',
    shareable: false,
    dotId: null,
    threadId: null,
    updatedAt,
    confirmedAt: status === 'active' ? updatedAt : null,
});

export const run = (runId: string, status = 'done', startedAt = 1) => ({
    runId,
    threadId: 'c1',
    status,
    source: 'browser',
    startedAt,
    finishedAt: status === 'running' ? null : startedAt + 1,
    error: null,
    errorDetail: null,
    title: 'Kickoff',
    dotName: 'Sebas',
    ownerId: 'u-ada',
    ownerName: 'Ada',
    readable: true,
    trace: null,
});

export const issue = (number: number, title: string, updatedAt = 1, fields: Record<string, unknown> = {}) => ({
    number,
    title,
    status: 'backlog',
    priority: 'medium',
    kind: 'bug',
    area: null,
    labels: [],
    assigneeId: null,
    updatedAt,
    demand: 0,
    votes: 0,
    voted: false,
    openBlockers: 0,
    excerpt: '',
    ...fields,
});

/** A page as the server returns it (Page), in Space `spaceId`. */
export const page = (
    spaceId: string,
    id: string,
    title: string,
    revision = 1,
    content = `# ${title}\n\nBody of ${id}.`,
) => ({
    id,
    spaceId,
    parentId: null,
    title,
    content,
    revision,
    createdAt: 1,
    updatedAt: revision,
    sourceThreadId: null,
    createdBy: 'u-ada',
    cover: null,
    sourceUrl: null,
    sourceTitle: null,
});

export const conversation = (id: string, title: string, createdAt = 1) => ({
    id,
    dotId: 'sebas',
    ownerId: 'u-ada',
    title,
    createdAt,
    kind: 'private',
});

export function seed(): WorkspaceData {
    return {
        settings: { name: 'Acme', paused: false },
        notices: [],
        conversations: [conversation('c1', 'Kickoff', 3), conversation('c2', 'Roadmap', 2)],
        archived: [{ ...conversation('c0', 'Old', 1), archivedAt: 5 }],
        spaces: [{ id: 'everyday', name: 'Everyday', description: '', createdAt: 1 }],
        dots: [{ id: 'sebas', name: 'Sebas', spaceId: 'everyday', spaceIds: ['everyday'], createdAt: 1 }],
        tasks: [],
        issues: [issue(2, 'Search is slow', 20, { assigneeId: 'u-ada' }), issue(1, 'Login fails', 10)],
        users: { 'u-ada': 'Ada' },
        memories: [memory('m1', 'Prefers short answers', 5)],
        proposals: [memory('m2', 'Works in Lisbon', 6, 'proposed')],
        profile: { name: 'Ada', timezone: 'Europe/Lisbon' },
        schedules: [{ id: 's1', title: 'Morning digest', kind: 'turn', status: 'active', createdAt: 1 }],
        goals: [{ id: 'G-0000000a', title: 'Ship it', comments: [{ id: 'gc1', text: 'Started' }], updatedAt: 3 }],
        jobs: [{ id: 'j1', name: 'Backup', updatedAt: 4 }],
        limits: {
            minIntervalMinutes: 15,
            maxActiveSchedules: 20,
            maxJobTimeoutSeconds: 600,
            jobConcurrency: 1,
            maxJobs: 10,
        },
        runs: [run('r2', 'running', 20), run('r1', 'done', 10)],
        skills: [
            {
                containerId: 'everyone',
                skills: [{ name: 'triage', description: 'Sorts', revision: 1, revisionId: 'k1' }],
            },
        ],
        pages: { everyday: [page('everyday', 'p1', 'Welcome', 1), page('everyday', 'p2', 'Handbook', 3)] },
        deletedPages: [],
        approvals: [approval('a2', 'pending', { createdAt: 2 }), approval('a1', 'approved', { decidedAt: 1 })],
    };
}

const TAG = /^(?:W\/)?"([\w-]+)\.([\w-]+)"$/;
const digest = (text: string) => createHash('sha256').update(text).digest().subarray(0, 16).toString('base64url');

/** Throws on any read: a 304 must never be parsed. */
function unreadable(response: Response): Response {
    for (const read of ['text', 'json', 'arrayBuffer', 'blob', 'formData', 'bytes'] as const) {
        Object.defineProperty(response, read, {
            value: () => {
                throw new Error(`A 304's body was read (${read}).`);
            },
        });
    }
    return response;
}

export interface ServerRequest {
    path: string;
    ifNoneMatch: string | undefined;
    status: number;
    /** The X-CB-Presence header, if any. */
    presence?: string;
    /** A write's JSON body (the away post's `{tab}`, the seen marks' `{ids}`). */
    body?: unknown;
}

/** A running build of the server: its boot id and its release. */
export interface Build {
    readonly boot: string;
    readonly version: string;
}

export function fakeWorkspaceServer(clock: { server: number }, { gzip = true, version = '0.32.0' } = {}) {
    let boot = randomBytes(9).toString('base64url');
    let release = version;
    const data = seed();
    const counters = { state: 0, workspace: 0, issues: 0, memories: 0, schedules: 0, runs: 0, skills: 0 };
    /** A status `/api/issues` answers with in place of the list (a 403 or 404), or null. */
    let issuesRefusal: number | null = null;
    /** Statuses `/api/issues/:number` answers with in place of the detail (a 404, a 410), by number. */
    const detailRefusals = new Map<number, number>();
    /** Each Space's pages counter (`pages:<spaceId>` on the server). */
    const pageCounters = new Map<string, number>();
    const readable = (spaceId: string) => data.spaces.some((space) => space.id === spaceId);
    let session: { token: string; expiresAt: number; renewedAt: number } | null = null;
    /** The 401 code for a request with an install id once `end` named one; none: the web's `sign_in`. */
    let endCode: string | null = null;
    let issued = 0;
    let builds = 0;
    const requests: ServerRequest[] = [];

    const views: Record<
        '/api/state' | '/api/workspace' | '/api/issues' | '/api/memories' | '/api/schedules' | '/api/runs',
        { counter: () => number; build: () => unknown }
    > = {
        '/api/memories': {
            counter: () => counters.memories,
            build: () => ({
                profile: data.profile,
                memories: data.memories,
                proposals: data.proposals,
                ...(data.timeZoneMoved === undefined ? {} : { timeZoneMoved: data.timeZoneMoved }),
            }),
        },
        '/api/schedules': {
            counter: () => counters.schedules,
            build: () => ({
                schedules: data.schedules,
                goals: data.goals,
                jobs: data.jobs,
                limits: data.limits,
                usage: { activeSchedules: data.schedules.length, jobs: data.jobs.length },
            }),
        },
        '/api/runs': {
            counter: () => counters.runs,
            build: () => ({ limit: 200, runs: data.runs }),
        },
        '/api/issues': {
            counter: () => counters.issues,
            build: () => ({ issues: data.issues, users: data.users }),
        },
        '/api/state': {
            counter: () => counters.state,
            build: () => ({
                settings: data.settings,
                version: release,
                tasks: data.tasks,
                memories: [],
                mode: 'live',
                configured: true,
                notices: data.notices
                    .filter((notice) => notice.createdAt >= clock.server - 24 * HOUR)
                    .sort((a, b) => a.createdAt - b.createdAt)
                    .slice(0, 5),
            }),
        },
        '/api/workspace': {
            counter: () => counters.workspace,
            build: () => ({
                user: { id: 'u-ada', name: 'Ada', role: 'admin' },
                spaces: data.spaces,
                dots: data.dots,
                conversations: data.conversations,
                archived: data.archived,
                setup: { inference: true },
                calls: [],
            }),
        },
    };

    const handle = (url: string, init: FetchRequestInit): Response => {
        const now = clock.server;
        const headers = new Headers({ date: httpDate(now) });
        const sent = cookieValue(sentHeaders({ url, init }).cookie, SESSION);
        const live = session !== null && sent === session.token && now < session.expiresAt;
        const { pathname, search } = new URL(url);
        const ifNoneMatch = sentHeaders({ url, init })['if-none-match'];
        const presence = sentHeaders({ url, init })['x-cb-presence'];
        const sentBody = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        const done = (response: Response) => {
            requests.push({
                path: pathname + search,
                ifNoneMatch,
                status: response.status,
                ...(presence === undefined ? {} : { presence }),
                ...(sentBody === undefined ? {} : { body: sentBody }),
            });
            return response;
        };

        if (pathname === '/api/auth/session') {
            // An install id whose device was revoked, or a deactivated person, gets the code here too.
            if (!live && endCode !== null && sentHeaders({ url, init })['x-socio-install'] !== undefined) {
                headers.set('content-type', 'application/json');
                return done(
                    new Response(JSON.stringify({ error: 'Signed out.', code: endCode }), { status: 401, headers }),
                );
            }
            if (!live && sent !== undefined) {
                headers.append('set-cookie', sessionSetCookie('', 0));
            }
            const user = live ? { id: 'u-ada', name: 'Ada', role: 'admin' } : null;
            headers.set('content-type', 'application/json');
            return done(
                new Response(JSON.stringify({ provider: 'betterauth', branding: { name: 'Acme' }, user }), {
                    status: 200,
                    headers,
                }),
            );
        }
        if (!live) {
            if (session !== null && now >= session.expiresAt) {
                session = null;
            }
            if (sent !== undefined) {
                headers.append('set-cookie', sessionSetCookie('', 0));
            }
            headers.set('content-type', 'application/json');
            const install = sentHeaders({ url, init })['x-socio-install'];
            const code = endCode !== null && install !== undefined ? endCode : 'sign_in';
            return done(
                new Response(JSON.stringify({ error: 'Sign in to continue.', code }), {
                    status: 401,
                    headers,
                }),
            );
        }
        if (session !== null && now - session.renewedAt >= DAY) {
            session = { ...session, expiresAt: now + 7 * DAY, renewedAt: now };
            headers.append('set-cookie', sessionSetCookie(session.token));
        }
        if (pathname === '/api/notifications/away') {
            // 204 either way, as the server answers (notifications/routes.ts).
            return done(new Response(null, { status: 204, headers }));
        }
        if (pathname === '/api/notifications/in-app/seen') {
            const ids = (sentBody as { ids?: unknown } | undefined)?.ids;
            headers.set('content-type', 'application/json');
            if (!Array.isArray(ids) || ids.length > 20) {
                return done(new Response(JSON.stringify({ error: 'Invalid notices.' }), { status: 400, headers }));
            }
            data.notices = data.notices.filter((notice) => !ids.includes(notice.id));
            counters.state += 1;
            return done(new Response(JSON.stringify({ ok: true }), { status: 200, headers }));
        }
        if (pathname === '/api/issues' && issuesRefusal !== null) {
            headers.set('content-type', 'application/json');
            return done(new Response(JSON.stringify({ error: 'Not allowed.' }), { status: issuesRefusal, headers }));
        }
        const traceOf = /^\/api\/runs\/([^/]+)\/trace$/.exec(pathname);
        if (traceOf !== null) {
            // A run's trace: what run-routes.ts answers its owner or an admin, c.json, no ETag.
            const runId = decodeURIComponent(traceOf[1]!);
            const listed = data.runs.find((item) => item.runId === runId);
            headers.set('content-type', 'application/json');
            if (listed === undefined) {
                return done(new Response(JSON.stringify({ error: 'Run not found.' }), { status: 404, headers }));
            }
            const startedAt = Number(listed.startedAt);
            const view = {
                runId,
                status: listed.status,
                startedAt,
                finishedAt: listed.finishedAt,
                trace: {
                    turn: { label: 'Shared model', model: null, source: 'web', cap: 25 },
                    rounds: [{ kind: 'round', round: 1, startedAt, endedAt: startedAt + 1, stop: 'stop' }],
                    tools: [],
                    waits: [],
                    end: { reason: 'completed' },
                },
            };
            return done(new Response(JSON.stringify(view), { status: 200, headers }));
        }
        const detailOf = /^\/api\/issues\/(\d+)$/.exec(pathname);
        if (detailOf !== null) {
            // An issue's detail: the list's summary with the rest, no ETag, as the server's c.json.
            const number = Number(detailOf[1]);
            const summary = data.issues.find((item) => item.number === number);
            const refusal = detailRefusals.get(number) ?? (summary === undefined ? 404 : null);
            headers.set('content-type', 'application/json');
            if (refusal !== null) {
                return done(new Response(JSON.stringify({ error: 'Not found.' }), { status: refusal, headers }));
            }
            const { excerpt, ...fields } = summary!;
            const issue = {
                ...fields,
                id: `i-${number}`,
                body: excerpt,
                reporterId: 'u-ada',
                resolution: null,
                source: 'web',
                createdAt: 1,
                closedAt: null,
            };
            return done(
                new Response(JSON.stringify({ issue, comments: [], attachments: [], events: [], users: data.users }), {
                    status: 200,
                    headers,
                }),
            );
        }
        const pageOf = /^\/api\/spaces\/([^/]+)\/pages\/([^/]+)$/.exec(pathname);
        if (pageOf !== null) {
            const [spaceId, id] = [decodeURIComponent(pageOf[1]!), decodeURIComponent(pageOf[2]!)];
            const found = readable(spaceId) ? data.pages[spaceId]?.find((item) => item.id === id) : undefined;
            headers.set('content-type', 'application/json');
            if (found === undefined) {
                const status = readable(spaceId) && data.deletedPages.includes(id) ? 410 : 404;
                return done(new Response(JSON.stringify({ error: 'Page not found.' }), { status, headers }));
            }
            return done(new Response(JSON.stringify(found), { status: 200, headers }));
        }
        const locationOf = /^\/api\/pages\/([^/]+)\/location$/.exec(pathname);
        if (locationOf !== null) {
            const id = decodeURIComponent(locationOf[1]!);
            const spaceId = Object.keys(data.pages).find(
                (space) => readable(space) && data.pages[space]!.some((item) => item.id === id),
            );
            headers.set('content-type', 'application/json');
            return done(
                spaceId === undefined
                    ? new Response(JSON.stringify({ error: 'Page not found.' }), { status: 404, headers })
                    : new Response(JSON.stringify({ spaceId }), { status: 200, headers }),
            );
        }
        const pagesOf = /^\/api\/spaces\/([^/]+)\/pages$/.exec(pathname);
        if (pagesOf !== null && !readable(decodeURIComponent(pagesOf[1]!))) {
            headers.set('content-type', 'application/json');
            return done(new Response(JSON.stringify({ error: 'Space not found.' }), { status: 404, headers }));
        }
        if (pathname === '/api/approvals') {
            // approvals/views.ts: a plain c.json (no ETag), the 100 most recent, waiting and 50 recent decisions.
            const all = data.approvals.slice(0, 100);
            const body = {
                capabilities: [],
                pending: all.filter((item) => item.status === 'pending'),
                recent: all.filter((item) => item.status !== 'pending').slice(0, 50),
                policies: [],
                audit: [],
                guidance: '',
            };
            headers.set('content-type', 'application/json');
            return done(new Response(JSON.stringify(body), { status: 200, headers }));
        }
        const approvalOf = /^\/api\/approvals\/([^/]+)(?:\/(decision|open|undo))?$/.exec(pathname);
        if (approvalOf !== null) {
            // approvals/routes.ts and service.ts: every refusal a 409 or 404 with a sentence, no code.
            const [, id, action] = approvalOf;
            const item = data.approvals.find((entry) => entry.id === id);
            headers.set('content-type', 'application/json');
            const answer = (status: number, body: unknown) =>
                done(new Response(JSON.stringify(body), { status, headers }));
            if (item === undefined) {
                return answer(404, { error: 'Approval request not found.' });
            }
            const review = item.review as { mustOpen: boolean; opened: boolean } | null | undefined;
            const auto = item.auto as { undoable: boolean; undoneAt: number | null } | null | undefined;
            if (action === 'decision') {
                const approve = (sentBody as { decision?: unknown } | undefined)?.decision === 'approve';
                if (item.status !== 'pending') {
                    return answer(409, { error: 'This request was already decided.' });
                }
                if (approve && review?.mustOpen && !review.opened) {
                    return answer(409, { error: 'Open all the details first.' });
                }
                Object.assign(item, {
                    status: approve ? 'approved' : 'denied',
                    decidedVia: 'user',
                    decidedAt: now,
                    continuation: { status: 'waiting', id: null, detail: null, waitingFor: 0 },
                });
            } else if (action === 'open') {
                // service.ts's open: `{ full }`, never the request; any status; 404 without a review.
                if (!review) {
                    return answer(404, { error: 'This request has no further details.' });
                }
                item.review = { ...review, opened: true };
                return answer(200, { full: `The full details of ${id}.` });
            } else if (action === 'undo') {
                if (item.decidedVia !== 'auto' || item.status !== 'approved' || !auto) {
                    return answer(409, { error: 'Only actions approved automatically can be undone here.' });
                }
                if (auto.undoneAt) {
                    return answer(409, { error: 'This was already undone.' });
                }
                item.auto = { ...auto, undoneAt: now, undoable: false };
            }
            return answer(200, item);
        }
        if (pathname === '/api/learning/skills') {
            // A plain c.json: no ETag, never a 304.
            builds += 1;
            headers.set('content-type', 'application/json');
            return done(new Response(JSON.stringify(data.skills), { status: 200, headers }));
        }
        const spaceOfPages = pagesOf === null ? null : decodeURIComponent(pagesOf[1]!);
        const view =
            spaceOfPages === null
                ? views[pathname as keyof typeof views]
                : {
                      counter: () => pageCounters.get(spaceOfPages) ?? 0,
                      build: () =>
                          (data.pages[spaceOfPages] ?? []).map(
                              ({ content, sourceUrl: _sourceUrl, sourceTitle: _sourceTitle, ...summary }) => ({
                                  ...summary,
                                  excerpt: String(content).slice(0, 40),
                              }),
                          ),
                  };
        if (view === undefined) {
            headers.set('content-type', 'application/json');
            return done(new Response(JSON.stringify({ ok: true }), { status: 200, headers }));
        }
        const tags = (ifNoneMatch ?? '')
            .split(',')
            .map((item) => TAG.exec(item.trim()))
            .filter((match): match is RegExpExecArray => match !== null)
            .map(([, version = '', body = '']) => ({ version, body }));
        const current = digest(`${boot}\n${pathname}${search}\n${view.counter()}`);
        headers.set('vary', 'Accept-Encoding');
        const known = tags.find((tag) => tag.version === current);
        if (known) {
            headers.set('etag', `"${known.version}.${known.body}"`);
            return done(unreadable(new Response(null, { status: 304, headers })));
        }
        builds += 1;
        const text = JSON.stringify(view.build());
        const body = digest(text);
        const tag = `"${current}.${body}"`;
        headers.set('etag', tag);
        if (tags.some((sentTag) => sentTag.body === body)) {
            return done(unreadable(new Response(null, { status: 304, headers })));
        }
        headers.set('etag', gzip ? `W/${tag}` : tag);
        headers.set('content-type', 'application/json');
        return done(new Response(text, { status: 200, headers }));
    };

    return {
        handle,
        data,
        requests,
        /** Bodies built: a version match answers 304 without one. */
        get builds() {
            return builds;
        },
        /** Signs Ada in: the Set-Cookie for the jar. */
        signIn() {
            issued += 1;
            session = {
                token: `t${issued}.c2lnbmF0dXJl%3D`,
                expiresAt: clock.server + 7 * DAY,
                renewedAt: clock.server,
            };
            return sessionSetCookie(session.token);
        },
        /**
         * Ends the session on the server: sign-out everywhere, an admin. With a
         * code, a 401 to a request with an install id carries it.
         */
        end(code: string | null = null) {
            session = null;
            endCode = code;
        },
        get session() {
            return session;
        },
        /** Changes a view's data and its change counter. */
        change(view: keyof typeof counters, mutate: (data: WorkspaceData) => void) {
            mutate(data);
            counters[view] += 1;
        },
        /** Changes a Space's pages and its counter (and the other Spaces' a move touches: pass them in `also`). */
        changePages(spaceId: string, mutate: (data: WorkspaceData) => void, also: readonly string[] = []) {
            mutate(data);
            for (const space of [spaceId, ...also]) {
                pageCounters.set(space, (pageCounters.get(space) ?? 0) + 1);
            }
        },
        /** Answers `/api/issues` with `status` (a 403, a 404) from now on, or the list again with null. */
        refuseIssues(status: number | null) {
            issuesRefusal = status;
        },
        /** Answers `/api/issues/<number>` with `status` (a 404, a 410) from now on, or the detail again with null. */
        refuseDetail(number: number, status: number | null) {
            if (status === null) {
                detailRefusals.delete(number);
            } else {
                detailRefusals.set(number, status);
            }
        },
        /** A restart or deploy: a new boot id, so every tag's version part changes. */
        restart() {
            boot = randomBytes(9).toString('base64url');
        },
        /** The build answering now. */
        get build(): Build {
            return { boot, version: release };
        },
        /** A deploy of `next`: a new boot id and release. Returns the new build. */
        deploy(next: string): Build {
            boot = randomBytes(9).toString('base64url');
            release = next;
            return { boot, version: release };
        },
        /** Answers as `build` from now on: the other build of a start-first deploy, or a rollback. */
        answerAs(build: Build) {
            boot = build.boot;
            release = build.version;
        },
    };
}

export type FakeWorkspaceServer = ReturnType<typeof fakeWorkspaceServer>;

export interface SyncSetupOptions {
    gzip?: boolean;
    /** The server's release (State.version) at the start. */
    version?: string;
    /** The workspace's server versions, handed to the cache. */
    versions?: SnapshotCacheOptions['versions'];
    /** Holds each answer until the test lets it go (`release`), to order answers and confirmations. */
    hold?: boolean;
    onAnswer?: (answer: Answered) => void;
    /** Reuse a directory, for a relaunch. */
    directory?: string;
    driver?: NodeSqliteDriver;
}

/** A signed-in workspace: the fake server, its jar and authedFetch, cache.db, the cache and the shell's sources. */
export async function syncSetup(options: SyncSetupOptions = {}) {
    const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'socio-sync-'));
    const clock = clocks();
    const server = fakeWorkspaceServer(clock, { gzip: options.gzip, version: options.version });
    const held: Array<() => void> = [];
    const fetch = fakeFetch((url, init) => {
        const response = server.handle(url, init);
        if (!options.hold) {
            return response;
        }
        return new Promise<Response>((resolve) => held.push(() => resolve(response)));
    });
    const jar = await openCookieJar({ origin: ORIGIN, store: memoryJarStore(), now: clock.device });
    await jar.apply(new URL(`${ORIGIN}/api/auth/sign-in/email`), [server.signIn()], httpDate(clock.server));
    const scope = new AbortController();
    const ends: SessionEnd[] = [];
    const authed = createAuthedFetch({
        origin: ORIGIN,
        jar,
        fetch,
        userAgent: 'Socio/0.1.0 (Pixel 4; Android 13)',
        signal: scope.signal,
        onUnauthorized: (end) => {
            ends.push(end);
        },
        onAnswer: options.onAnswer,
    });
    const driver = options.driver ?? createNodeSqliteDriver();
    const opened = await openCacheDb(driver, directory, CACHE_KEY);
    const db: SqlConnection = opened.db;
    const cache: SnapshotCache = await openSnapshotCache({
        db,
        definitions: SHELL_SNAPSHOTS,
        now: clock.device,
        versions: options.versions,
    });
    const state = createSnapshotSource({ definition: STATE_SNAPSHOT, cache, fetch: authed, signal: scope.signal });
    const workspace = createSnapshotSource({
        definition: WORKSPACE_SNAPSHOT,
        cache,
        fetch: authed,
        signal: scope.signal,
    });
    return {
        directory,
        clock,
        server,
        fetch,
        jar,
        scope,
        ends,
        authed,
        driver,
        db,
        cache,
        state,
        workspace,
        /** Lets a held answer go: the oldest, or the one at `index`. */
        release(index = 0) {
            const [next] = held.splice(index, 1);
            if (next === undefined) {
                throw new Error('No answer is held there.');
            }
            next();
        },
        get heldAnswers() {
            return held.length;
        },
        /** Closes the cache and cache.db; `remove` deletes the directory too. */
        async close({ remove = true } = {}) {
            await cache.close();
            await db.close();
            if (remove) {
                rmSync(directory, { recursive: true, force: true });
            }
        },
    };
}

/** A collection's rows on disk, by key, parsed. */
export async function rowsOnDisk(db: SqlConnection, collection: string): Promise<Record<string, unknown>> {
    const rows = await db.all<{ key: string; json: string }>(
        "SELECT key, json FROM rows WHERE collection = ? AND scope = '' ORDER BY key",
        [collection],
    );
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.json) as unknown]));
}

/** A source's meta row on disk. */
export async function metaOnDisk(db: SqlConnection, source: string) {
    return db.get<{ etag: string | null; schemaVersion: number; syncedAt: number | null }>(
        "SELECT etag, schemaVersion, syncedAt FROM meta WHERE collection = ? AND scope = ''",
        [source],
    );
}

/** The server version a source's meta row on disk is stamped with. */
export async function stampOnDisk(db: SqlConnection, source: string): Promise<string | null | undefined> {
    const row = await db.get<{ serverVersion: string | null }>(
        "SELECT serverVersion FROM meta WHERE collection = ? AND scope = ''",
        [source],
    );
    return row?.serverVersion;
}

export { HOUR };
