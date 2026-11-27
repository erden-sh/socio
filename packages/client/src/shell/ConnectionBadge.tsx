import { WifiOff, WifiSync, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { dateTimeFormat } from '@socio/shared/locale';

import { onDemand, useOnDemand } from '../i18n/on-demand';
import { LocalTime } from '../lib/local-time';

import {
    latencyQuality,
    useConnectionStatus,
    useLatencySampling,
    type ConnectionState,
    type LatencyQuality,
} from './connection-status';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** How long the announcement stays, so the next one is heard again. */
const ANNOUNCE_MS = 5000;
/** Leaves a hover-opened popover this long to reach it. */
const HOVER_CLOSE_MS = 150;

const clock = dateTimeFormat({ timeStyle: 'medium' });
const time = (value: number) => clock.format(value);

/**
 * The connection's words: its state and a round trip from the root's
 * `shell` namespace; a round trip's quality, and the details, from
 * `shell.status`, which loads once the page is up (round trips are only
 * measured in the browser). `measured` says whether those are in.
 */
function useConnectionWords() {
    const { t } = useTranslation(['shell']);
    const status = useTranslation(['shell.status']).t;
    const measured = useOnDemand(['shell.status']);
    return {
        state: (state: ConnectionState) => t(`shell:connection.state.${state}`),
        ms: (value: number) => t('shell:connection.ms', { ms: value }),
        quality: (quality: LatencyQuality) => status(`shell.status:quality.${quality}`),
        measured,
        t,
        status,
    };
}

function icon(state: ConnectionState): LucideIcon {
    return state === 'offline' ? WifiOff : WifiSync;
}

/** The connection as both indicators show it: its state, quality and label. */
function useConnectionView() {
    const words = useConnectionWords();
    const status = useConnectionStatus();
    const { state, latencies } = status;
    const latest = latencies.at(-1);
    const quality = state === 'online' && latest !== undefined ? latencyQuality(latest) : undefined;
    const label =
        quality && latest !== undefined && words.measured
            ? words.status('shell.status:label-measured', {
                  state: words.state(state),
                  latency: words.ms(latest),
                  quality: words.quality(quality),
              })
            : words.t('shell:connection.label', { state: words.state(state) });
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
                <DetailsBody title={title} />
            </PopoverContent>
        </Popover>
    );
}

/** The popover's details, in `shell.status` (loaded when it first opens). */
const DetailsBody = onDemand(['shell.status'], function DetailsBody({ title }: { title: string }) {
    const { t } = useTranslation(['shell.status']);
    const words = useConnectionWords();
    const { state, latencies, lastCheck, lastDisconnect, latest, quality } = useConnectionView();
    return (
        <>
            <h2 id={title} className="mb-2 font-medium">
                {t('shell.status:title')}
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">{t('shell.status:status')}</dt>
                <dd>{words.state(state)}</dd>
                <dt className="text-muted-foreground">{t('shell.status:round-trip')}</dt>
                <dd className="tabular-nums">
                    {latest === undefined
                        ? t('shell.status:not-measured')
                        : quality
                          ? t('shell.status:latency-quality', {
                                latency: words.ms(latest),
                                quality: words.quality(quality),
                            })
                          : words.ms(latest)}
                </dd>
                {latencies.length > 1 && (
                    <>
                        <dt className="text-muted-foreground">{t('shell.status:recent')}</dt>
                        <dd className="tabular-nums">
                            {t('shell.status:recent-list', { latencies: latencies.map(words.ms) })}
                        </dd>
                    </>
                )}
                <dt className="text-muted-foreground">{t('shell.status:last-check')}</dt>
                <dd>
                    {lastCheck === undefined ? (
                        t('shell.status:not-yet')
                    ) : (
                        <LocalTime value={lastCheck} format={time} />
                    )}
                </dd>
                <dt className="text-muted-foreground">{t('shell.status:last-disconnect')}</dt>
                <dd>
                    {lastDisconnect === undefined ? (
                        t('shell.status:no-disconnect')
                    ) : (
                        <LocalTime value={lastDisconnect} format={time} />
                    )}
                </dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">{t('shell.status:how')}</p>
        </>
    );
});

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
    const words = useConnectionWords();
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
                            <span className="max-md:hidden">{words.state(state)}</span>
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
    const { t } = useTranslation(['shell']);
    const restored = t('shell:connection.restored');
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
        setAnnouncement(restored);
        const timer = setTimeout(() => setAnnouncement(''), ANNOUNCE_MS);
        return () => clearTimeout(timer);
    }, [state, restored]);
    return announcement;
}
