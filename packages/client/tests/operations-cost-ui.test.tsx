// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_POOL_WEIGHTS, type OpsCostView, type PricingView } from '@socio/shared/operations/operations-cost';

import { api } from '../src/lib/api';
import { CostPage } from '../src/modules/operations/CostPage';
import { PriceSyncSetting } from '../src/modules/operations/PriceSyncSetting';

// CB-195 and CB-196: Operations → Cost and the price sync's switch.

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});
const settle = async () => {
    for (let i = 0; i < 4; i++) {
        await act(async () => {
            await Promise.resolve();
        });
    }
};

const T0 = Date.UTC(2026, 9, 20);
const sync = {
    enabled: true,
    serverDefault: true,
    saved: false,
    watched: ['qwen3-32b', 'gpt-4o-mini'],
    runs: [
        {
            source: 'openrouter',
            at: T0,
            ok: true,
            fetched: 300,
            matched: 2,
            stored: 2,
            error: null,
        },
        {
            source: 'azure',
            at: T0,
            ok: false,
            fetched: 0,
            matched: 0,
            stored: 0,
            error: 'HTTP 503',
        },
    ],
    nextAt: T0 + 86_400_000,
    running: false,
} as PricingView['sync'];

const pricing: PricingView = {
    sync,
    prices: [
        {
            id: 'p1',
            provider: 'openrouter',
            model: 'openai/gpt-4o-mini',
            modelKey: 'gpt4omini',
            inputPerM: 0.15,
            cachedInputPerM: null,
            outputPerM: 0.6,
            reasoningPerM: null,
            currency: 'USD',
            effectiveFrom: T0,
            source: 'sync:openrouter',
            fetchedAt: T0,
        },
        {
            id: 'p2',
            provider: '*',
            model: 'qwen3-32b',
            modelKey: 'qwen332b',
            inputPerM: 0,
            cachedInputPerM: null,
            outputPerM: 0,
            reasoningPerM: null,
            currency: 'USD',
            effectiveFrom: T0,
            source: 'admin',
            fetchedAt: T0,
        },
    ],
    backends: [
        {
            id: 'local',
            label: 'Local GPU',
            kind: 'shared',
            model: 'qwen3-32b',
            provider: 'self-hosted',
            enabled: true,
        },
        {
            id: 'byo:byo-chatgpt',
            label: 'ChatGPT',
            kind: 'byo',
            model: 'gpt-5',
            provider: 'chatgpt',
            enabled: true,
        },
    ],
    pools: [
        {
            id: 'pool-1',
            name: 'GPU box',
            kind: 'fixed',
            category: 'hardware',
            amount: 3600,
            currency: 'USD',
            period: 'month',
            depreciationMonths: 36,
            startsAt: T0,
            endsAt: null,
            backendIds: ['local'],
            allocation: 'tokens',
            weights: DEFAULT_POOL_WEIGHTS,
            createdAt: T0,
            updatedAt: T0,
        },
        {
            id: 'pool-2',
            name: 'ChatGPT seats',
            kind: 'fixed',
            category: 'subscription',
            amount: 200,
            currency: 'USD',
            period: 'month',
            depreciationMonths: null,
            startsAt: T0,
            endsAt: null,
            backendIds: ['byo:byo-chatgpt'],
            allocation: 'tokens',
            weights: DEFAULT_POOL_WEIGHTS,
            createdAt: T0,
            updatedAt: T0,
        },
    ],
    readings: [],
};

const cost: OpsCostView = {
    status: { state: 'ready', asOf: T0, earliest: T0 },
    window: {
        from: T0,
        to: T0 + 86_400_000,
        bucket: 'hour',
        buckets: ['hour'],
        previous: null,
        timeZone: 'UTC',
    },
    cost: {
        totals: {
            costUsd: 12.5,
            previousCostUsd: null,
            turns: 40,
            priced: 20,
            pooled: 15,
            unpriced: 5,
            tokens: 100_000,
            idleUsd: 3.25,
        },
        series: [{ at: T0, priceUsd: 2.5, poolUsd: 10 }],
        byModel: [
            {
                key: 'qwen3-32b',
                name: null,
                turns: 15,
                tokens: 60_000,
                costUsd: 10,
                unpriced: 0,
            },
        ],
        bySocio: [
            {
                key: 's1',
                name: 'Homelab',
                turns: 40,
                tokens: 100_000,
                costUsd: 12.5,
                unpriced: 5,
            },
        ],
        byPerson: [
            {
                key: 'alice',
                name: 'Alice',
                turns: 40,
                tokens: 100_000,
                costUsd: 12.5,
                unpriced: 5,
            },
        ],
        byPayer: [
            {
                key: 'workspace',
                name: null,
                turns: 30,
                tokens: 80_000,
                costUsd: 10,
                unpriced: 2,
            },
            {
                key: 'alice',
                name: 'Alice',
                turns: 6,
                tokens: 15_000,
                costUsd: 2.5,
                unpriced: 0,
            },
            { key: '', name: null, turns: 4, tokens: 5_000, costUsd: 0, unpriced: 3 },
        ],
        byRoom: [
            {
                key: 'room-1',
                name: 'Launch',
                turns: 12,
                tokens: 40_000,
                costUsd: 4,
                unpriced: 1,
                cycles: 9,
                handoffs: 3,
                exhausted: 2,
                people: 3,
                socios: 2,
            },
        ],
        cycles: {
            cycles: 20,
            inRooms: 9,
            steps: 24,
            handoffs: 3,
            exhausted: { deadline: 1, tokens: 1, handoffs: 0, spend: 0 },
            stopped: 2,
            spendUnknown: 4,
            runningMs: 90_000,
            wallMs: 600_000,
        },
        backends: [
            {
                backend: 'local',
                turns: 15,
                inputTokens: 50_000,
                cachedTokens: 0,
                outputTokens: 10_000,
                costUsd: 10,
                poolUsd: 10,
                pooledTokens: 60_000,
                referenceUsd: 0.012,
                unpriced: 0,
            },
        ],
        pools: [
            {
                poolId: 'pool-1',
                costUsd: 13.25,
                allocatedUsd: 10,
                idleUsd: 3.25,
                turns: 15,
            },
        ],
        unpricedModels: [{ model: 'mystery-1', backend: 'local', turns: 5 }],
    },
};

it('shows cost, unpriced turns, pools with idle capacity and the cloud reference', async () => {
    vi.mocked(api).mockImplementation(
        async (path) => structuredClone(String(path).startsWith('/operations/cost') ? cost : pricing) as never,
    );
    act(() =>
        root.render(
            <MemoryRouter initialEntries={['/operations/cost?range=24h']}>
                <CostPage />
            </MemoryRouter>,
        ),
    );
    await settle();
    const text = host.textContent ?? '';
    expect(text).toContain('$12.50');
    expect(text).toContain('Turns without a price5');
    expect(text).toContain('their cost is unknown, not zero');
    expect(text).toContain('Idle capacity$3.25');
    // The pool's numbers, and the subscription labeled an estimate.
    const pool = host.querySelector('[data-pool="pool-1"]')!;
    expect(pool.textContent).toContain('$3,600 written off over 36 months');
    expect(pool.textContent).toContain('$13.25');
    expect(host.querySelector('[data-pool="pool-2"]')!.textContent).toContain('Estimate');
    // Self-hosted $/M beside the cloud's for the same turns.
    const backend = host.querySelector('[data-backend="local"]')!;
    expect(backend.textContent).toContain('Local GPU');
    expect(backend.textContent).toContain('$166.6667 / M');
    expect(backend.textContent).toContain('$0.20 / M');
    expect(text).toContain('mystery-1');
    // Who paid, each room's cycles, and the cycles limits stopped (CB-218).
    const payers = host.querySelector('[data-slot="ops-cost-payers"]')!;
    expect(payers.textContent).toContain('The workspace');
    expect(payers.textContent).toContain('Alice');
    expect(payers.textContent).toContain('Not recorded');
    const room = host.querySelector('[data-room="room-1"]')!;
    expect(room.textContent).toContain('Launch');
    expect(room.textContent).toContain('3 people · 2 socios');
    expect(room.textContent).toContain('2 hit a limit');
    expect(room.textContent).toContain('3 handed on');
    const cycles = host.querySelector('[data-slot="ops-cost-cycles"]')!;
    expect(cycles.textContent).toContain('20 (9 in rooms)');
    expect(cycles.textContent).toContain('Stopped at the token limit1');
    expect(cycles.textContent).toContain('Spend not reported4');
    expect(cycles.textContent).toContain('Time working1.5 min');
    expect(cycles.textContent).toContain('Start to end10 min');
    // The sync's runs, a failure shown.
    expect(host.querySelector('[data-source="azure"]')!.textContent).toContain('Failed: HTTP 503');
    expect(host.querySelector('[data-source="models.dev"]')!.textContent).toContain('Never');
    // Only admins' prices can be removed.
    expect(host.querySelector('[data-price="p1"]')!.textContent).not.toContain('Remove');
    expect(host.querySelector('[data-price="p2"]')!.textContent).toContain('Remove');
    // "Add a price" fills the form with the unpriced model.
    act(() =>
        Array.from(host.querySelectorAll('button'))
            .find((button) => button.textContent === 'Add a price')!
            .click(),
    );
    await settle();
    const form = host.querySelector('[data-slot="ops-price-form"]')!;
    expect(Array.from(form.querySelectorAll('input')).map((input) => input.value)).toContain('mystery-1');
});

it('switches the price sync, and goes back to the server’s', async () => {
    const calls: unknown[] = [];
    let view = { ...sync, enabled: false, serverDefault: false };
    vi.mocked(api).mockImplementation(async (_path, method, body) => {
        if (method === 'PUT') {
            calls.push(body);
            const enabled = (body as { enabled: boolean | null }).enabled;
            view = {
                ...view,
                enabled: enabled ?? view.serverDefault,
                saved: enabled !== null,
            };
            return structuredClone(view) as never;
        }
        return structuredClone({ ...pricing, sync: view }) as never;
    });
    act(() => root.render(<PriceSyncSetting />));
    await settle();
    expect(host.textContent).toContain('The server’s is off');
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    act(() => toggle.click());
    await settle();
    expect(calls).toEqual([{ enabled: true }]);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() =>
        Array.from(host.querySelectorAll('button'))
            .find((button) => button.textContent?.startsWith('Use the server’s'))!
            .click(),
    );
    await settle();
    expect(calls.at(-1)).toEqual({ enabled: null });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
});
