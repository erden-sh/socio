// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
    api: vi.fn(),
    ApiError: class extends Error {},
}));
import type { RoomCycleUsage, RoomUsageView } from '@socio/shared/rooms/rooms';

import { api } from '../src/lib/api';
import { RoomUsage, useRoomUsageWords } from '../src/modules/rooms/RoomUsage';

// CB-218: a room's use and limits in its Members panel, in words.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(api).mockReset();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const limits: RoomUsageView['limits'] = {
    cycleTimeMs: 600_000,
    cycleTokens: 2_000_000,
    messagesPerMinute: 20,
    maxQueued: 10,
    handoffsPerCycle: 4,
    cycleSpendUsd: null,
};
const current: RoomCycleUsage = {
    status: 'running',
    mine: false,
    startedAt: 1,
    elapsedMs: 90_000,
    timeLimitMs: 600_000,
    tokensUsed: 12_000,
    tokenLimit: 2_000_000,
    handoffs: 0,
    handoffLimit: 4,
    spend: 'private',
    spendUsd: null,
    spendLimitUsd: null,
    stoppedBy: null,
};

/** The hook's words, read through a component. */
function usageWords() {
    let words!: ReturnType<typeof useRoomUsageWords>;
    function Probe() {
        words = useRoomUsageWords();
        return null;
    }
    act(() => root.render(<Probe />));
    return words;
}

it('says the limits and the current message’s use, never another’s spend', () => {
    const { limitsLine, cycleLines } = usageWords();
    expect(limitsLine(limits)).toBe(
        'Each message: up to 10 min of work, 2,000,000 tokens, 4 handoffs. 20 messages a minute, 10 waiting at most.',
    );
    expect(cycleLines(current)).toEqual([
        '12,000 tokens of 2,000,000',
        '1.5 min of work of 10 min',
        'Spend: on the sender’s own model subscription',
    ]);
    expect(
        cycleLines({
            ...current,
            spend: 'known',
            spendUsd: 0.25,
            spendLimitUsd: 1,
            stoppedBy: 'spend',
        }),
    ).toContain('Stopped at the spend limit');
    expect(cycleLines({ ...current, spend: 'unknown' })).toContain('Spend: not reported by the model');
});

it('loads the room’s use, and says why there is no day’s total', async () => {
    vi.mocked(api).mockResolvedValue({
        limits,
        current,
        day: null,
    } satisfies RoomUsageView);
    await act(async () => root.render(<RoomUsage roomId="room-1" />));
    expect(api).toHaveBeenCalledWith('/rooms/room-1/usage', 'GET', undefined, expect.any(AbortSignal));
    expect(host.textContent).toContain('Working now');
    expect(host.textContent).toContain('12,000 tokens of 2,000,000');
    expect(host.querySelector('[data-slot="room-usage-day"]')!.textContent).toContain('at least 3 people');
});

it('shows the day’s total once there is one', async () => {
    vi.mocked(api).mockResolvedValue({
        limits,
        current: null,
        day: {
            since: 0,
            cycles: 12,
            tokens: 340_000,
            stopped: { deadline: 1, tokens: 1, handoffs: 0, spend: 0 },
        },
    } satisfies RoomUsageView);
    await act(async () => root.render(<RoomUsage roomId="room-1" />));
    expect(host.querySelector('[data-slot="room-usage-day"]')!.textContent).toBe(
        'Last 24 hours: 12 messages worked on, 340,000 tokens, 2 stopped at a limit.',
    );
});
