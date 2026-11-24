import { useCallback, useEffect, useRef, useState } from 'react';

import {
    CODING_END_WORDS,
    type CodingSandboxList as SandboxList,
    type CodingSandboxView,
} from '@socio/shared/coding/coding-sessions';
import { inertText } from '@socio/shared/text/inert-text';

import { api } from '../../lib/api';
import { plainHover } from '../../lib/plain-button';
import { formatBytes } from '../dataspace/format';

import { cn } from '@/lib/utils';

/**
 * The coding sandboxes in a socio's Computer panel (CB-239):
 * the viewer's own sessions on this socio (an admin sees everyone's), with
 * status, repository, branch, age and the workspace's disk, and Stop,
 * which ends a session the way `coding_stop` does. Nothing the agent
 * wrote is here: that stays on the person's own session card.
 */

const POLL_MS = 10_000;
const focusRing =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#476ba0] dark:focus-visible:outline-[#80a6df]';
const button = cn(
    'shrink-0 rounded-[6px] border border-[#bac2cd] bg-white px-2.5 py-[5px] text-[#273243] disabled:cursor-default dark:border-[#51555b] dark:bg-card dark:text-[#d2e0f6]',
    plainHover,
    focusRing,
);
const hint = 'text-[11px] text-[#596373] dark:text-[#abb6c8]';

/** "3 min", "2 h 5 min", "4 days": how long ago, roughly. */
export function ageText(from: number, now: number) {
    const minutes = Math.max(0, Math.floor((now - from) / 60_000));
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''} ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function sandboxStatus(view: CodingSandboxView) {
    if (view.state === 'ended') {
        return view.endReason ? (CODING_END_WORDS[view.endReason] ?? 'Ended') : 'Ended';
    }
    if (view.state === 'starting') {
        return 'Setting up';
    }
    return view.working ? 'Working' : 'Ready';
}

const plain = (value: string, max = 200) => inertText(value, { max, lines: false });

export function CodingSandboxList({ dotId, active }: { dotId: string; active: boolean }) {
    const [list, setList] = useState<SandboxList>();
    const [error, setError] = useState('');
    const [stopping, setStopping] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const controller = useRef<AbortController | null>(null);
    const load = useCallback(async () => {
        try {
            const next = await api<SandboxList>(
                `/gateway/sandboxes?socio=${encodeURIComponent(dotId)}`,
                'GET',
                undefined,
                controller.current?.signal,
            );
            setList(next);
            setNow(Date.now());
            setError('');
        } catch (cause) {
            if (controller.current?.signal.aborted) {
                return;
            }
            setError(cause instanceof Error ? cause.message : 'The coding sessions couldn’t be loaded.');
        }
    }, [dotId]);
    useEffect(() => {
        if (!active) {
            return;
        }
        controller.current = new AbortController();
        void load();
        const timer = setInterval(() => {
            if (!document.hidden) {
                void load();
            }
        }, POLL_MS);
        return () => {
            controller.current?.abort();
            clearInterval(timer);
        };
    }, [active, load]);
    const stop = async (view: CodingSandboxView) => {
        if (stopping) {
            return;
        }
        setStopping(view.id);
        setError('');
        try {
            await api<CodingSandboxView>(
                `/gateway/sandboxes/${encodeURIComponent(view.id)}/stop`,
                'POST',
                {},
                controller.current?.signal,
            );
            await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The session didn’t stop.');
        } finally {
            setStopping(null);
        }
    };
    if (!list) {
        return (
            <p className="mt-2 mb-3" role={error ? 'alert' : 'status'}>
                {error || 'Loading coding sessions…'}
            </p>
        );
    }
    return (
        <div className="mt-2" data-slot="coding-sandboxes">
            {error && (
                <p
                    className="mt-2 mb-3 rounded-[5px] bg-[#fff0f0] p-2.5 text-[#a32b32] [overflow-wrap:anywhere] dark:bg-[#2a2323] dark:text-[#ff9894]"
                    role="alert"
                >
                    {error}
                </p>
            )}
            {list.sandboxes.length === 0 ? (
                <p className="mt-2 mb-3">No coding sessions on this computer.</p>
            ) : (
                <ul className="my-2 list-none p-0" aria-label="Coding sessions">
                    {list.sandboxes.map((view) => (
                        <li
                            key={view.id}
                            className="border-b border-b-border py-2"
                            data-slot="coding-sandbox"
                            data-state={view.state}
                        >
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                                <strong className="min-w-0 [overflow-wrap:anywhere]">{plain(view.repository)}</strong>
                                <span className="text-[12px]">{sandboxStatus(view)}</span>
                            </div>
                            <span className={cn('block font-mono [overflow-wrap:anywhere]', hint)}>
                                {plain(view.branch)} from {plain(view.base)}
                            </span>
                            <span className={cn('block', hint)}>
                                {view.mine ? 'Yours' : `For ${view.personName}`} · started{' '}
                                {ageText(view.createdAt, now)} ·{' '}
                                {view.diskBytes === null
                                    ? 'disk not measured yet'
                                    : `${formatBytes(view.diskBytes)} on disk`}
                                {view.state === 'ended' && !view.sandbox ? ' · workspace kept' : ''}
                            </span>
                            {view.canStop && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        className={button}
                                        disabled={stopping !== null}
                                        aria-label={`Stop the coding session on ${plain(view.repository)}`}
                                        onClick={() => void stop(view)}
                                    >
                                        {stopping === view.id ? 'Stopping…' : 'Stop'}
                                    </button>
                                    {!view.mine && (
                                        <span className={hint}>
                                            Stopping someone else’s session is recorded with your name.
                                        </span>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <p className={hint}>
                Stopping ends the session and removes its sandbox; the workspace is kept for the next session on that
                repository until its retention.
                {list.diskMeasuredAt ? ` Disk measured ${ageText(list.diskMeasuredAt, now)}.` : ''}
            </p>
        </div>
    );
}
