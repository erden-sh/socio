import { afterEach, expect, it, vi } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';

import { staticAuth } from './fixtures/static-auth.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});
/** `signedOut`: only requests with the test session cookie are signed in. */
async function fixture(signedOut = false) {
    const {
        workspace: ws,
        platform,
        app,
        dispose,
    } = await makeTestRuntime({
        config: { baseUrl: 'https://example.com', runtimeUrl: '' },
        app: { auth: signedOut ? sessionAuth() : staticAuth() },
    });
    cleanup.push(dispose);
    return { ws, platform, app };
}
const SESSION = { cookie: 'test_session=1' };
function sessionAuth() {
    const auth = staticAuth();
    const user = auth.provider.users()[0];
    auth.provider.resolve = async (request) => (request.headers.get('cookie') === SESSION.cookie ? user : null);
    return auth;
}
const request = (body: unknown, method = 'POST') => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

it('saves Learning settings through the owner API and rejects malformed container IDs', async () => {
    const { ws, app } = await fixture();
    const dot = ws.dots()[0];
    const body = {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: true,
        memoryAllowed: true,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    };
    expect((await app.request(`/api/dots/${dot.id}`, request(body, 'PUT'))).status).toBe(200);
    expect(ws.dot(dot.id)).toMatchObject({
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    expect(
        (await app.request(`/api/dots/${dot.id}`, request({ ...body, learningContainerId: 'bad--id' }, 'PUT'))).status,
    ).toBe(400);
    expect(
        (await app.request(`/api/dots/${dot.id}`, request({ ...body, learningContainerId: null }, 'PUT'))).status,
    ).toBe(400);
    const created = await app.request('/api/dots', request({ ...body, spaceId: dot.spaceId }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    const privateApp = await fixture(true);
    expect((await privateApp.app.request(`/api/dots/${privateApp.ws.dots()[0].id}`, request(body, 'PUT'))).status).toBe(
        401,
    );
});
it('supports manual pages without credentials and returns validation, scope and conflict statuses', async () => {
    const { ws, app } = await fixture();
    const space = ws.spaces()[0].id;
    const path = `/api/spaces/${space}/pages`;
    expect((await app.request(path, request({ title: '' }))).status).toBe(400);
    expect((await app.request('/api/spaces/missing/pages')).status).toBe(404);
    const result = await app.request(path, request({ title: 'Document' }));
    expect(result.status).toBe(201);
    const page = await result.json();
    expect(
        (await app.request(`${path}/${page.id}`, request({ expectedRevision: 1, content: 'First' }, 'PATCH'))).status,
    ).toBe(200);
    expect(
        (await app.request(`${path}/${page.id}`, request({ expectedRevision: 1, content: 'Stale' }, 'PATCH'))).status,
    ).toBe(409);
    // Page conversations are local: no conversation service is required.
    const conversation = await app.request(`${path}/${page.id}/conversation`, request({ dotId: ws.dots()[0].id }));
    expect(conversation.status).toBe(200);
    expect(ws.pages.thread(page.id, ws.dots()[0].id, 'owner')).toMatchObject({
        threadId: (await conversation.json()).id,
        ready: true,
    });
    expect(ws.pages.get(space, page.id).content).toBe('First');
    expect(
        (
            await app.request(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{',
            })
        ).status,
    ).toBe(400);
});
it('keeps page routes behind sign-in and browser origin checks', async () => {
    const { ws, app } = await fixture(true);
    const path = `/api/spaces/${ws.spaces()[0].id}/pages`;
    expect((await app.request(path)).status).toBe(401);
    expect(
        (
            await app.request(path, {
                headers: SESSION,
            })
        ).status,
    ).toBe(200);
    expect(
        (
            await app.request(path, {
                ...request({ title: 'Cross-origin' }),
                headers: {
                    ...SESSION,
                    'Content-Type': 'application/json',
                    Origin: 'https://evil.example',
                },
            })
        ).status,
    ).toBe(403);
});

it('saves reviewed drafts once and rechecks the socio’s Space access', async () => {
    const { ws, app } = await fixture();
    const dot = ws.dots()[0];
    ws.bindThread('review-thread', dot.id, 'Review', 'owner');
    const draft = {
        title: 'Launch brief',
        content: 'A reviewed draft.',
        spaceId: dot.spaceId,
        toolCallId: 'review-1',
    };
    const path = '/api/conversations/review-thread/reviewed-page';
    const first = await app.request(path, request(draft));
    expect(first.status).toBe(201);
    const saved = await first.json();
    const retry = await app.request(path, request(draft));
    expect((await retry.json()).id).toBe(saved.id);
    expect((await app.request(path, request({ ...draft, title: '  Launch brief  ' }))).status).toBe(201);
    expect(saved.reviewDraft).toEqual({
        title: draft.title,
        content: draft.content,
        spaceId: dot.spaceId,
    });
    for (const changed of [
        { ...draft, title: 'Different title' },
        { ...draft, content: 'Different content.' },
    ]) {
        const conflict = await app.request(path, request(changed));
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({
            error: expect.stringContaining('different draft'),
        });
    }
    expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
    await ws.pages.update(dot.spaceId, saved.id, {
        expectedRevision: 1,
        content: 'The saved page was edited later.',
    });
    const restored = await app.request(`${path}/review-1`);
    expect(await restored.json()).toMatchObject({
        content: 'The saved page was edited later.',
        reviewDraft: {
            title: draft.title,
            content: draft.content,
            spaceId: dot.spaceId,
        },
    });
    const retryAfterEdit = await app.request(path, request(draft));
    expect((await retryAfterEdit.json()).id).toBe(saved.id);
    const authorizedOther = ws.createSpace('Authorized other', '');
    ws.updateDot(dot.id, {
        ...dot,
        spaceIds: [dot.spaceId, authorizedOther.id],
    });
    expect((await app.request(path, request({ ...draft, spaceId: authorizedOther.id }))).status).toBe(409);
    const other = ws.createSpace('Other', '');
    ws.updateDot(dot.id, { ...dot, spaceId: other.id, spaceIds: [other.id] });
    expect((await app.request(path, request(draft))).status).toBe(403);
    expect(ws.pages.list(dot.spaceId)).toHaveLength(1);
});

it('saves a reviewed draft without a Space where create_space_page would (CB-81)', async () => {
    const { ws, app } = await fixture();
    const dot = ws.dots()[0];
    ws.bindThread('review-default', dot.id, 'Review', 'owner');
    const path = '/api/conversations/review-default/reviewed-page';
    const draft = { title: 'Brief', content: 'Text', toolCallId: 'review-1' };
    const first = await app.request(path, request(draft));
    expect(first.status).toBe(201);
    const saved = await first.json();
    expect(saved).toMatchObject({
        spaceId: dot.spaceId,
        reviewDraft: { title: 'Brief', content: 'Text', spaceId: dot.spaceId },
    });
    // A strict tool schema sends the left-out Space as null.
    const nulled = await app.request(path, request({ ...draft, toolCallId: 'review-2', spaceId: null }));
    expect((await nulled.json()).spaceId).toBe(dot.spaceId);
    // A retry keeps the Space the first save picked, even after the default
    // destination moved.
    const other = ws.createSpace('Other', '');
    ws.updateDot(dot.id, {
        ...dot,
        spaceId: other.id,
        spaceIds: [dot.spaceId, other.id],
    });
    const retry = await app.request(path, request(draft));
    expect(retry.status).toBe(201);
    expect((await retry.json()).id).toBe(saved.id);
    expect(ws.pages.list(other.id)).toHaveLength(0);
});

it('restores review receipts through the owner API with current thread and Space authorization', async () => {
    const { ws, app } = await fixture(true);
    const dot = ws.dots()[0];
    ws.bindThread('review-restore', dot.id, 'Review', 'owner');
    const base = '/api/conversations/review-restore/reviewed-page';
    const headers = SESSION;
    expect((await app.request(`${base}/call`)).status).toBe(401);
    expect(await (await app.request(`${base}/call`, { headers })).json()).toBeNull();
    const saved = await ws.pages.createReviewed(
        dot.spaceId,
        { title: 'Saved', content: 'Evidence' },
        'review-restore',
        'call',
    );
    expect(await (await app.request(`${base}/call`, { headers })).json()).toMatchObject({
        id: saved.id,
        spaceId: dot.spaceId,
    });
    ws.bindThread('other-thread', dot.id, 'Other', 'owner');
    expect(
        await (
            await app.request('/api/conversations/other-thread/reviewed-page/call', {
                headers,
            })
        ).json(),
    ).toBeNull();
    expect((await app.request('/api/conversations/missing-thread/reviewed-page/call', { headers })).status).not.toBe(
        200,
    );
    const other = ws.createSpace('Other', '');
    ws.updateDot(dot.id, { ...dot, spaceId: other.id, spaceIds: [other.id] });
    expect((await app.request(`${base}/call`, { headers })).status).toBe(403);
});
it.each([
    ['GET', '/reviewed-page/tool'],
    ['POST', '/reviewed-page'],
    ['GET', '/page-context'],
    ['POST', '/page'],
])('returns 404 for an unknown conversation on %s %s', async (method, suffix) => {
    const { ws, app } = await fixture();
    const body =
        suffix === '/reviewed-page'
            ? {
                  title: 'Draft',
                  content: 'Text',
                  spaceId: ws.spaces()[0].id,
                  toolCallId: 'tool',
              }
            : { title: 'Draft' };
    const response = await app.request(
        `/api/conversations/missing${suffix}`,
        method === 'GET' ? undefined : request(body),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
        error: 'Conversation does not belong to this socio and owner.',
    });
});

it('keeps page operation failures as 503 without exposing details', async () => {
    const { ws, app, platform } = await fixture();
    ws.bindThread('valid-thread', ws.dots()[0].id, 'Conversation', 'owner');
    vi.spyOn(platform.pages, 'saveConversation').mockRejectedValueOnce(new Error('Provider secret'));
    const response = await app.request('/api/conversations/valid-thread/page', request({ title: 'Draft' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: 'Page operation could not complete. Check the model setup or retry; your draft has not been discarded.',
    });
});

it('answers a Space library’s first screen without bodies, newest first, with the open page', async () => {
    const { ws, app } = await fixture();
    const space = ws.spaces()[0]!;
    const made: Page[] = [];
    for (const title of ['First', 'Second', 'Third', 'Fourth']) {
        made.push(
            await ws.pages.create(space.id, {
                title,
                content: `# ${title}\n\n**${title}** body text.`,
                parentId: null,
            }),
        );
    }
    made.forEach((page, index) => ws.db.prepare('UPDATE pages SET updatedAt=? WHERE id=?').run(1_000 + index, page.id));
    await ws.pages.delete(space.id, made[3]!.id);
    const library = await (
        await app.request(`/api/spaces/${space.id}/pages?bodies=false&limit=2&include=${made[0]!.id}`)
    ).json();
    expect(library).toMatchObject({ spaceId: space.id, total: 3 });
    expect(library.pages.map((page: { title: string }) => page.title)).toEqual(['Third', 'Second', 'First']);
    expect(library.pages[0]).toMatchObject({ excerpt: 'Third body text.' });
    expect(library.pages[0]).not.toHaveProperty('content');
    // The deleted page is no page, even asked for by name.
    const gone = await (await app.request(`/api/spaces/${space.id}/pages?bodies=false&include=${made[3]!.id}`)).json();
    expect(gone.pages).toHaveLength(3);
    expect((await app.request(`/api/spaces/${space.id}/pages?bodies=false&limit=0`)).status).toBe(400);
    expect((await app.request('/api/spaces/nope/pages?bodies=false')).status).toBe(404);
    // Without the parameter: every page, with an excerpt instead of its
    // body (CB-71); the page itself has its body.
    const all = await (await app.request(`/api/spaces/${space.id}/pages`)).json();
    expect(all.map((page: { title: string }) => page.title).sort()).toEqual(['First', 'Second', 'Third']);
    for (const page of all) {
        expect(page).not.toHaveProperty('content');
    }
    expect(all.find((page: { id: string }) => page.id === made[0]!.id)).toEqual({
        ...(({ sourceUrl: _, sourceTitle: __, ...rest }) => rest)(ws.pages.get(space.id, made[0]!.id)),
        content: undefined,
        excerpt: 'First body text.',
    });
    const one = await (await app.request(`/api/spaces/${space.id}/pages/${made[0]!.id}`)).json();
    expect(one).toMatchObject({ content: '# First\n\n**First** body text.' });
});
