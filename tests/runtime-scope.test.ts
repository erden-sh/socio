import { lastValueFrom, toArray } from 'rxjs';
import { expect, it, onTestFinished, vi } from 'vitest';

import { attachmentPart } from '@socio/shared/media/refs';

import { validateRuntimeScope } from '../src/server/turns/runtime-scope.js';

import { ScriptAgent } from './fixtures/script-agent.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

it('blocks unbound cross-Dot run and inspector routes before reaching the runtime', () => {
    const store = new WorkspaceStore(testDatabase());
    const dot = store.dots()[0];
    store.bindThread('thread-a', dot.id, 'A', 'owner');
    expect(() =>
        validateRuntimeScope(
            new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
                method: 'POST',
            }),
            store,
            { threadId: 'other-owner' },
            'owner',
        ),
    ).toThrow();
    expect(() =>
        validateRuntimeScope(
            new Request('http://localhost/api/copilotkit/inspect/threads/foreign'),
            store,
            null,
            'owner',
        ),
    ).toThrow();
    expect(() =>
        validateRuntimeScope(
            new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
                method: 'POST',
            }),
            store,
            { threadId: 'thread-a' },
            'owner',
        ),
    ).not.toThrow();
    store.close();
});
it('rejects stop scope bypasses and misleading prefixes while allowing canonical owned routes', () => {
    const store = new WorkspaceStore(testDatabase());
    const dot = store.dots()[0];
    store.bindThread('bound', dot.id, 'Bound', 'owner');
    for (const path of [
        `/agent/${dot.id}/stop/foreign`,
        '/threads/bound/threads/foreign/messages',
        `/agent/${dot.id}/agent/foreign/run`,
        '/prefix/info',
        '/threads//bound/messages',
        '/threads/bound%2Fthreads%2Fforeign/messages',
    ]) {
        expect(() =>
            validateRuntimeScope(
                new Request(`http://localhost/api/copilotkit${path}`, {
                    method: 'POST',
                }),
                store,
                { threadId: 'bound' },
                'owner',
            ),
        ).toThrow();
    }
    expect(() =>
        validateRuntimeScope(
            new Request(`http://localhost/api/copilotkit/agent/${dot.id}/stop/bound`, { method: 'POST' }),
            store,
            {},
            'owner',
        ),
    ).not.toThrow();
    store.close();
});
it('denies the Intelligence thread routes that the app does not use', () => {
    const store = new WorkspaceStore(testDatabase());
    store.bindThread('bound', store.dots()[0].id, 'Bound', 'owner');
    for (const [method, path] of [
        ['GET', '/threads'],
        ['POST', '/threads/subscribe'],
        ['GET', '/threads/bound/messages'],
        ['GET', '/threads/bound/events'],
        ['POST', '/threads/bound/archive'],
        ['PATCH', '/threads/bound'],
        ['DELETE', '/threads/bound'],
    ]) {
        expect(() =>
            validateRuntimeScope(
                new Request(`http://localhost/api/copilotkit${path}`, { method }),
                store,
                null,
                'owner',
            ),
        ).toThrow('This runtime route is not enabled in Socio.');
    }
    store.close();
});

it('refuses inline bytes in new user messages and keeps accepting them in stored history (CB-54)', async () => {
    const { workspace, platform, dispose } = await makeTestRuntime();
    onTestFinished(dispose);
    const dot = workspace.dots()[0];
    workspace.bindThread('t', dot.id, 'T', 'owner');
    const image = {
        type: 'image',
        source: { type: 'data', value: 'AAAA', mimeType: 'image/png' },
    };
    const legacy = { id: 'legacy', role: 'user', content: [image] };
    // A message stored before CB-54, with its photo inline.
    await lastValueFrom(
        platform.runner
            .run({
                threadId: 't',
                agent: new ScriptAgent('Seen.'),
                input: {
                    threadId: 't',
                    runId: 'old',
                    messages: [legacy as never],
                    tools: [],
                    context: [],
                    state: {},
                    forwardedProps: {},
                },
            })
            .pipe(toArray()),
    );
    await expect.poll(() => platform.runner.activeRunId('t')).toBeUndefined();
    // What passes the check reaches the runtime; no model runs here.
    const runtime = vi.spyOn(platform.handler, 'fetch').mockImplementation(async () => new Response('ran'));
    const run = (messages: unknown[]) =>
        platform.handle(
            new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    threadId: 't',
                    runId: 'new',
                    messages,
                    tools: [],
                    context: [],
                    state: {},
                    forwardedProps: {},
                }),
            }),
            'owner',
        );
    for (const content of [
        [image],
        [{ type: 'binary', mimeType: 'image/png', data: 'AAAA' }],
        [{ type: 'binary', mimeType: 'image/png', url: 'https://x.invalid/a.png' }],
        [{ type: 'binary', mimeType: 'image/png', id: 'not-an-attachment' }],
        // The pre-1.0 reference: no client sends it since AG-UI 1.0.
        [{ type: 'binary', mimeType: 'image/png', id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA' }],
        Array.from({ length: 11 }, () => attachmentPart({ mimeType: 'image/png', id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA' })),
    ]) {
        const response = await run([legacy, { id: 'fresh', role: 'user', content }]);
        expect(response.status, JSON.stringify(content)).toBe(400);
    }
    expect(
        ((await (await run([legacy, { id: 'fresh', role: 'user', content: [image] }])).json()) as { error: string })
            .error,
    ).toBe('Attach files with the attach button.');
    expect(
        (
            (await (
                await run([
                    legacy,
                    {
                        id: 'fresh',
                        role: 'user',
                        content: [{ type: 'binary', mimeType: 'image/png', id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA' }],
                    },
                ])
            ).json()) as { error: string }
        ).error,
    ).toBe('This version of Socio is out of date. Update it to send attachments.');
    // References, and the stored legacy message, pass on to the runtime.
    const passed = await run([
        legacy,
        {
            id: 'fresh',
            role: 'user',
            content: [
                { type: 'text', text: 'and this' },
                attachmentPart({ mimeType: 'image/png', id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA', filename: 'a.png' }),
            ],
        },
    ]);
    expect(await passed.text()).toBe('ran');
    expect(runtime).toHaveBeenCalledTimes(1);
});
