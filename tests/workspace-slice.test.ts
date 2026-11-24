// The workspace routes read one slice of the app's services, made
// once per runtime. It is the key of `roomReads`'s cache, so the rooms'
// read state stays one instance, and its members are the graph's own.
import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { ConversationDeletion } from '@socio/shared/types';

import { ConversationAdmin } from '../src/server/composition/app/conversations.js';
import { AppStatus } from '../src/server/composition/app/status.js';
import { AppTurns } from '../src/server/composition/app/turns.js';
import { workspaceSlice } from '../src/server/composition/http/workspace.js';
import { roomReads } from '../src/server/rooms/read-state.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

it('is one slice per runtime, so roomReads keeps one read state', async () => {
    const t = await makeTestRuntime();
    cleanup.push(t.dispose);
    const slice = workspaceSlice(t.edge);
    expect(workspaceSlice(t.edge)).toBe(slice);
    expect(workspaceSlice({ ...t.edge })).toBe(slice);
    expect(roomReads(workspaceSlice(t.edge))).toBe(roomReads(slice));

    const other = await makeTestRuntime();
    cleanup.push(other.dispose);
    expect(workspaceSlice(other.edge)).not.toBe(slice);
});

it("holds the graph's instances, and reads draining when asked", async () => {
    const t = await makeTestRuntime();
    cleanup.push(t.dispose);
    const slice = workspaceSlice(t.edge);
    const { platform } = t;
    for (const member of [
        'workspace',
        'store',
        'config',
        'runner',
        'roomStreams',
        'rooms',
        'roomNotices',
        'media',
        'pages',
        'pageMoves',
        'board',
        'cycles',
        'steering',
        'approvals',
        'goals',
        'jobs',
        'spaceCreation',
        'inference',
        'apps',
        'flags',
        'plugins',
        'chatNamesRepo',
        'dictationStreams',
    ] as const) {
        expect(slice[member], member).toBe(platform[member]);
    }
    expect(slice.draining).toBe(false);
    platform.draining = true;
    expect(slice.draining).toBe(true);
    platform.draining = false;
});

it("delegates to the app's services and returns their own promises", async () => {
    const t = await makeTestRuntime();
    cleanup.push(t.dispose);
    const slice = workspaceSlice(t.edge);
    const conversations = Context.get(t.edge.services, ConversationAdmin);
    const turns = Context.get(t.edge.services, AppTurns);
    const status = Context.get(t.edge.services, AppStatus);

    const deletion: Promise<ConversationDeletion> = Promise.resolve({ scheduledTasks: 0, blocked: null });
    const spyDeletion = vi.spyOn(conversations, 'deletion').mockReturnValue(deletion);
    expect(slice.deletion('c1', 'u1')).toBe(deletion);
    expect(spyDeletion).toHaveBeenCalledWith('c1', 'u1');

    const deleted = Promise.resolve();
    const spyDelete = vi.spyOn(conversations, 'delete').mockReturnValue(deleted);
    expect(slice.deleteConversation('c1', 'u1')).toBe(deleted);
    expect(spyDelete).toHaveBeenCalledWith('c1', 'u1', undefined);

    const response = Promise.resolve(new Response('ok'));
    const spyHandle = vi.spyOn(turns, 'handle').mockReturnValue(response);
    const request = new Request('http://socio.test/');
    expect(slice.handle(request, 'u1')).toBe(response);
    expect(spyHandle).toHaveBeenCalledWith(request, 'u1');

    const setup = status.setup();
    const spySetup = vi.spyOn(status, 'setup').mockReturnValue(setup);
    expect(slice.setup('u1')).toBe(setup);
    expect(spySetup).toHaveBeenCalledWith('u1');
    await setup;
});
