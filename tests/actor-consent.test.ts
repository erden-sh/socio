import { afterEach, expect, it, vi } from 'vitest';

import {
    SOCIO_ACCESS_APPROVAL_TTL_MS,
    SOCIO_ACCESS_CAPABILITIES,
    type AppAccessCard,
    type SocioGrantView,
} from '@socio/shared/socio-access';

import { paramCounts } from '../src/server/actors/consent.js';
import { ApprovalError } from '../src/server/approvals/contract.js';
import { approvalNotice } from '../src/server/approvals/notices.js';

import { RLO, ZWSP, api, cleanup, pendingId, setup } from './support/consent-fixture.js';

// CB-232: request_app_access and end_app_access, the access
// approvals (who may skip the card, alwaysAsk, 15-minute expiry, the
// cap), the grants they make, and /api/actors. Refusals first.

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

// --- Refusals -----------------------------------------------------------

it('refuses while the flag is off for the person', async () => {
    const f = await setup({ flag: false });
    expect(await f.ask({ app: 'crm' })).toEqual({
        status: 'refused',
        error: expect.stringMatching(/isn’t available/),
    });
    expect(await f.platform.approvals.list('alice')).toEqual([]);
});

it('refuses in Telegram groups and topics: ask me in a private chat', async () => {
    const f = await setup();
    vi.spyOn(f.workspace.telegram, 'threadInfo').mockResolvedValue({
        kind: 'group',
    } as never);
    expect(await f.ask({ app: 'crm' })).toEqual({
        status: 'refused',
        error: expect.stringMatching(/ask me in a private chat/),
    });
    expect(await f.platform.approvals.list('alice')).toEqual([]);
});

it('refuses a scheduled run whose task lives in a Telegram group or topic', async () => {
    const f = await setup();
    const task = await f.platform.store.createTask('Check the chart', 3600, 'alice');
    const scheduled = {
        ...f.turn('alice', f.chat.id),
        cause: { kind: 'schedule' as const, id: task.id },
    };
    const threadInfo = vi.spyOn(f.workspace.telegram, 'threadInfo');
    for (const kind of ['group', 'topic'] as const) {
        threadInfo.mockResolvedValue({ kind } as never);
        expect(await f.ask({ app: 'crm' }, scheduled)).toEqual({
            status: 'refused',
            error: expect.stringMatching(/ask me in a private chat/),
        });
    }
    expect(await f.platform.approvals.list('alice')).toEqual([]);
    // Nor a read grant the person's bypass would hand out with no card.
    await f.platform.approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    expect(await f.ask({ app: 'crm' }, scheduled)).toMatchObject({
        status: 'refused',
    });
    expect(f.platform.actors.grants.unrevoked({ personId: 'alice' })).toEqual([]);
    // In a private chat, the same scheduled run may still ask.
    threadInfo.mockResolvedValue({ kind: 'dm' } as never);
    expect(await f.ask({ app: 'crm' }, scheduled)).toMatchObject({
        status: 'granted',
    });
});

it('refuses apps without the delegation contract, and with no audience policy at all', async () => {
    const f = await setup();
    expect(await f.ask({ app: 'legacy' })).toMatchObject({
        status: 'refused',
        error: expect.stringMatching(/hasn’t adopted socio access/),
    });
    const g = await setup({ register: false });
    expect(await g.ask({ app: 'crm' })).toMatchObject({
        status: 'refused',
        error: expect.stringMatching(/hasn’t adopted socio access/),
    });
});

it('refuses a development app on a company socio: promote it first', async () => {
    const f = await setup();
    expect(await f.ask({ app: 'devshared' })).toMatchObject({
        status: 'refused',
        error: expect.stringMatching(/promote the app first/),
    });
    // On the person's own socio it is eligible, and the card says the
    // limits are advisory.
    const result = await f.ask({ app: 'devmine' }, f.turn('alice', f.mine.id, f.personal.id));
    const view = await f.platform.approvals.get(pendingId(result), 'alice');
    expect((view.card as AppAccessCard).app.development).toBe(true);
});

it('refuses an app the person can’t open, by any name', async () => {
    const f = await setup();
    for (const app of ['bobs', 'Bob’s', 'nope']) {
        expect(await f.ask({ app })).toMatchObject({
            status: 'refused',
            error: expect.stringMatching(/No app/),
        });
    }
});

it('caps waiting access requests at five per socio, inside the inserting unit', async () => {
    const f = await setup();
    const threads = Array.from({ length: 6 }, (_, index) =>
        f.workspace.bindThread(`cap-${index}`, f.company.id, 'Cap', 'alice'),
    );
    const results = await Promise.all(threads.map((thread) => f.ask({ app: 'crm' }, f.turn('alice', thread.id))));
    expect(results.filter((r) => r.status === 'pending_approval')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'refused')).toEqual([
        {
            status: 'refused',
            error: expect.stringMatching(/wait for the person/),
        },
    ]);
});

it('never lets bypass or auto decide write, act or actions', async () => {
    const f = await setup();
    const { approvals } = f.platform;
    for (const capability of [
        SOCIO_ACCESS_CAPABILITIES.write,
        SOCIO_ACCESS_CAPABILITIES.act,
        SOCIO_ACCESS_CAPABILITIES.action,
    ]) {
        for (const policy of ['bypass', 'auto'] as const) {
            await expect(approvals.setPolicy('alice', f.company.id, capability, policy)).rejects.toThrow(ApprovalError);
        }
    }
    const listed = approvals.capabilities().filter((item) => item.id.startsWith('app_'));
    expect(Object.fromEntries(listed.map((item) => [item.id, [!!item.manualOnly, item.auto?.allowed]]))).toEqual({
        app_access_read: [false, true],
        app_access_write: [true, false],
        app_access_act: [true, false],
        app_action: [true, false],
    });
    // A write request waits for the person even with every other policy set.
    await approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    pendingId(await f.ask({ app: 'crm', access: 'write' }));
});

it('an app’s alwaysAsk shows the card despite the person’s read bypass', async () => {
    const f = await setup();
    await f.platform.approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    const id = pendingId(await f.ask({ app: 'hr' }));
    const view = await f.platform.approvals.get(id, 'alice');
    expect((view.card as AppAccessCard).alwaysAsk).toBe(true);
    // Without it, the opt-in grants at once.
    expect(await f.ask({ app: 'crm' })).toMatchObject({
        status: 'granted',
        reused: false,
        access: 'read',
    });
});

it('read may skip the card only by the person’s own opt-in, per socio', async () => {
    const f = await setup();
    // Another person's opt-in, or the same person's for another socio,
    // doesn't apply.
    await f.platform.approvals.setPolicy('bob', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    await f.platform.approvals.setPolicy('alice', f.personal.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    pendingId(await f.ask({ app: 'crm' }));
    // Auto with no decision model escalates to the person.
    await f.platform.approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'auto');
    const id = pendingId(await f.ask({ app: 'crm' }, f.turn('alice', f.other.id)));
    expect((await f.platform.approvals.get(id, 'alice')).auto?.verdict).toBe('escalated');
});

// --- The card ------------------------------------------------------------

it('builds the card from platform facts, with the socio’s words inert', async () => {
    const f = await setup();
    const before = Date.now();
    const id = pendingId(
        await f.ask({
            app: 'crm',
            access: 'write',
            minutes: 90,
            task: `Fix **stages** [here](https://evil.example) ${RLO}gpj.exe${ZWSP}`,
        }),
    );
    const view = await f.platform.approvals.get(id, 'alice');
    const card = view.card as AppAccessCard;
    expect(card).toMatchObject({
        kind: 'app_access',
        access: 'write',
        minutes: 90,
        app: {
            label: 'CRM Dashboard',
            origin: expect.stringMatching(/^http:\/\/.*crm/),
            owner: 'Alice',
            development: false,
        },
        visibleTo: null,
        widens: false,
        alwaysAsk: false,
    });
    // Each line is true of the whole: no "it can't change anything" on write.
    expect(card.allows).toEqual(['see and change the app’s own data']);
    expect(card.never).toMatch(/settings or sharing/);
    // Markdown stays text; hidden characters become visible escapes.
    expect(card.task).toBe('Fix **stages** [here](https://evil.example) [U+202E]gpj.exe[U+200B]');
    expect(card.task).not.toContain(RLO);
    // Expires in 15 minutes, not 7 days.
    expect(view.expiresAt - view.createdAt).toBe(SOCIO_ACCESS_APPROVAL_TTL_MS);
    expect(view.expiresAt).toBeGreaterThanOrEqual(before + SOCIO_ACCESS_APPROVAL_TTL_MS);
});

it('is decided on its card only: the Telegram notice links to it, with no Approve button', async () => {
    const f = await setup();
    const id = pendingId(await f.ask({ app: 'crm', access: 'write' }));
    const view = await f.platform.approvals.get(id, 'alice');
    const notice = approvalNotice(view, 'https://socio.example');
    expect(notice).toBe(
        `Approval needed: Read and change CRM Dashboard for 1 hour.\nDecide on its card in Socio: https://socio.example/approvals/${id}`,
    );
    expect(notice).not.toMatch(/Approve or deny it below/);
    // Button data is unsigned: a forged press from a message is refused,
    // and the request still waits for its card.
    for (const approve of [true, false]) {
        await expect(f.platform.approvals.decide(id, 'alice', approve, 'message')).rejects.toThrow(
            'Decide on its card in Socio.',
        );
    }
    expect((await f.platform.approvals.get(id, 'alice')).status).toBe('pending');
    expect(f.platform.actors.grants.unrevoked({ personId: 'alice' })).toEqual([]);
});

it('names the room whose members will see the answers', async () => {
    const f = await setup();
    f.workspace.db
        .prepare(
            "INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, kind) VALUES ('room-1', ?, 'room:room-1', 'Sales room', ?, 'room')",
        )
        .run(f.company.id, Date.now());
    const id = pendingId(await f.ask({ app: 'crm' }, f.turn('alice', 'room-1')));
    const view = await f.platform.approvals.get(id, 'alice');
    expect((view.card as AppAccessCard).visibleTo).toBe('Sales room');
    expect(view.details.join('\n')).toMatch(/visible to everyone in Sales room/);
});

it('counts arrays across every element, not the first one’s alone', () => {
    const many = Array.from({ length: 140 }, (_, i) => `+1555${i}`);
    // The small batch first: the first element alone would say "1 item".
    expect(paramCounts({ batch: [{ to: ['+1'] }, { to: many }] })).toEqual([
        { path: 'batch[].to', count: 141 },
        { path: 'batch', count: 2 },
    ]);
    // Lists of lists, and arrays deeper in later elements only.
    expect(
        paramCounts({
            grid: [[1], [2, 3, 4]],
            items: [{ name: 'a' }, { name: 'b', tags: ['x', 'y', 'z'] }],
        }),
    ).toEqual([
        { path: 'grid[]', count: 4 },
        { path: 'items[].tags', count: 3 },
        { path: 'grid', count: 2 },
        { path: 'items', count: 2 },
    ]);
    // Bounded: 64 KB of one-item arrays is counted, and quickly.
    const wide = Array.from({ length: 16_000 }, () => [0]);
    const started = performance.now();
    expect(paramCounts({ wide })).toEqual([
        { path: 'wide', count: 16_000 },
        { path: 'wide[]', count: 16_000 },
    ]);
    expect(performance.now() - started).toBeLessThan(2_000);
});

// --- Decisions and grants ----------------------------------------------

it('approving creates the grant; it is reused in that conversation only', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    const id = pendingId(await f.ask({ app: 'crm', access: 'write' }));
    const decided = await approvals.decide(id, 'alice', true);
    expect(decided.status).toBe('approved');
    expect(decided.outcome).toMatch(/^Granted: write access to CRM Dashboard/);
    const [grant] = actors.grants.unrevoked({ personId: 'alice' });
    expect(grant).toMatchObject({
        socioId: f.company.id,
        audiences: ['app:crm'],
        scopes: ['app:read', 'app:write'],
        conversationId: f.chat.id,
        conversationKind: 'private',
        approvalId: id,
        policyVersion: 'v1',
    });
    // The same conversation reuses it, for write and anything narrower.
    expect(await f.ask({ app: 'crm', access: 'read' })).toMatchObject({
        status: 'granted',
        grant: grant!.id,
        reused: true,
    });
    // Another conversation asks anew.
    pendingId(await f.ask({ app: 'crm' }, f.turn('alice', f.other.id)));
});

it('asking again while a request waits returns the same card', async () => {
    const f = await setup();
    const first = pendingId(await f.ask({ app: 'crm' }));
    expect(pendingId(await f.ask({ app: 'crm', task: 'Again' }))).toBe(first);
});

it('a wider request replaces the narrower grant once approved, never widens it', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    await approvals.setPolicy('alice', f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    const read = await f.ask({ app: 'crm' });
    expect(read.status).toBe('granted');
    const id = pendingId(await f.ask({ app: 'crm', access: 'act' }));
    expect(((await approvals.get(id, 'alice')).card as AppAccessCard).widens).toBe(true);
    // Until approved, the read grant stands.
    expect(actors.grants.get(read.grant as string)?.revokedAt).toBeNull();
    await approvals.decide(id, 'alice', true);
    expect(actors.grants.get(read.grant as string)).toMatchObject({
        revokeReason: 'replaced',
    });
    const live = actors.grants.unrevoked({ personId: 'alice' });
    expect(live).toHaveLength(1);
    expect(live[0]!.scopes).toEqual(['app:read', 'app:write', 'app:act']);
});

it('makes no grant when denied, expired, or the app changed meanwhile', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    const denied = pendingId(await f.ask({ app: 'crm' }));
    await approvals.decide(denied, 'alice', false);
    expect(actors.grants.unrevoked({ personId: 'alice' })).toEqual([]);
    // The app's version changed between the card and the click.
    const changed = pendingId(await f.ask({ app: 'crm' }));
    f.w.versions.set('app:crm', 'v2');
    const view = await approvals.decide(changed, 'alice', true);
    expect(view.status).toBe('failed');
    expect(view.outcome).toMatch(/changed since you were asked/);
    expect(actors.grants.unrevoked({ personId: 'alice' })).toEqual([]);
    // Fifteen minutes later a waiting request is expired, not decidable.
    const late = pendingId(await f.ask({ app: 'crm' }, f.turn('alice', f.other.id)));
    expect(await approvals.expire(Date.now() + SOCIO_ACCESS_APPROVAL_TTL_MS + 1)).toBeGreaterThanOrEqual(1);
    await expect(approvals.decide(late, 'alice', true)).rejects.toThrow(/already decided/);
    expect(actors.grants.unrevoked({ personId: 'alice' })).toEqual([]);
});

it('only the person decides their request: an admin can’t approve for them', async () => {
    const f = await setup();
    const id = pendingId(await f.ask({ app: 'crm' }));
    await expect(f.platform.approvals.decide(id, 'olga', true)).rejects.toThrow(/not found/);
});

it('records grant and approval rows with both identities, in the deciding transaction', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    const id = pendingId(await f.ask({ app: 'crm', task: 'Secret task text' }));
    await approvals.decide(id, 'alice', true);
    const rows = actors.audit.list({ personId: 'alice' });
    const approval = rows.find((row) => row.phase === 'approval' && row.status === 'approved');
    const grant = rows.find((row) => row.phase === 'grant');
    expect(approval).toMatchObject({
        decision: 'allow',
        socioId: f.company.id,
        actorBy: 'alice',
        resourceId: id,
    });
    expect(grant?.correlationId).toBe(approval?.correlationId);
    expect(JSON.stringify(rows)).not.toContain('Secret task text');
});

it('records an actor_audit row when a socio’s deletion or leaving a conversation ends a card', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    const expiredRows = () =>
        actors.audit.list({ personId: 'alice' }).filter((row) => row.phase === 'approval' && row.status === 'expired');
    // Invalidated: the person can no longer decide in that conversation.
    const left = pendingId(await f.ask({ app: 'crm' }));
    expect(await approvals.invalidate(f.chat.id, 'alice', 'You left.')).toBe(1);
    expect(expiredRows()).toEqual([
        expect.objectContaining({
            resourceId: left,
            actorBy: 'platform',
            socioId: f.company.id,
        }),
    ]);
    // The socio deleted: its pending cards expire, each with its row.
    const gone = pendingId(await f.ask({ app: 'crm' }, f.turn('alice', f.other.id)));
    await approvals.forgetDot(f.company.id);
    expect((await approvals.get(gone, 'alice')).status).toBe('expired');
    expect(
        expiredRows()
            .map((row) => row.resourceId)
            .sort(),
    ).toEqual([left, gone].sort());
});

// --- end_app_access -------------------------------------------------------

it('end_app_access ends this socio’s grants for this person only', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    for (const user of ['alice', 'bob']) {
        await approvals.setPolicy(user, f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    }
    f.workspace.db.prepare("UPDATE apps SET sharedSpaceId=? WHERE id='crm'").run(f.company.spaceId);
    const alice = await f.ask({ app: 'crm' });
    const bob = await f.ask({ app: 'crm' }, f.turn('bob', f.bobChat.id));
    expect([alice.status, bob.status]).toEqual(['granted', 'granted']);
    // Bob's turn names Alice's grant: nothing ends.
    expect(
        await f.tool(
            'end_app_access',
            f.turn('bob', f.bobChat.id),
        )({
            grant: alice.grant,
        }),
    ).toMatchObject({ ended: 0 });
    expect(actors.grants.get(alice.grant as string)?.revokedAt).toBeNull();
    // Alice's own turn ends hers, and only hers.
    expect(await f.tool('end_app_access', f.turn('alice', f.chat.id))({})).toMatchObject({
        ended: 1,
        grants: [alice.grant],
    });
    expect(actors.grants.get(alice.grant as string)).toMatchObject({
        revokeReason: 'task_ended',
        revokedBy: `socio:${f.company.id}`,
    });
    expect(actors.grants.get(bob.grant as string)?.revokedAt).toBeNull();
});

// --- /api/actors ----------------------------------------------------------

it('/api/actors: people see and end their own grants; admins end anyone’s', async () => {
    const f = await setup();
    const { approvals, actors } = f.platform;
    for (const user of ['alice', 'bob']) {
        await approvals.setPolicy(user, f.company.id, SOCIO_ACCESS_CAPABILITIES.read, 'bypass');
    }
    f.workspace.db.prepare("UPDATE apps SET sharedSpaceId=? WHERE id='crm'").run(f.company.spaceId);
    const alice = (await f.ask({ app: 'crm' })).grant as string;
    const bob = (await f.ask({ app: 'crm' }, f.turn('bob', f.bobChat.id))).grant as string;
    const call = api(f);
    // Bob can't see or end Alice's grant: "not found", not "forbidden".
    const bobs = await call('bob', '/actors/grants');
    expect((bobs.body as { grants: SocioGrantView[] }).grants.map((g) => g.id)).toEqual([bob]);
    expect((await call('bob', `/actors/grants/${alice}`, 'DELETE')).status).toBe(404);
    expect(actors.grants.get(alice)?.revokedAt).toBeNull();
    // Members can't reach the admin routes.
    expect((await call('bob', '/actors/admin/grants')).status).toBe(403);
    expect((await call('bob', `/actors/admin/grants/${alice}`, 'DELETE')).status).toBe(403);
    // Alice sees hers, with platform facts, and ends it.
    const mine = (await call('alice', '/actors/grants')).body as {
        grants: SocioGrantView[];
    };
    expect(mine.grants[0]).toMatchObject({
        id: alice,
        access: 'read',
        app: { label: 'CRM Dashboard' },
        conversation: { kind: 'private', title: 'Pipeline' },
        state: 'live',
        ended: null,
    });
    expect(mine.grants[0]).not.toHaveProperty('personId');
    const ended = await call('alice', `/actors/grants/${alice}`, 'DELETE');
    expect(ended.status).toBe(200);
    expect(actors.grants.get(alice)).toMatchObject({
        revokeReason: 'person_revoked',
        revokedBy: 'alice',
    });
    expect((ended.body as { grant: SocioGrantView }).grant).toMatchObject({
        state: 'ended',
        ended: { by: 'you' },
    });
    // An admin sees every live grant (not other people's chat titles) and
    // ends Bob's.
    const all = (await call('olga', '/actors/admin/grants')).body as {
        grants: SocioGrantView[];
    };
    expect(all.grants).toEqual([
        expect.objectContaining({
            id: bob,
            personName: 'Bob',
            conversation: { kind: 'private', title: null },
        }),
    ]);
    expect((await call('olga', `/actors/admin/grants/${bob}`, 'DELETE')).status).toBe(200);
    expect(actors.grants.get(bob)).toMatchObject({
        revokeReason: 'admin_revoked',
        revokedBy: 'olga',
    });
});

it('/api/actors answers nothing while the flag is off', async () => {
    const f = await setup({ flag: false });
    const call = api(f);
    expect((await call('alice', '/actors/grants')).status).toBe(404);
    expect((await call('olga', '/actors/admin/grants')).status).toBe(404);
});
