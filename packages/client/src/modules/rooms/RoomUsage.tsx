import { useEffect, useState } from 'react';

import { formatNumber } from '@socio/shared/locale';
import {
    ROOM_USAGE_MIN_PEOPLE,
    type CycleStop,
    type RoomCycleUsage,
    type RoomUsageView,
} from '@socio/shared/rooms/rooms';

import { formatUsd } from '../operations/cost-format';
import { formatMs } from '../operations/health-format';

import { failure, roomsApi } from './api';

const STOP_WORDS: Record<CycleStop, string> = {
    deadline: 'time',
    tokens: 'token',
    handoffs: 'handoff',
    spend: 'spend',
};

const tokens = (count: number) => `${formatNumber(count)} ${count === 1 ? 'token' : 'tokens'}`;

/** What one message's work may use: the room's limits in force. */
export function limitsLine(limits: RoomUsageView['limits']) {
    const parts = [
        `up to ${formatMs(limits.cycleTimeMs)} of work`,
        tokens(limits.cycleTokens),
        `${formatNumber(limits.handoffsPerCycle)} handoffs`,
        ...(limits.cycleSpendUsd === null ? [] : [`${formatUsd(limits.cycleSpendUsd)} of spend`]),
    ];
    return `Each message: ${parts.join(', ')}. ${formatNumber(
        limits.messagesPerMinute,
    )} messages a minute, ${formatNumber(limits.maxQueued)} waiting at most.`;
}

/** The running or last cycle's use against its limits, in words. */
export function cycleLines(cycle: RoomCycleUsage): string[] {
    const lines = [
        `${tokens(cycle.tokensUsed)} of ${formatNumber(cycle.tokenLimit)}`,
        `${formatMs(cycle.elapsedMs)} of work of ${formatMs(cycle.timeLimitMs)}`,
    ];
    if (cycle.handoffs) {
        lines.push(`${formatNumber(cycle.handoffs)} of ${formatNumber(cycle.handoffLimit)} handoffs`);
    }
    lines.push(
        cycle.spend === 'private'
            ? 'Spend: on the sender’s own model subscription'
            : cycle.spend === 'unknown'
              ? 'Spend: not reported by the model'
              : `Spend: ${formatUsd(cycle.spendUsd)}${
                    cycle.spendLimitUsd === null ? '' : ` of ${formatUsd(cycle.spendLimitUsd)}`
                }`,
    );
    if (cycle.stoppedBy) {
        lines.push(`Stopped at the ${STOP_WORDS[cycle.stoppedBy]} limit`);
    }
    return lines;
}

const heading = (cycle: RoomCycleUsage) =>
    cycle.status === 'running'
        ? cycle.mine
            ? 'Your message, working now'
            : 'Working now'
        : cycle.mine
          ? 'Your last message'
          : 'The last message';

/**
 * A room's use and limits (CB-218), in its Members panel: for room
 * admins, and members when Settings → Rooms shows them. The limits every
 * message runs under, the running or last message's time, tokens and
 * spend (never an amount on someone else's own subscription), and the
 * last day in total once enough people wrote that it singles out nobody.
 */
export function RoomUsage({ roomId }: { roomId: string }) {
    const [usage, setUsage] = useState<RoomUsageView>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        roomsApi.usage(roomId, controller.signal).then(setUsage, (reason) => {
            if (!controller.signal.aborted) {
                setError(failure(reason, 'Could not load the room’s use.'));
            }
        });
        return () => controller.abort();
    }, [roomId]);
    if (error) {
        return (
            <p className="text-sm text-muted-foreground" role="status">
                {error}
            </p>
        );
    }
    if (!usage) {
        return (
            <p className="text-sm text-muted-foreground" role="status">
                Loading…
            </p>
        );
    }
    const stopped = usage.day ? Object.values(usage.day.stopped).reduce((sum, count) => sum + count, 0) : 0;
    return (
        <div className="grid gap-3 text-sm" data-slot="room-usage">
            <p className="text-muted-foreground">{limitsLine(usage.limits)}</p>
            {usage.current && (
                <div className="grid gap-1" data-slot="room-usage-current">
                    <p className="font-medium">{heading(usage.current)}</p>
                    <ul className="m-0 grid list-none gap-0.5 p-0 text-muted-foreground">
                        {cycleLines(usage.current).map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                </div>
            )}
            <p className="text-muted-foreground" data-slot="room-usage-day">
                {usage.day
                    ? `Last 24 hours: ${formatNumber(usage.day.cycles)} ${
                          usage.day.cycles === 1 ? 'message' : 'messages'
                      } worked on, ${tokens(usage.day.tokens)}${
                          stopped ? `, ${formatNumber(stopped)} stopped at a limit` : ''
                      }.`
                    : `The last 24 hours’ total shows once at least ${ROOM_USAGE_MIN_PEOPLE} people have sent messages, so it never shows one person’s use.`}
            </p>
        </div>
    );
}
