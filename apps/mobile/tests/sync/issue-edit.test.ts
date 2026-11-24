import { afterEach, describe, expect, it } from 'vitest';

import { compareBoardOrder } from '@socio/shared/issues/issue-board';
import type { Issue, IssueDetail } from '@socio/shared/issues/issue-types';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { unsentListRows } from '../../src/shell/unsent';
import { openDrafts } from '../../src/sync/chat-drafts';
import { fileIssue, ISSUE_DRAFT, issueCreateKind, issueDraftText } from '../../src/sync/issue-create';
import {
    editIssue,
    ISSUE_EDIT_REFUSALS,
    ISSUE_EDIT_VIEWS,
    ISSUE_UPDATE_KIND,
    issueEditKinds,
    IssueEditError,
    isIssueConflict,
    keepMine,
    keepTheirs,
    voteOnIssue,
} from '../../src/sync/issue-edit';
import { ISSUE_IDS } from '../../src/sync/local-ids';
import { type Outbox, type OutboxKind, openOutbox, UNSENT_GONE } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';

import { turns, userDb } from './outbox-fakes';

// Editing issues and voting: field edits and votes on a real outbox (user.db),
// against a fake server whose routes answer as src/server/issues's do: `PATCH` takes only
// `issuePatch`'s fields and refuses a member's triage field (403), votes are
// one per person and safe to repeat, and every write answers the detail.

const ME = 'user-me';

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function server() {
    const details = new Map<number, IssueDetail>();
    const voters = new Map<number, Set<string>>();
    const log: string[] = [];
    let offline = false;
    let clock = 10_000_000;
    let last = 40;
    /** Fields a member may edit (`patchRefusal`): anything else is a 403. */
    let member = false;
    /** While set, a PATCH waits for it: its row stays in flight. */
    let gate: Promise<void> | null = null;

    const withVotes = (detail: IssueDetail): IssueDetail => {
        const set = voters.get(detail.issue.number) ?? new Set();
        return { ...detail, issue: { ...detail.issue, votes: set.size, voted: set.has(ME) } };
    };

    const issue = (number = ++last, fields: Partial<Issue> = {}): IssueDetail => {
        const at = (clock += 1_000);
        const detail = {
            issue: {
                id: `issue-${number}`,
                number,
                title: 'Export fails',
                body: 'Steps.',
                status: 'triage',
                priority: 'medium',
                kind: 'bug',
                area: null,
                labels: [],
                reporterId: ME,
                assigneeId: null,
                resolution: null,
                source: 'web',
                createdAt: at,
                updatedAt: at,
                closedAt: null,
                ...fields,
            },
            comments: [],
            attachments: [],
            events: [],
            users: {},
        } as unknown as IssueDetail;
        details.set(number, detail);
        return detail;
    };

    /** Someone else changes the issue (the web, an admin). */
    const change = (number: number, fields: Partial<Issue>) => {
        const detail = details.get(number)!;
        details.set(number, { ...detail, issue: { ...detail.issue, ...fields, updatedAt: (clock += 1_000) } });
    };

    const fetch: AuthedFetch = async (input: string, init: AuthedRequestInit = {}) => {
        const method = init.method ?? 'GET';
        if (offline) {
            throw new NetworkError(input);
        }
        log.push(`${method} ${input}${init.json === undefined ? '' : ` ${JSON.stringify(init.json)}`}`);
        if (input === '/api/issues' && method === 'POST') {
            const body = init.json as { title: string; body: string };
            return json(201, withVotes(issue(undefined, { title: body.title, body: body.body })));
        }
        const match = /^\/api\/issues\/(\d+)(\/vote)?$/.exec(input);
        const number = match ? Number(match[1]) : NaN;
        const detail = details.get(number);
        if (!match || detail === undefined) {
            return json(404, { error: 'Issue not found.' });
        }
        if (method === 'GET') {
            return json(200, withVotes(detail));
        }
        if (match[2] !== undefined) {
            const set = voters.get(number) ?? new Set<string>();
            voters.set(number, set);
            if (method === 'POST') {
                set.add(ME);
            } else {
                set.delete(ME);
            }
            return json(200, withVotes(details.get(number)!));
        }
        if (method === 'PATCH') {
            await gate;
            const patch = init.json as Record<string, unknown>;
            if (member && Object.keys(patch).some((key) => key !== 'title' && key !== 'body')) {
                return json(403, { error: 'Only an admin can change this.' });
            }
            if (typeof patch.title === 'string' && patch.title.trim().length < 3) {
                return json(400, { error: 'Invalid request.' });
            }
            change(number, patch as Partial<Issue>);
            return json(200, withVotes(details.get(number)!));
        }
        return json(404, {});
    };

    return {
        fetch,
        details,
        log,
        issue,
        change,
        offline: (on: boolean) => void (offline = on),
        member: (on: boolean) => void (member = on),
        /** Holds PATCHes until the returned release is called. */
        hold: () => {
            let release = () => {};
            gate = new Promise<void>((resolve) => (release = resolve));
            return () => {
                gate = null;
                release();
            };
        },
        writes: () => log.filter((line) => !line.startsWith('GET')),
        get: (number: number) => withVotes(details.get(number)!).issue,
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
    readonly held: Map<string, IssueDetail>;
    readonly wrote: string[];
    file(title: string): Promise<string>;
    until(done: () => boolean): Promise<void>;
}

async function open(srv: Server, { start = true }: { start?: boolean } = {}): Promise<Phone> {
    const user = await userDb();
    const file = await user.open();
    const held = new Map<string, IssueDetail>();
    const wrote: string[] = [];
    const issueDetails = { put: async (key: string, detail: IssueDetail) => void held.set(key, detail) };
    const outbox = await openOutbox({
        db: file.db,
        state: file.state,
        kinds: [
            issueCreateKind({ issueDetails }) as OutboxKind<unknown>,
            ...issueEditKinds({ issueDetails, afterWrite: (path) => wrote.push(path) }),
        ],
        fetch: srv.fetch,
        random: () => 0,
    });
    const drafts = await openDrafts({ db: file.db, state: file.state, outbox });
    cleanups.push(async () => {
        await drafts.close();
        await outbox.dispose();
        await file.db.close().catch(() => {});
    });
    cleanups.unshift(async () => {
        const { rmSync } = await import('node:fs');
        rmSync(user.directory, { recursive: true, force: true });
    });
    if (start) {
        outbox.start();
    }
    const settle = async () => {
        for (let i = 0; i < 3; i += 1) {
            await turns(10);
            await outbox.idle();
        }
        await turns(10);
    };
    return {
        outbox,
        held,
        wrote,
        async file(title) {
            drafts.write(ISSUE_DRAFT, issueDraftText({ title, body: 'Steps.' }));
            const filed = await fileIssue({ drafts, newId, reporterId: ME, after: null, serverAt: null });
            return filed!.localKey;
        },
        async until(done) {
            const end = Date.now() + 15_000;
            await settle();
            while (!done()) {
                if (Date.now() > end) {
                    throw new Error('Timed out waiting for the outbox.');
                }
                await new Promise((resolve) => setTimeout(resolve, 50));
                await settle();
            }
        },
    };
}

const idle = (phone: Phone) => () => phone.outbox.rows().length === 0;

describe('editing an issue’s fields', () => {
    it('sends only the changed fields, the title trimmed, and hands the answer’s detail off', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        const base = srv.get(41);
        const result = await editIssue(phone.outbox, {
            issue: '41',
            changes: { title: '  Export fails on Safari ', priority: 'high', body: 'Steps.' },
            base,
            newId,
        });
        expect(result).toBe('queued');
        expect(phone.outbox.rows()[0]!.lane).toBe('issue:41');
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual([`PATCH /api/issues/41 {"title":"Export fails on Safari","priority":"high"}`]);
        expect(phone.held.get('41')!.issue.title).toBe('Export fails on Safari');
        expect(phone.wrote).toEqual(['/api/issues/41']);
    });

    it('refuses a title the server won’t take before anything is written', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        await expect(
            editIssue(phone.outbox, { issue: '41', changes: { title: ' ab ' }, base: srv.get(41), newId }),
        ).rejects.toBeInstanceOf(IssueEditError);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('folds two edits into one row, keeping the first base, and drops a field changed back', async () => {
        const srv = server();
        srv.issue();
        // Offline: nothing has gone yet.
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { priority: 'high', title: 'First' }, base, newId });
        // The screen now shows the overlay's values; the base stays the server's.
        const shown = { ...base, priority: 'high' as const, title: 'First' };
        expect(
            await editIssue(phone.outbox, {
                issue: '41',
                changes: { priority: 'critical', title: 'Export fails' },
                base: shown,
                newId,
            }),
        ).toBe('folded');
        expect(phone.outbox.rows()).toHaveLength(1);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload)).toEqual({
            issue: '41',
            fields: { priority: { value: 'critical', base: 'medium' } },
        });
        phone.outbox.start();
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual([`PATCH /api/issues/41 {"priority":"critical"}`]);
    });

    it('applies quick label taps to the newest labels, so two taps without waiting keep both', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        // Both taps from the same drawn values: the screen hasn't caught up.
        const base = srv.get(41);
        const taps = [
            editIssue(phone.outbox, { issue: '41', changes: {}, base, newId, toggleLabel: 'ux' }),
            editIssue(phone.outbox, { issue: '41', changes: {}, base, newId, toggleLabel: 'regression' }),
            editIssue(phone.outbox, { issue: '41', changes: {}, base, newId, toggleLabel: 'dot-request' }),
        ];
        expect(await Promise.all(taps)).toEqual(['queued', 'folded', 'folded']);
        expect(JSON.parse(phone.outbox.rows()[0]!.payload).fields.labels.value).toEqual([
            'regression',
            'ux',
            'dot-request',
        ]);
        // A tap on one already on turns it off, from the queued row's value.
        await editIssue(phone.outbox, { issue: '41', changes: {}, base, newId, toggleLabel: 'ux' });
        phone.outbox.start();
        await phone.until(idle(phone));
        expect(srv.get(41).labels).toEqual(['regression', 'dot-request']);
    });

    it('a field changed back to its base leaves no row at all', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { area: 'chat' }, base, newId });
        expect(await editIssue(phone.outbox, { issue: '41', changes: { area: null }, base, newId })).toBe('none');
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('a field changed back just as its row starts going is set back by a row of its own', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { priority: 'high' }, base, newId });
        const release = srv.hold();
        // Runs first (cleanups go in reverse), so a failing test doesn't leave the PATCH held.
        cleanups.push(release);
        // The lane dispatches between reading the queued row and removing it.
        const racing: typeof phone.outbox = Object.create(phone.outbox, {
            remove: {
                value: async (...args: Parameters<Outbox['remove']>) => {
                    phone.outbox.start();
                    // Not `until`: the outbox isn't idle while the PATCH is held.
                    while (phone.outbox.rows()[0]?.state !== 'inflight') {
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    return phone.outbox.remove(...args);
                },
            },
        });
        expect(await editIssue(racing, { issue: '41', changes: { priority: 'medium' }, base, newId })).toBe('queued');
        expect(JSON.parse(phone.outbox.rows()[1]!.payload)).toEqual({
            issue: '41',
            fields: { priority: { value: 'medium', base: 'high' } },
        });
        release();
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual([
            `PATCH /api/issues/41 {"priority":"high"}`,
            `PATCH /api/issues/41 {"priority":"medium"}`,
        ]);
        expect(srv.get(41).priority).toBe('medium');
        expect(phone.outbox.unsent()).toEqual([]);
    });

    it('a field changed on the server first goes to Unsent; Keep mine re-bases and sends, Keep theirs discards', async () => {
        const srv = server();
        srv.issue();
        srv.issue();
        const phone = await open(srv);
        srv.offline(true);
        await editIssue(phone.outbox, { issue: '41', changes: { priority: 'high' }, base: srv.get(41), newId });
        await editIssue(phone.outbox, { issue: '42', changes: { title: 'Mine' }, base: srv.get(42), newId });
        srv.change(41, { priority: 'low' });
        srv.change(42, { title: 'Theirs' });
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(() => phone.outbox.unsent().length === 2);
        expect(srv.writes()).toEqual([]);
        const [first, second] = phone.outbox.unsent();
        expect(isIssueConflict(first!)).toBe(true);
        expect(second!.reason).toBe(ISSUE_EDIT_REFUSALS.conflict);
        // The screen shows theirs beside the two buttons.
        expect(phone.held.get('41')!.issue.priority).toBe('low');
        const rows = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect(rows.map((row) => [row.what, row.where, row.why, row.text])).toEqual([
            ['Issue edit', 'CB-41', 'Couldn’t save: someone changed it first', null],
            ['Issue edit', 'CB-42', 'Couldn’t save: someone changed it first', 'Mine'],
        ]);

        expect(await keepMine(phone.outbox, { id: first!.id, current: srv.get(41), idempotencyKey: newId() })).toBe(
            true,
        );
        expect(await keepTheirs(phone.outbox, second!.id)).toBe(true);
        await phone.until(() => idle(phone)() && phone.outbox.unsent().length === 0);
        expect(srv.writes()).toEqual([`PATCH /api/issues/41 {"priority":"high"}`]);
        expect(srv.get(42).title).toBe('Theirs');
    });

    it('a field the server already has (an attempt that landed) sends nothing and settles', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        srv.offline(true);
        await editIssue(phone.outbox, { issue: '41', changes: { status: 'ready' }, base: srv.get(41), newId });
        srv.change(41, { status: 'ready' });
        srv.offline(false);
        phone.outbox.poke();
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual([]);
        expect(phone.outbox.unsent()).toEqual([]);
        expect(phone.held.get('41')!.issue.status).toBe('ready');
    });

    it('a member’s triage field is a 403 in Unsent, in 10.2’s words, and holds the issue’s later edits', async () => {
        const srv = server();
        srv.issue();
        srv.member(true);
        const phone = await open(srv, { start: false });
        await editIssue(phone.outbox, { issue: '41', changes: { priority: 'high' }, base: srv.get(41), newId });
        phone.outbox.start();
        await phone.until(() => phone.outbox.unsent().length === 1);
        await editIssue(phone.outbox, { issue: '41', changes: { title: 'Allowed' }, base: srv.get(41), newId });
        await phone.until(() => true);
        const [refused] = phone.outbox.unsent();
        expect(refused!.reason).toBe(ISSUE_EDIT_REFUSALS.forbidden);
        const [row] = unsentListRows(phone.outbox.unsent(), phone.outbox.holds(), {
            chatTitle: () => null,
            resolve: () => null,
        });
        expect([row!.why, row!.holding]).toEqual(['You can’t change this', '1 more waits behind it']);
        expect(await phone.outbox.discardUnsent(refused!.id)).not.toBeNull();
        await phone.until(idle(phone));
        expect(srv.get(41).title).toBe('Allowed');
    });

    it('an issue deleted with an edit and a vote queued: both go to Unsent as gone', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { title: 'Gone soon' }, base, newId });
        await voteOnIssue(phone.outbox, { issue: '41', vote: true, base: { voted: false, votes: 0 }, newId });
        srv.details.delete(41);
        phone.outbox.start();
        await phone.until(() => phone.outbox.unsent().length === 2);
        expect(phone.outbox.unsent().map((write) => write.reason)).toEqual([UNSENT_GONE, UNSENT_GONE]);
        expect(srv.writes()).toEqual(['POST /api/issues/41/vote']);
    });

    it('an edit of a CB-? issue goes after its create, under its number', async () => {
        const srv = server();
        const phone = await open(srv, { start: false });
        const key = await phone.file('Filed offline');
        await editIssue(phone.outbox, {
            issue: key,
            changes: { body: 'More steps.' },
            base: { title: 'Filed offline', body: 'Steps.' },
            newId,
        });
        const edit = phone.outbox.rows().find((row) => row.kind === ISSUE_UPDATE_KIND)!;
        expect([edit.lane, edit.dependsOn]).toEqual([`issue:${key}`, key]);
        phone.outbox.start();
        await phone.until(idle(phone));
        const number = phone.outbox.resolve(ISSUE_IDS, key)!;
        expect(srv.writes()).toEqual([
            'POST /api/issues {"title":"Filed offline","body":"Steps.","kind":"bug","priority":"medium"}',
            `PATCH /api/issues/${number} {"body":"More steps."}`,
        ]);
    });

    it('lays the pending fields over the issue’s row, so a pending priority re-sorts the board', async () => {
        const srv = server();
        srv.issue(41, { priority: 'high' });
        srv.issue(42, { priority: 'medium' });
        const phone = await open(srv, { start: false });
        await editIssue(phone.outbox, { issue: '42', changes: { priority: 'critical' }, base: srv.get(42), newId });
        const items = overlaysOf({
            rows: phone.outbox.rows(),
            kinds: ISSUE_EDIT_VIEWS,
            scope: { resolve: () => null },
        });
        expect(items.map((item) => [item.collection, item.key, item.mode, item.value])).toEqual([
            ['issues', '42', 'patch', { priority: 'critical' }],
        ]);
        const rows = [srv.get(41), srv.get(42)].map((row) => {
            const patch = items.find((item) => item.key === String(row.number))?.value as Partial<Issue> | undefined;
            return { ...row, ...patch };
        });
        expect([...rows].sort(compareBoardOrder).map((row) => row.number)).toEqual([42, 41]);
    });
});

describe('editing an issue’s components (CB-442, admins only)', () => {
    it('sends the new set as one PATCH, folds a second tap, and marks the row as version 2', async () => {
        const srv = server();
        srv.issue(undefined, { components: ['plugin:forms'] } as Partial<Issue>);
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, {
            issue: '41',
            changes: { components: ['plugin:forms', 'app:crm'] },
            base,
            newId,
        });
        expect(
            await editIssue(phone.outbox, {
                issue: '41',
                changes: { components: ['plugin:forms', 'app:crm', 'apps:*'] },
                base,
                newId,
            }),
        ).toBe('folded');
        const [row] = phone.outbox.rows();
        expect(row!.payloadVersion).toBe(2);
        expect(JSON.parse(row!.payload).fields.components).toEqual({
            value: ['plugin:forms', 'app:crm', 'apps:*'],
            base: ['plugin:forms'],
        });
        phone.outbox.start();
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual([`PATCH /api/issues/41 {"components":["plugin:forms","app:crm","apps:*"]}`]);
    });

    it('a set changed back, in any order, leaves no row; another field’s edit stays version 1', async () => {
        const srv = server();
        srv.issue(undefined, { components: ['plugin:forms', 'app:crm'] } as Partial<Issue>);
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { components: ['plugin:forms'] }, base, newId });
        expect(
            await editIssue(phone.outbox, {
                issue: '41',
                changes: { components: ['app:crm', 'plugin:forms'] },
                base,
                newId,
            }),
        ).toBe('none');
        await editIssue(phone.outbox, { issue: '41', changes: { priority: 'high' }, base, newId });
        expect(phone.outbox.rows().map((row) => row.payloadVersion)).toEqual([1]);
    });

    it('refuses an eleventh component or a ref that isn’t one, before anything is written', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        const eleven = Array.from({ length: 11 }, (_, n) => `plugin:p${n}`);
        await expect(
            editIssue(phone.outbox, {
                issue: '41',
                changes: { components: eleven },
                base: { ...base, components: [] },
                newId,
            }),
        ).rejects.toBeInstanceOf(IssueEditError);
        await expect(
            editIssue(phone.outbox, {
                issue: '41',
                changes: { components: ['forms'] },
                base: { ...base, components: [] },
                newId,
            }),
        ).rejects.toBeInstanceOf(IssueEditError);
        expect(phone.outbox.rows()).toEqual([]);
    });

    it('components another admin changed first go to Unsent as a conflict', async () => {
        const srv = server();
        srv.issue(undefined, { components: [] } as Partial<Issue>);
        const phone = await open(srv, { start: false });
        const base = srv.get(41);
        await editIssue(phone.outbox, { issue: '41', changes: { components: ['plugin:forms'] }, base, newId });
        srv.change(41, { components: ['app:crm'] } as Partial<Issue>);
        phone.outbox.start();
        await phone.until(idle(phone));
        expect(phone.outbox.unsent().map((write) => write.reason)).toEqual([ISSUE_EDIT_REFUSALS.conflict]);
        expect(srv.writes()).toEqual([]);
    });

    it('lays the pending components over the issue’s row', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        await editIssue(phone.outbox, {
            issue: '41',
            changes: { components: ['plugins:*'] },
            base: { ...srv.get(41), components: [] },
            newId,
        });
        const [overlay] = overlaysOf({
            rows: phone.outbox.rows(),
            unsent: [],
            kinds: ISSUE_EDIT_VIEWS,
            scope: phone.outbox,
        });
        expect(overlay).toMatchObject({ collection: 'issues', key: '41', value: { components: ['plugins:*'] } });
    });
});

describe('voting', () => {
    it('vote, unvote and vote offline make one POST, and the overlay shows the vote', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv, { start: false });
        const base = { voted: false, votes: 0 };
        expect(await voteOnIssue(phone.outbox, { issue: '41', vote: true, base, newId })).toBe('queued');
        expect(await voteOnIssue(phone.outbox, { issue: '41', vote: false, base, newId })).toBe('folded');
        expect(await voteOnIssue(phone.outbox, { issue: '41', vote: true, base, newId })).toBe('folded');
        expect(phone.outbox.rows().map((row) => row.lane)).toEqual(['vote:41']);
        const items = overlaysOf({
            rows: phone.outbox.rows(),
            kinds: ISSUE_EDIT_VIEWS,
            scope: { resolve: () => null },
        });
        expect(items.map((item) => item.value)).toEqual([{ voted: true, votes: 1 }]);
        phone.outbox.start();
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual(['POST /api/issues/41/vote']);
        expect(phone.held.get('41')!.issue).toMatchObject({ voted: true, votes: 1 });
    });

    it('withdrawing goes as DELETE, and a vote whose answer was lost goes again safely', async () => {
        const srv = server();
        srv.issue();
        const phone = await open(srv);
        await voteOnIssue(phone.outbox, { issue: '41', vote: true, base: { voted: false, votes: 0 }, newId });
        await phone.until(idle(phone));
        await voteOnIssue(phone.outbox, { issue: '41', vote: false, base: { voted: true, votes: 1 }, newId });
        await phone.until(idle(phone));
        expect(srv.writes()).toEqual(['POST /api/issues/41/vote', 'DELETE /api/issues/41/vote']);
        expect(srv.get(41)).toMatchObject({ voted: false, votes: 0 });
    });
});
