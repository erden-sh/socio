import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { IssueDetail, IssueEvent } from '@socio/shared/issues/issue-types';

import { openCacheDb } from '../../src/data';
import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import {
    filingCandidates,
    filingText,
    nextIssueCandidate,
    PENDING_ISSUE_LABEL,
    pendingIssueRows,
} from '../../src/shell/issue-filing';
import { LAST_SCREEN_KEY } from '../../src/shell/last-screen';
import { unsentListRows } from '../../src/shell/unsent';
import { type Drafts, openDrafts } from '../../src/sync/chat-drafts';
import {
    createLocalIssues,
    fileIssue,
    filedValue,
    highestIssue,
    ISSUE_CREATE_KIND,
    ISSUE_DRAFT,
    issueCommentsDraft,
    issueCreateKind,
    type IssueFields,
    issueDraftText,
    IssueDraftError,
    issueScreen,
    keptIssue,
    type LocalIssues,
    readIssueDraft,
    resendIssue,
    unsentIssueFields,
} from '../../src/sync/issue-create';
import { isLocalChat, isLocalIssue, ISSUE_IDS, serverIssueKey } from '../../src/sync/local-ids';
import { type Outbox, type OutboxKind, openOutbox } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { SERVER_CLOCK_SLACK_MS } from '../../src/sync/server-clock';
import { openViewState, type ViewState } from '../../src/sync/view-state';
import { createNodeSqliteDriver } from '../helpers/node-sqlite-driver';

import { CACHE_KEY } from './helpers';
import { killAt, turns, userDb } from './outbox-fakes';

// Filing an issue:
// the create on a real outbox, drafts (user.db) and view state (cache.db),
// against a fake server whose `/api/issues` routes answer as src/server's do:
// the title trimmed by its schema, the body kept as sent, numbers that only
// grow, triage recorded as events. Every test ends with the server holding
// each filing once.

const ME = 'user-me';
const HOUR = 3_600_000;

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type CreateScript =
    | 'ok'
    /** The server files it, then the connection drops before the answer. */
    | 'drop'
    | { readonly status: number; readonly body?: unknown; readonly raw?: string; readonly stores?: boolean };

function server() {
    const details = new Map<number, IssueDetail>();
    const creates: CreateScript[] = [];
    const log: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    let offline = false;
    /** The list can't be read until this many creates have arrived (both of two filings sent at once). */
    let listAfter = 0;
    let last = 40;
    /** The server's clock: an hour into the day, whatever the phone's says. */
    const clock = { now: 50 * HOUR };

    const file = (body: Record<string, unknown>, reporterId = ME): IssueDetail => {
        const at = (clock.now += 1_000);
        const number = (last += 1);
        const detail: IssueDetail = {
            issue: {
                id: `issue-${number}`,
                number,
                title: String(body.title).trim(),
                body: typeof body.body === 'string' ? body.body : '',
                status: 'triage',
                priority: (body.priority as IssueDetail['issue']['priority']) ?? 'medium',
                kind: (body.kind as IssueDetail['issue']['kind']) ?? 'bug',
                area: (body.area as IssueDetail['issue']['area']) ?? null,
                labels: [],
                reporterId,
                assigneeId: null,
                resolution: null,
                source: 'web' as IssueDetail['issue']['source'],
                createdAt: at,
                updatedAt: at,
                closedAt: null,
            },
            comments: [],
            attachments: [],
            events: [
                {
                    id: `event-${number}-0`,
                    issueId: `issue-${number}`,
                    actorId: reporterId,
                    kind: 'created',
                    fromValue: null,
                    toValue: 'triage',
                    createdAt: at,
                },
            ],
            users: {},
        };
        details.set(number, detail);
        return detail;
    };

    /** An admin changes fields of issue `number`, each change an event (store.ts's `update`). */
    const edit = (
        number: number,
        change: Partial<Record<'title' | 'body' | 'kind' | 'priority' | 'area' | 'status', string>>,
    ) => {
        const detail = details.get(number)!;
        const at = (clock.now += 1_000);
        const issue = { ...detail.issue } as Record<string, unknown>;
        const events: IssueEvent[] = [...detail.events];
        for (const [field, value] of Object.entries(change)) {
            events.push({
                id: `event-${number}-${events.length}`,
                issueId: detail.issue.id,
                actorId: 'admin',
                kind: field as IssueEvent['kind'],
                fromValue: (issue[field] as string | null) ?? null,
                toValue: value,
                createdAt: at,
            });
            issue[field] = value;
        }
        details.set(number, {
            ...detail,
            issue: { ...(issue as unknown as IssueDetail['issue']), updatedAt: at },
            events,
        });
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        log.push(`${method} ${input}`);
        if (offline) {
            throw new NetworkError(input);
        }
        const path = new URL(input, 'https://brain.example.test').pathname;
        if (path === '/api/issues' && method === 'POST') {
            const body = init.json as Record<string, unknown>;
            bodies.push(body);
            const script = creates.shift() ?? 'ok';
            if (typeof script === 'object') {
                if (script.stores) {
                    file(body);
                }
                return script.raw === undefined
                    ? json(script.status, script.body ?? {})
                    : new Response(script.raw, { status: script.status });
            }
            const detail = file(body);
            if (script === 'drop') {
                throw new NetworkError(input);
            }
            return json(201, detail);
        }
        if (path === '/api/issues') {
            if (bodies.length < listAfter) {
                throw new NetworkError(input);
            }
            const issues = [...details.values()].map(({ issue }) => ({
                number: issue.number,
                title: issue.title,
                status: issue.status,
                priority: issue.priority,
                kind: issue.kind,
                area: issue.area,
                labels: issue.labels,
                assigneeId: issue.assigneeId,
                updatedAt: issue.updatedAt,
                excerpt: issue.body.slice(0, 160),
            }));
            return json(200, { issues, users: {} });
        }
        const match = /^\/api\/issues\/(\d+)$/.exec(path);
        if (match) {
            const detail = details.get(Number(match[1]));
            return detail === undefined ? json(404, { error: 'Issue not found.' }) : json(200, detail);
        }
        return json(404, { error: 'Not found.' });
    };

    return {
        fetch,
        details,
        creates,
        log,
        bodies,
        clock,
        file,
        edit,
        offline(on: boolean) {
            offline = on;
        },
        listAfter(count: number) {
            listAfter = count;
        },
        /** Issues filed by the person, oldest first. */
        mine: () => [...details.values()].filter((detail) => detail.issue.reporterId === ME).map((d) => d.issue),
        localReads: () => log.filter((line) => line.includes('pending-issue-')),
    };
}

type Server = ReturnType<typeof server>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

let ids = 0;
const newId = () => `id-${++ids}`;

interface Phone {
    readonly outbox: Outbox;
    readonly drafts: Drafts;
    readonly viewState: ViewState;
    readonly issues: LocalIssues | null;
    readonly resolved: [string, string][];
    readonly handedOff: [string, number][];
    readonly kind: OutboxKind<unknown>;
    relaunch(options?: { localIssues?: boolean }): Promise<Phone>;
    settle(): Promise<void>;
    until(done: () => boolean): Promise<void>;
}

interface Files {
    readonly user: Awaited<ReturnType<typeof userDb>>;
    readonly cacheDir: string;
}

async function open(
    srv: Server,
    options: { localIssues?: boolean; deviceNow?: number } = {},
    kept?: Files,
): Promise<Phone> {
    const user = kept?.user ?? (await userDb());
    const cacheDir = kept?.cacheDir ?? mkdtempSync(join(tmpdir(), 'socio-issue-create-'));
    if (!kept) {
        cleanups.push(() => {
            rmSync(user.directory, { recursive: true, force: true });
            rmSync(cacheDir, { recursive: true, force: true });
        });
    }
    const files: Files = { user, cacheDir };
    const userFile = await user.open();
    const cacheDb = await openCacheDb(createNodeSqliteDriver({ keys: new Map() }), cacheDir, CACHE_KEY);
    const handedOff: [string, number][] = [];
    const kind = issueCreateKind({
        issueDetails: { put: async (key, detail) => void handedOff.push([key, detail.issue.number]) },
    }) as OutboxKind<unknown>;
    // The device clock, 10 minutes off or not: only ordering reads it.
    const deviceNow = options.deviceNow ?? 1_000_000;
    const outbox = await openOutbox({
        db: userFile.db,
        state: userFile.state,
        kinds: [kind],
        fetch: srv.fetch,
        now: () => deviceNow,
        random: () => 0,
    });
    const drafts = await openDrafts({ db: userFile.db, state: userFile.state, outbox, now: () => deviceNow });
    const viewState = await openViewState(cacheDb.db);
    const resolved: [string, string][] = [];
    const issues = options.localIssues === false ? null : createLocalIssues({ outbox, drafts, viewState });
    issues?.subscribe((local, key) => resolved.push([local, key]));
    let closed = false;
    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        issues?.dispose();
        await drafts.close();
        await outbox.dispose();
        await viewState.close();
        await userFile.db.close().catch(() => {});
        await cacheDb.db.close().catch(() => {});
    };
    cleanups.push(close);
    outbox.start();
    const phone: Phone = {
        outbox,
        drafts,
        viewState,
        issues,
        resolved,
        handedOff,
        kind,
        async relaunch(next = {}) {
            await drafts.flush();
            await viewState.flush();
            await close();
            return open(srv, { ...options, ...next }, files);
        },
        async settle() {
            for (let i = 0; i < 3; i += 1) {
                await turns(10);
                await outbox.idle();
            }
            await turns(10);
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await phone.settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await phone.settle();
            }
        },
    };
    return phone;
}

const FIELDS: IssueFields = {
    title: 'Export fails',
    body: 'Steps:\n1. Export\n',
    kind: 'bug',
    priority: 'high',
    area: null,
};

/** The person fills FileIssue and files, the watermark taken from what the phone holds. */
async function file(phone: Phone, srv: Server, fields: Partial<IssueFields> = {}) {
    phone.drafts.write(ISSUE_DRAFT, issueDraftText({ ...FIELDS, ...fields }));
    const filed = await fileIssue({
        drafts: phone.drafts,
        newId,
        reporterId: ME,
        after: highestIssue([...srv.details.values()].map((detail) => detail.issue)),
        serverAt: srv.clock.now,
    });
    expect(filed).not.toBeNull();
    return filed!;
}

describe('filing an issue', () => {
    it('files it once: the title trimmed, the body as typed, the number in ids and the detail handed off', async () => {
        const srv = server();
        const phone = await open(srv);
        const { localKey, row } = await file(phone, srv, { title: '  Export fails  ', area: 'runs' });
        expect(isLocalIssue(localKey)).toBe(true);
        expect(isLocalChat(localKey)).toBe(false);
        expect(row.lane).toBe(`issue:${localKey}`);
        expect(phone.drafts.read(ISSUE_DRAFT).text).toBe('');
        await phone.settle();

        expect(srv.bodies).toEqual([
            { title: 'Export fails', body: 'Steps:\n1. Export\n', kind: 'bug', priority: 'high', area: 'runs' },
        ]);
        expect(srv.mine().map((issue) => issue.number)).toEqual([41]);
        expect(phone.outbox.resolve(ISSUE_IDS, localKey)).toBe('41');
        expect(serverIssueKey(phone.outbox.resolve, localKey)).toBe('41');
        expect(phone.issues!.resolve(localKey)).toBe('41');
        expect(phone.handedOff).toEqual([['41', 41]]);
        expect(phone.resolved).toEqual([[localKey, '41']]);
        expect(phone.outbox.rows()).toEqual([]);
        expect(srv.localReads()).toEqual([]);
    });

    it('sends no area or run it doesn’t have, and a run’s id when filed from one', async () => {
        const srv = server();
        const phone = await open(srv);
        await file(phone, srv);
        await file(phone, srv, { runId: 'run-7' });
        await phone.settle();
        expect(srv.bodies.map((body) => Object.keys(body).sort())).toEqual([
            ['body', 'kind', 'priority', 'title'],
            ['body', 'kind', 'priority', 'runId', 'title'],
        ]);
        expect(srv.bodies[1]!.runId).toBe('run-7');
    });

    it('refuses a box with no title, and keeps the box as it was', async () => {
        const srv = server();
        const phone = await open(srv);
        const text = issueDraftText({ ...FIELDS, title: '   ' });
        phone.drafts.write(ISSUE_DRAFT, text);
        await expect(fileIssue({ drafts: phone.drafts, newId, reporterId: ME, after: null })).rejects.toBeInstanceOf(
            IssueDraftError,
        );
        expect(phone.outbox.rows()).toEqual([]);
        expect(phone.drafts.read(ISSUE_DRAFT).text).toBe(text);
        // An empty box files nothing.
        phone.drafts.write(ISSUE_DRAFT, '');
        expect(await fileIssue({ drafts: phone.drafts, newId, reporterId: ME, after: null })).toBeNull();
    });

    it('stores the create, the rows that go with it and the cleared box in one transaction', async () => {
        const srv = server();
        srv.offline(true);
        const phone = await open(srv);
        await phone.outbox.enqueue({
            id: 'taken',
            lane: 'other',
            kind: 'unknown-kind',
            payload: '{}',
            payloadVersion: 1,
            idempotencyKey: 'k',
        });
        const text = issueDraftText(FIELDS);
        phone.drafts.write(ISSUE_DRAFT, text);
        // An issue attachment's row clashes with a stored id: nothing goes in.
        const more = (localKey: string) => [
            {
                id: 'taken',
                lane: `issue:${localKey}`,
                kind: 'issue-attachment',
                payload: '{}',
                payloadVersion: 1,
                idempotencyKey: 'k2',
                dependsOn: localKey,
            },
        ];
        await expect(fileIssue({ drafts: phone.drafts, newId, reporterId: ME, after: null, more })).rejects.toThrow();
        expect(phone.outbox.rows().map((row) => row.id)).toEqual(['taken']);
        expect(phone.drafts.read(ISSUE_DRAFT).text).toBe(text);
    });

    it('reads the box with the web’s defaults', () => {
        expect(readIssueDraft('{"title":"A"}')).toEqual({
            title: 'A',
            body: '',
            kind: 'bug',
            priority: 'medium',
            area: null,
        });
        expect(readIssueDraft('{"title":"A","kind":"nope","area":"runs","runId":"r"}')).toMatchObject({
            kind: 'bug',
            area: 'runs',
            runId: 'r',
        });
        expect(readIssueDraft('not json')).toBeNull();
    });
});

describe('components when filing (CB-442)', () => {
    it('sends the picked components, as version 2, and none (version 1) with none picked', async () => {
        const srv = server();
        const phone = await open(srv);
        const picked = await file(phone, srv, { components: ['plugin:forms', 'apps:*'] });
        const plain = await file(phone, srv);
        expect(picked.row.payloadVersion).toBe(2);
        expect(plain.row.payloadVersion).toBe(1);
        await phone.settle();
        expect(srv.bodies[0]!.components).toEqual(['plugin:forms', 'apps:*']);
        expect(Object.keys(srv.bodies[1]!)).not.toContain('components');
    });

    it('reads a draft’s components back: valid refs only, each once, at most ten', () => {
        const refs = Array.from({ length: 12 }, (_, n) => `app:a${n}`);
        expect(
            readIssueDraft(
                issueDraftText({ ...FIELDS, components: ['plugin:forms', 'plugin:forms', 'nope', ...refs] }),
            )!.components,
        ).toEqual(['plugin:forms', ...refs.slice(0, 9)]);
        expect(readIssueDraft(issueDraftText(FIELDS))!).not.toHaveProperty('components');
    });

    it('a server that refuses the field (before CB-442: 400) puts it in Unsent, and Edit keeps the components', async () => {
        const srv = server();
        srv.creates.push({ status: 400, body: { error: 'Unknown field: components.' } });
        const phone = await open(srv);
        await file(phone, srv, { components: ['plugin:forms'] });
        await phone.settle();
        const [write] = phone.outbox.unsent();
        expect(write!.reason).toBe('issue-invalid');
        expect(unsentIssueFields(write!)!.components).toEqual(['plugin:forms']);
    });
});

describe('offline and exactly once', () => {
    it('offline: waits, survives a relaunch, and files once online', async () => {
        const srv = server();
        let phone = await open(srv);
        srv.offline(true);
        const { localKey } = await file(phone, srv);
        await phone.settle();
        expect(srv.mine()).toEqual([]);
        phone = await phone.relaunch();
        await phone.settle();
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.mine()).toHaveLength(1);
        expect(phone.outbox.resolve(ISSUE_IDS, localKey)).toBe(String(srv.mine()[0]!.number));
    });

    it('a kill after the server filed it, before the answer: the check finds it, exactly one', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.creates.push('drop');
        const { localKey } = await file(phone, srv);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.mine()).toHaveLength(1);
        expect(srv.log.filter((line) => line === 'POST /api/issues')).toHaveLength(1);
        expect(phone.outbox.resolve(ISSUE_IDS, localKey)).toBe('41');
        expect(phone.handedOff).toEqual([['41', 41]]);
    });

    it('an admin triaging and retitling it before the check runs: still found by its values at filing', async () => {
        const srv = server();
        let phone = await open(srv);
        srv.creates.push('drop');
        srv.offline(false);
        const { localKey } = await file(phone, srv, { title: 'Crash on save ' });
        // The answer is lost, the app dies, and an admin triages before it opens again.
        await phone.settle();
        srv.offline(true);
        phone = await phone.relaunch();
        srv.edit(41, {
            status: 'todo',
            priority: 'critical',
            kind: 'improvement',
            area: 'runs',
            title: 'Saving crashes',
        });
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.mine()).toHaveLength(1);
        expect(phone.outbox.resolve(ISSUE_IDS, localKey)).toBe('41');
        expect(filedValue(srv.details.get(41)!, 'title')).toBe('Crash on save');
        expect(filedValue(srv.details.get(41)!, 'kind')).toBe('bug');
    });

    it('two identical filings at once: two issues online, and two lost answers are the person’s to decide', async () => {
        const srv = server();
        const phone = await open(srv);
        const one = await file(phone, srv);
        const two = await file(phone, srv);
        await phone.settle();
        expect(srv.mine()).toHaveLength(2);
        expect(new Set([one.localKey, two.localKey].map((key) => phone.outbox.resolve(ISSUE_IDS, key)))).toEqual(
            new Set(['41', '42']),
        );

        // Both stored, both answers lost: each check sees two that match and can't tell.
        srv.creates.push('drop', 'drop');
        srv.listAfter(4);
        const three = await file(phone, srv);
        await file(phone, srv);
        await phone.until(() => phone.outbox.holds().length === 2);
        expect(srv.mine()).toHaveLength(4);
        const candidates = filingCandidates(phone.outbox.holds());
        expect(candidates.get(three.localKey)).toEqual(['43', '44']);
        // View opens each candidate issue in turn.
        expect(nextIssueCandidate(['43', '44'], null)).toBe('43');
        expect(nextIssueCandidate(['43', '44'], '43')).toBe('44');
        expect(nextIssueCandidate(['43', '44'], '44')).toBe('43');
        expect(nextIssueCandidate([], null)).toBeNull();
        // Kind, priority and area break the tie where they differ.
        srv.creates.push('drop', 'drop');
        srv.listAfter(6);
        const low = await file(phone, srv, { title: 'Same', priority: 'low' });
        const high = await file(phone, srv, { title: 'Same', priority: 'high' });
        await phone.until(
            () =>
                phone.outbox.resolve(ISSUE_IDS, high.localKey) !== null &&
                phone.outbox.resolve(ISSUE_IDS, low.localKey) !== null,
        );
        expect(phone.outbox.resolve(ISSUE_IDS, low.localKey)).toBe('45');
        expect(phone.outbox.resolve(ISSUE_IDS, high.localKey)).toBe('46');
    });

    it('none found after no answer files again; none after an error answer waits for the person', async () => {
        const srv = server();
        const phone = await open(srv);
        // The connection dropped before the server filed anything: offline for the POST only.
        srv.creates.push({ status: 502, raw: '<html>Bad gateway</html>' });
        const { localKey } = await file(phone, srv);
        await phone.settle();
        // A proxy's page, and the list has none: the server may still be filing it.
        expect(srv.mine()).toEqual([]);
        const row = phone.outbox.rows().find((item) => item.id === localKey)!;
        expect(row.state).toBe('unknown');
        expect(row.lastError).toBe('unconfirmed');
        expect(phone.outbox.holds().map((group) => group.root.cause)).toEqual(['unconfirmed']);
        // Send again: it goes once.
        await phone.outbox.sendNow(localKey);
        await phone.until(() => phone.outbox.rows().length === 0);
        expect(srv.mine()).toHaveLength(1);
    });

    it('a device clock 10 minutes off either way changes nothing', async () => {
        for (const skew of [-10 * 60_000, 10 * 60_000]) {
            const srv = server();
            const phone = await open(srv, { deviceNow: 1_000_000 + skew });
            srv.creates.push('drop');
            await file(phone, srv);
            await phone.until(() => phone.outbox.rows().length === 0);
            expect(srv.mine()).toHaveLength(1);
        }
    });

    it('an issue filed before the watermark, with the same title, is never taken for it', async () => {
        const srv = server();
        const phone = await open(srv);
        // Someone filed the same words long ago, and the phone never held it (no number watermark).
        srv.file({ title: 'Export fails', body: FIELDS.body, kind: 'bug', priority: 'high' });
        srv.clock.now += SERVER_CLOCK_SLACK_MS * 3;
        srv.creates.push({ status: 503, raw: 'proxy' });
        phone.drafts.write(ISSUE_DRAFT, issueDraftText(FIELDS));
        await fileIssue({ drafts: phone.drafts, newId, reporterId: ME, after: null, serverAt: srv.clock.now });
        await phone.settle();
        expect(phone.outbox.holds().map((group) => group.root.candidates)).toEqual([[]]);
    });

    it('a kill between every two steps loses no filing and files none twice', { timeout: 120_000 }, async () => {
        // The steps of one filing, unkilled.
        const count = async (at: number) => {
            const srv = server();
            const user = await userDb();
            const cacheDir = mkdtempSync(join(tmpdir(), 'socio-issue-kill-'));
            cleanups.push(() => {
                rmSync(user.directory, { recursive: true, force: true });
                rmSync(cacheDir, { recursive: true, force: true });
            });
            const kill = killAt(at);
            const userFile = await user.open();
            let enqueued = false;
            const run = (async () => {
                const outbox = await openOutbox({
                    db: kill.db(userFile.db),
                    state: userFile.state,
                    kinds: [issueCreateKind() as OutboxKind<unknown>],
                    fetch: kill.fetch(srv.fetch),
                    random: () => 0,
                });
                outbox.start();
                await outbox.enqueue({
                    id: 'pending-issue-kill',
                    lane: 'issue:pending-issue-kill',
                    kind: ISSUE_CREATE_KIND,
                    payload: JSON.stringify({ ...FIELDS, reporterId: ME, after: 40, serverAt: srv.clock.now }),
                    payloadVersion: 1,
                    idempotencyKey: 'key',
                });
                enqueued = true;
                await outbox.idle();
                await outbox.dispose();
            })();
            await Promise.race([
                run,
                (async () => {
                    while (!kill.killed) {
                        await turns(1);
                    }
                    await turns();
                })(),
            ]);
            await userFile.db.close().catch(() => {});
            // The next launch, unkilled, on the same files.
            const phone = await open(srv, {}, { user, cacheDir });
            await phone.until(() => phone.outbox.rows().length === 0);
            return { steps: kill.steps, killed: kill.killed, enqueued, filed: srv.mine().length, phone };
        };
        const clean = await count(-1);
        expect(clean.killed).toBe(false);
        expect(clean.filed).toBe(1);
        for (let at = 0; at < clean.steps.length; at += 1) {
            const result = await count(at);
            expect(result.killed).toBe(true);
            expect({ at, filed: result.filed }).toEqual({ at, filed: result.enqueued ? 1 : 0 });
            if (result.enqueued) {
                expect(result.phone.outbox.resolve(ISSUE_IDS, 'pending-issue-kill')).toBe('41');
            }
        }
    });
});

describe('refusals and Edit', () => {
    it('a 404 for its run, 400 and 403 go to Unsent in 10.2’s words, never the server’s', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.creates.push(
            { status: 404, body: { error: 'Run not found.' } },
            { status: 400, body: { error: 'Enter a title of 3 to 200 characters.' } },
            { status: 403, body: { error: 'Only an admin can change this.' } },
        );
        await file(phone, srv, { runId: 'run-gone' });
        await file(phone, srv, { title: 'Two' });
        await file(phone, srv, { title: 'Three' });
        await phone.settle();
        expect(phone.outbox.unsent().map((write) => write.reason)).toEqual([
            'run-gone',
            'issue-invalid',
            'issue-refused',
        ]);
        const rows = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(rows.map((row) => [row.what, row.where, row.why, row.editable])).toEqual([
            ['New issue', 'Board', 'That run is no longer available', true],
            ['New issue', 'Board', 'It couldn’t be filed as written', true],
            ['New issue', 'Board', 'You can’t file it like this', true],
        ]);
        expect(rows[0]!.text).toBe('Export fails\n\nSteps:\n1. Export\n');
        expect(JSON.stringify(rows)).not.toContain('Only an admin');
    });

    it('Edit reopens what was written and sends the refused filing again in place, once', async () => {
        const srv = server();
        const phone = await open(srv);
        srv.creates.push({ status: 400, body: { error: 'Enter a title of 3 to 200 characters.' } });
        const { localKey } = await file(phone, srv, { title: 'No', area: 'runs', runId: 'run-1' });
        await phone.settle();
        const write = phone.outbox.unsent()[0]!;
        const fields = unsentIssueFields(write)!;
        expect(fields).toEqual({ ...FIELDS, title: 'No', area: 'runs', runId: 'run-1' });
        expect(
            await resendIssue({
                outbox: phone.outbox,
                id: localKey,
                fields: { ...fields, title: 'Now longer' },
                idempotencyKey: 'k-new',
            }),
        ).toBe(true);
        await phone.settle();
        expect(phone.outbox.unsent()).toEqual([]);
        expect(srv.mine().map((issue) => issue.title)).toEqual(['Now longer']);
        expect(phone.outbox.resolve(ISSUE_IDS, localKey)).toBe('41');
        expect(await resendIssue({ outbox: phone.outbox, id: localKey, fields, idempotencyKey: 'k3' })).toBe(false);
    });
});

describe('on the board and re-keying', () => {
    it('lays a CB-? row over Triage, newest first, in 10.2’s words', async () => {
        const srv = server();
        srv.offline(true);
        const phone = await open(srv);
        const first = await file(phone, srv, { title: 'First' });
        const second = await file(phone, srv, { title: 'Second' });
        await phone.settle();
        const overlays = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: phone.outbox.unsent(),
            kinds: [phone.kind],
            scope: phone.outbox,
        });
        const rows = pendingIssueRows(overlays, filingCandidates(phone.outbox.holds()));
        expect(rows.map((row) => [row.key, row.label, row.title, row.words])).toEqual([
            [second.localKey, PENDING_ISSUE_LABEL, 'Second', 'Waiting to send'],
            [first.localKey, PENDING_ISSUE_LABEL, 'First', 'Waiting to send'],
        ]);
        expect(rows[0]!.actions).toEqual([]);
        expect(filingText({ title: 'T', body: '  ' })).toBe('T');
    });

    it('moves the comment draft and the last screen to the number, also after a kill between the settle and the moves', async () => {
        const srv = server();
        let phone = await open(srv, { localIssues: false });
        srv.offline(true);
        const { localKey } = await file(phone, srv);
        phone.drafts.write(issueCommentsDraft(localKey), 'A first comment');
        phone.viewState.set(LAST_SCREEN_KEY, issueScreen(localKey));
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.rows().length === 0);
        // Settled with no one to move anything (the kill came first).
        expect(phone.drafts.read(issueCommentsDraft(localKey)).text).toBe('A first comment');
        phone = await phone.relaunch({ localIssues: true });
        expect(phone.drafts.read(issueCommentsDraft('41')).text).toBe('A first comment');
        expect(phone.drafts.read(issueCommentsDraft(localKey)).text).toBe('');
        expect(keptIssue(phone.viewState.get(LAST_SCREEN_KEY))).toBe('41');
    });
});
