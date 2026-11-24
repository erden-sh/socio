// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ApprovalView } from '@socio/shared/approvals';
import type { DatasetDetail, DatasetView } from '@socio/shared/data-types';
import type { InferenceBackendView, OperatorInferenceState } from '@socio/shared/inference';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';

import { createTestRouter } from './helpers/app-router';
import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * CB-74: the Operator, Dataset and approval request pages start from
 * their loaders' data, and apply the loader's newer copy when it runs
 * again (another tab's note, the tab coming back, a revalidation), as
 * Media does. `other` is another tab's end of the changes channel.
 */
const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const users = {
    olga: { id: 'olga', name: 'Olga', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users;
const workspace = (): WorkspaceState => ({
    user: users[me],
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Dot',
            instructions: 'Dot helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});
const dataset = (extra: Partial<DatasetView> = {}): DatasetView => ({
    id: 'ds1',
    name: 'Dot scratch',
    description: 'Dot’s working data.',
    kind: 'dataset',
    ownerUserId: 'bob',
    createdByDotId: null,
    scratchForDotId: null,
    dotName: null,
    fromDeletedDot: false,
    sharedSpaceId: null,
    retentionDays: null,
    sizeBytes: 8192,
    tableCount: 0,
    createdAt: 1,
    updatedAt: 1,
    access: 'owner',
    ...extra,
});
const backend = (label: string): InferenceBackendView => ({
    id: 'b1',
    kind: 'openai-compatible',
    label,
    enabled: true,
    config: { baseUrl: 'http://127.0.0.1:9/v1', model: 'fake-model' },
    hasApiKey: false,
    capabilities: { acceptsImages: false, maxImages: 0, maxCompletionTokens: 0 },
    status: 'ready',
    isDefault: true,
    lastTest: null,
    createdAt: 1,
    updatedAt: 1,
});
let stored: DatasetView | undefined;
let inference: OperatorInferenceState;
let approval: ApprovalView;
let requests: string[];

const respond = (path: string): [number, unknown] => {
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/data/datasets/ds1') {
        return stored
            ? [200, { dataset: stored, tables: [] } satisfies DatasetDetail]
            : [404, { error: 'Dataset not found.' }];
    }
    if (path === '/api/data/audit') {
        return [200, []];
    }
    if (path === '/api/inference') {
        return [200, inference];
    }
    if (path === '/api/operator/work') {
        return [200, { environment: 'production', runs: 0, jobs: 0 }];
    }
    if (path === '/api/approvals/ap1') {
        return [200, approval];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
let other: FakeBroadcastChannel;
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    // The pages' own polls (an approval's) don't tick: what changes came
    // from a note or a revalidation.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    me = 'bob';
    requests = [];
    stored = dataset();
    inference = {
        backends: [backend('Main')],
        defaultBackendId: 'b1',
        byoKinds: [],
    };
    approval = {
        id: 'ap1',
        dotId: 'd1',
        dotName: 'Dot',
        capability: 'data.create_dataset',
        capabilityLabel: 'Create datasets',
        summary: 'Dot wants to create a dataset “Watchlist”',
        details: [],
        status: 'pending',
        decidedVia: null,
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000,
        decidedAt: null,
        outcome: null,
    };
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        requests.push(url.pathname);
        const [status, body] = respond(url.pathname);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    closeChangeChannel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 200)));
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    await settle();
    return router;
}
const text = () => host.textContent ?? '';

it('Dataset: another tab’s change shows, and its delete says so', async () => {
    await open('/data/datasets/ds1');
    await until(() => text().includes('Dot scratch'), 'the dataset');
    stored = dataset({ name: 'Watchlist' });
    requests = [];
    other.postMessage([{ topic: 'data' }]);
    await until(() => text().includes('Watchlist'), 'the new name');
    stored = undefined;
    other.postMessage([{ topic: 'data' }]);
    await until(() => text().includes('Dataset not found'), 'the delete');
});

it('Operator: another tab’s backend change shows at once', async () => {
    me = 'olga';
    await open('/settings/operator');
    await until(() => text().includes('Main'), 'the backend');
    inference = { ...inference, backends: [backend('Backup')] };
    requests = [];
    other.postMessage([{ topic: 'setup' }]);
    await until(() => text().includes('Backup'), 'the new label');
    // The loader read it once; the shell its own poll.
    expect(requests.filter((path) => path === '/api/inference')).toHaveLength(1);
});

it('Approval request: a revalidated loader’s copy replaces the shown one', async () => {
    const router = await open('/approvals/ap1');
    await until(
        () => host.querySelector('[data-slot="approval-card"]')?.getAttribute('data-status') === 'pending',
        'the request',
    );
    approval = {
        ...approval,
        status: 'denied',
        decidedVia: 'user',
        decidedAt: 2,
    };
    requests = [];
    await act(() => router.revalidate());
    await until(
        () => host.querySelector('[data-slot="approval-card"]')?.getAttribute('data-status') === 'denied',
        'the decision',
    );
    // The loader's read, nothing more: the card took its copy.
    expect(requests.filter((path) => path === '/api/approvals/ap1')).toHaveLength(1);
});
