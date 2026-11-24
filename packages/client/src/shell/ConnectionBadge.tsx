import { WifiOff, WifiSync, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import { dateTimeFormat, formatNumber } from '@socio/shared/locale';

import { LocalTime } from '../lib/local-time';

import { latencyQuality, useConnectionStatus, useLatencySampling, type ConnectionState } from './connection-status';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const STATE_LABEL: Record<ConnectionState, string> = {
    online: 'Online',
    reconnecting: 'Reconnecting',
    offline: 'Offline',
};
/** What the live region says once the server answers again. */
export const RESTORED_ANNOUNCEMENT = 'Connection to Socio restored.';
/** How long the announcement stays, so the next one is heard again. */
const ANNOUNCE_MS = 5000;
/** Leaves a hover-opened popover this long to reach it. */
const HOVER_CLOSE_MS = 150;

const clock = dateTimeFormat({ timeStyle: 'medium' });
const time = (value: number) => clock.format(value);
const ms = (value: number) => `${formatNumber(value)} ms`;

function icon(state: ConnectionState): LucideIcon {
    return state === 'offline' ? WifiOff : WifiSync;
}

/** The connection as both indicators show it: its state, quality and label. */
function useConnectionView() {
    const status = useConnectionStatus();
    const { state, latencies } = status;
    const latest = latencies.at(-1);
    const quality = state === 'online' && latest !== undefined ? latencyQuality(latest) : undefined;
    const label = [
        `Connection: ${STATE_LABEL[state]}`,
        quality && latest !== undefined ? `${ms(latest)}, ${quality}` : '',
    ]
        .filter(Boolean)
        .join(', ');
    return { ...status, latest, quality, label };
}

/**
 * The details popover around `trigger` (a button): hover or tap shows the
 * state, the last round trip and recent ones, the last check and the last
 * disconnect.
 */
function ConnectionDetails({
    trigger,
}: {
    trigger: (props: {
        onPointerEnter: (event: PointerEvent) => void;
        onPointerLeave: (event: PointerEvent) => void;
        onClick: (event: MouseEvent) => void;
    }) => ReactNode;
}) {
    const { state, latencies, lastCheck, lastDisconnect, latest, quality } = useConnectionView();
    const [open, setOpen] = useState(false);
    // Opened by a mouse hovering, not a click or tap: leaving closes it.
    const hovered = useRef(false);
    const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
    const keep = () => clearTimeout(closing.current);
    const leave = (event: PointerEvent) => {
        if (event.pointerType !== 'mouse' || !hovered.current) {
            return;
        }
        keep();
        closing.current = setTimeout(() => {
            hovered.current = false;
            setOpen(false);
        }, HOVER_CLOSE_MS);
    };
    useEffect(() => keep, []);
    const title = useId();
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                keep();
                hovered.current = false;
                setOpen(next);
            }}
        >
            <PopoverTrigger asChild>
                {trigger({
                    onPointerEnter: (event) => {
                        if (event.pointerType !== 'mouse') {
                            return;
                        }
                        keep();
                        if (open) {
                            return;
                        }
                        hovered.current = true;
                        setOpen(true);
                    },
                    onPointerLeave: leave,
                    onClick: (event) => {
                        // A click on a hover-opened popover keeps it open.
                        if (!hovered.current) {
                            return;
                        }
                        hovered.current = false;
                        event.preventDefault();
                    },
                })}
            </PopoverTrigger>
            <PopoverContent
                align="end"
                aria-labelledby={title}
                data-slot="connection-details"
                className="w-[min(18rem,calc(100vw-1.5rem))] text-sm motion-reduce:animate-none"
                collisionPadding={8}
                // Hovering shows the details without taking the focus.
                onOpenAutoFocus={(event) => {
                    if (hovered.current) {
                        event.preventDefault();
                    }
                }}
                onPointerEnter={keep}
                onPointerLeave={leave}
            >
                <h2 id={title} className="mb-2 font-medium">
                    Connection to Socio
                </h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{STATE_LABEL[state]}</dd>
                    <dt className="text-muted-foreground">Round trip</dt>
                    <dd className="tabular-nums">
                        {latest === undefined ? 'Not measured yet' : `${ms(latest)}${quality ? ` (${quality})` : ''}`}
                    </dd>
                    {latencies.length > 1 && (
                        <>
                            <dt className="text-muted-foreground">Recent</dt>
                            <dd className="tabular-nums">{latencies.map(ms).join(', ')}</dd>
                        </>
                    )}
                    <dt className="text-muted-foreground">Last check</dt>
                    <dd>{lastCheck === undefined ? 'Not yet' : <LocalTime value={lastCheck} format={time} />}</dd>
                    <dt className="text-muted-foreground">Last disconnect</dt>
                    <dd>
                        {lastDisconnect === undefined ? (
                            'None since this tab opened'
                        ) : (
                            <LocalTime value={lastDisconnect} format={time} />
                        )}
                    </dd>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">
                    Measured from this browser to the Socio server about every 30 seconds while this tab is in view.
                </p>
            </PopoverContent>
        </Popover>
    );
}

/**
 * The header's connection badge (CB-263, CB-308): nothing while all is
 * well (the account row's dot says so quietly), and an icon with
 * Reconnecting or Offline beside it otherwise, so a lost connection shows
 * even with the sidebar collapsed or in its sheet on a phone. It owns the
 * round-trip sampling, since the header is always mounted. A lost
 * connection is announced by the shell's toast (notice-toasts.ts); its
 * return, which closes that toast quietly, is announced here.
 *
 * On phones it is the header's one status indicator, so it always shows:
 * while online, the account row's dot (which is in the navigation sheet
 * there) as a button of the header's size, green, or amber while slow.
 */
export function ConnectionBadge() {
    useLatencySampling();
    const { state, quality, label } = useConnectionView();
    const announcement = useRestoredAnnouncement(state);
    const Icon = icon(state);
    return (
        <>
            {state === 'online' ? (
                <ConnectionDetails
                    trigger={(handlers) => (
                        <Button
                            variant="ghost"
                            size="icon"
                            data-slot="connection-indicator"
                            data-state-connection={state}
                            aria-label={label}
                            title={label}
                            className="md:hidden"
                            {...handlers}
                        >
                            <span
                                aria-hidden
                                className={cn(
                                    'size-2.5 rounded-full',
                                    quality === 'slow'
                                        ? 'bg-amber-500 dark:bg-amber-400'
                                        : 'bg-emerald-600 dark:bg-emerald-400',
                                )}
                            />
                        </Button>
                    )}
                />
            ) : (
                <ConnectionDetails
                    trigger={(handlers) => (
                        <Button
                            variant="ghost"
                            size="sm"
                            data-slot="connection-badge"
                            data-state-connection={state}
                            aria-label={label}
                            className={cn(
                                'max-md:size-9 max-md:px-0',
                                state === 'reconnecting' && 'text-amber-700 dark:text-amber-400',
                                state === 'offline' && 'text-destructive',
                            )}
                            {...handlers}
                        >
                            <Icon
                                aria-hidden
                                className={cn('size-4.5', state === 'reconnecting' && 'motion-safe:animate-pulse')}
                            />
                            <span className="max-md:hidden">{STATE_LABEL[state]}</span>
                        </Button>
                    )}
                />
            )}
            <span role="status" aria-live="polite" data-slot="connection-announcement" className="sr-only">
                {announcement}
            </span>
        </>
    );
}

/**
 * The connection as a small dot beside the person's name in the sidebar's
 * account row (CB-308): green while online, amber while slow or
 * reconnecting, red offline. Its label carries the word; hover or tap
 * shows the details.
 */
export function ConnectionDot({ className }: { className?: string }) {
    const { state, quality, label } = useConnectionView();
    const warn = state === 'reconnecting' || quality === 'slow';
    return (
        <ConnectionDetails
            trigger={(handlers) => (
                <button
                    type="button"
                    data-slot="connection-dot"
                    data-state-connection={state}
                    aria-label={label}
                    title={label}
                    className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
                        className,
                    )}
                    {...handlers}
                >
                    <span
                        aria-hidden
                        className={cn(
                            'size-2 rounded-full ring-2 ring-sidebar',
                            state === 'offline'
                                ? 'bg-destructive'
                                : warn
                                  ? 'bg-amber-500 dark:bg-amber-400'
                                  : 'bg-emerald-600 dark:bg-emerald-400',
                            state === 'reconnecting' && 'motion-safe:animate-pulse',
                        )}
                    />
                </button>
            )}
        />
    );
}

/**
 * The announcement for `state`: "restored" for a while each time it goes
 * back to online from reconnecting or offline, otherwise nothing.
 */
function useRestoredAnnouncement(state: ConnectionState) {
    const [announcement, setAnnouncement] = useState('');
    const previous = useRef(state);
    useEffect(() => {
        const was = previous.current;
        previous.current = state;
        if (state !== 'online') {
            setAnnouncement('');
            return;
        }
        if (was === 'online') {
            return;
        }
        setAnnouncement(RESTORED_ANNOUNCEMENT);
        const timer = setTimeout(() => setAnnouncement(''), ANNOUNCE_MS);
        return () => clearTimeout(timer);
    }, [state]);
    return announcement;
}
