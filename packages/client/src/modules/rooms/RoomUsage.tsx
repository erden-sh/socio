import { useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { ROOM_USAGE_MIN_PEOPLE, type RoomCycleUsage, type RoomUsageView } from '@socio/shared/rooms/rooms';

import { formatUsd } from '../operations/cost-format';
import { formatMs } from '../operations/health-format';

import { failure, roomsApi } from './api';

/**
 * The words of a room's use and limits (CB-218): `limitsLine`, what one
 * message's work may use (the room's limits in force), and `cycleLines`,
 * the running or last cycle's use against its limits.
 */
export function useRoomUsageWords() {
    const { t } = useTranslation(['rooms']);
    const tokens = (count: number) => t('rooms:usage.tokens', { count });
    return {
        limitsLine: (limits: RoomUsageView['limits']) =>
            t('rooms:usage.limits', {
                parts: [
                    t('rooms:usage.work', { time: formatMs(limits.cycleTimeMs) }),
                    tokens(limits.cycleTokens),
                    t('rooms:usage.handoffs', { count: limits.handoffsPerCycle }),
                    ...(limits.cycleSpendUsd === null
                        ? []
                        : [t('rooms:usage.spend-limit', { amount: formatUsd(limits.cycleSpendUsd) })]),
                ],
                perMinute: t('rooms:usage.per-minute', { count: limits.messagesPerMinute }),
                waiting: t('rooms:usage.waiting', { n: limits.maxQueued }),
            }),
        cycleLines: (cycle: RoomCycleUsage): string[] => {
            const lines: string[] = [
                t('rooms:usage.tokens-of', { used: tokens(cycle.tokensUsed), limit: cycle.tokenLimit }),
                t('rooms:usage.time-of', { elapsed: formatMs(cycle.elapsedMs), limit: formatMs(cycle.timeLimitMs) }),
            ];
            if (cycle.handoffs) {
                lines.push(t('rooms:usage.handoffs-of', { n: cycle.handoffs, limit: cycle.handoffLimit }));
            }
            lines.push(
                cycle.spend === 'private'
                    ? t('rooms:usage.spend-private')
                    : cycle.spend === 'unknown'
                      ? t('rooms:usage.spend-unknown')
                      : cycle.spendLimitUsd === null
                        ? t('rooms:usage.spend', { amount: formatUsd(cycle.spendUsd) })
                        : t('rooms:usage.spend-of', {
                              amount: formatUsd(cycle.spendUsd),
                              limit: formatUsd(cycle.spendLimitUsd),
                          }),
            );
            if (cycle.stoppedBy) {
                lines.push(t('rooms:usage.stopped', { context: cycle.stoppedBy }));
            }
            return lines;
        },
        heading: (cycle: RoomCycleUsage) =>
            cycle.status === 'running'
                ? cycle.mine
                    ? t('rooms:usage.heading.running-mine')
                    : t('rooms:usage.heading.running')
                : cycle.mine
                  ? t('rooms:usage.heading.last-mine')
                  : t('rooms:usage.heading.last'),
    };
}

/**
 * A room's use and limits (CB-218), in its Members panel: for room
 * admins, and members when Settings → Rooms shows them. The limits every
 * message runs under, the running or last message's time, tokens and
 * spend (never an amount on someone else's own subscription), and the
 * last day in total once enough people wrote that it singles out nobody.
 */
export function RoomUsage({ roomId }: { roomId: string }) {
    const { t } = useTranslation(['rooms']);
    const { limitsLine, cycleLines, heading } = useRoomUsageWords();
    const [usage, setUsage] = useState<RoomUsageView>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        roomsApi.usage(roomId, controller.signal).then(setUsage, (reason) => {
            if (!controller.signal.aborted) {
                setError(failure(reason, t('rooms:usage.load-failed')));
            }
        });
        return () => controller.abort();
    }, [roomId, t]);
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
                {t('rooms:usage.loading')}
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
                    ? t(stopped ? 'rooms:usage.day-stopped' : 'rooms:usage.day', {
                          messages: t('rooms:usage.messages', { count: usage.day.cycles }),
                          tokens: t('rooms:usage.tokens', { count: usage.day.tokens }),
                          stopped,
                      })
                    : t('rooms:usage.day-hidden', { n: ROOM_USAGE_MIN_PEOPLE })}
            </p>
        </div>
    );
}
