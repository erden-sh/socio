import { useEffect, useRef, useState } from 'react';

import type { CodingThreadEventView, CodingThreadEventsPage } from '@socio/shared/coding/coding-sessions';
import { inertText } from '@socio/shared/text/inert-text';

import { api, ApiError } from '../../lib/api';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * The live transcript of a coding session's thread (CB-326 step 4): the
 * host's `ProviderAdapterV2Event` rows, paged by `ordinal`, shown as a
 * work-log of past-tense lines (T3 Code). While the session runs, the person
 * can interrupt the turn, steer it, roll it back to a turn (checkpoint), or
 * fork from one — controls that map to the host command op the supervisor
 * forwards to the provider adapter. Approvals are Socio's approval cards
 * (CodingRuntimeCard, on main), not here. Color follows the coding module's
 * tone (indigo). Everything the agent wrote is shown as plain text, never
 * Markdown or links.
 */

/** How often a live transcript asks for new events while the session runs. */
const POLL_MS = 2_000;
/** The most events kept in the view (older ones drop off the top). */
const MAX_EVENTS = 500;

const inert = (value: string, max = 2_000) => inertText(value, { max });

/** A one-line past-tense label for an event kind (T3 Code work-log). */
function eventLabel(kind: string, payload: string): { label: string; detail: string | null } {
    switch (kind) {
        case 'provider_session.updated':
            return { label: 'Session updated', detail: null };
        case 'provider_thread.updated':
            return { label: 'Thread updated', detail: null };
        case 'provider_turn.updated': {
            let detail: string | null = null;
            try {
                const turn = JSON.parse(payload).providerTurn as { status?: string } | undefined;
                detail = turn?.status ? `status ${turn.status}` : null;
            } catch {
                /* keep null */
            }
            return { label: 'Turn updated', detail };
        }
        case 'node.updated':
            return { label: 'Ran a step', detail: null };
        case 'subagent.updated':
            return { label: 'A sub-agent worked', detail: null };
        case 'message.updated': {
            let detail: string | null = null;
            try {
                const message = JSON.parse(payload).message as { role?: string; content?: string } | undefined;
                const text = typeof message?.content === 'string' ? message.content : null;
                detail = text ? inert(text, 240) : (message?.role ?? null);
            } catch {
                /* keep null */
            }
            return { label: 'Agent said', detail };
        }
        case 'turn_item.updated':
            return { label: 'Produced an item', detail: null };
        case 'background_work.updated':
            return { label: 'Background work pending', detail: null };
        case 'command_output.delta':
            return { label: 'Command output', detail: inert(payload, 240) };
        case 'runtime_request.updated': {
            let detail: string | null = null;
            try {
                const request = JSON.parse(payload).runtimeRequest as
                    | {
                          kind?: string;
                          status?: string;
                          payload?: { command?: string };
                      }
                    | undefined;
                detail = request?.payload?.command ? inert(request.payload.command, 240) : (request?.status ?? null);
            } catch {
                /* keep null */
            }
            return { label: 'Asked for approval', detail };
        }
        case 'plan.updated':
            return { label: 'Updated its plan', detail: null };
        case 'turn.terminal': {
            let detail: string | null = null;
            try {
                const terminal = JSON.parse(payload) as { status?: string };
                detail = terminal.status ? `turn ${terminal.status}` : null;
            } catch {
                /* keep null */
            }
            return { label: 'Turn ended', detail };
        }
        case 'thread.snapshot':
            return { label: 'Snapshot taken', detail: null };
        case 'thread.rolledback':
            return { label: 'Rolled back', detail: null };
        case 'thread.forked':
            return { label: 'Forked the thread', detail: null };
        default:
            return { label: kind, detail: null };
    }
}

/** Whether a session is live enough to keep polling for events. */
function isLive(state: string, runState: string | undefined): boolean {
    if (state === 'starting' || state === 'ready') {
        return true;
    }
    if (state === 'ended') {
        return false;
    }
    return runState === 'running';
}

export function CodingThreadTranscript({
    id,
    state,
    runState,
}: {
    id: string;
    state: string;
    runState: string | undefined;
}) {
    const [events, setEvents] = useState<CodingThreadEventView[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [after, setAfter] = useState(0);
    const [busy, setBusy] = useState<string | null>(null);
    const live = isLive(state, runState);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Poll the events page while the session is live; stop when it ends.
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setInterval> | undefined;
        const load = () =>
            api<CodingThreadEventsPage>(
                `/gateway/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=100`,
                'GET',
                undefined,
                controller.signal,
            ).then(
                (page) => {
                    if (page && Array.isArray(page.events) && page.events.length > 0) {
                        setEvents((prev) => [...prev, ...page.events].slice(-MAX_EVENTS));
                        setAfter(page.next ?? page.events.at(-1)?.ordinal ?? after);
                    }
                    setError(null);
                },
                (failure: unknown) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    setError(
                        failure instanceof ApiError && failure.status === 404
                            ? null
                            : 'The live transcript couldn’t be loaded.',
                    );
                },
            );
        void load();
        if (live) {
            timer = setInterval(() => void load(), POLL_MS);
        }
        return () => {
            controller.abort();
            clearInterval(timer);
        };
        // `after` is intentionally excluded: the poller keeps its own cursor so
        // a re-render on each page doesn't reset it. eslint-disable react-hooks/exhaustive-deps
    }, [id, live]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep the newest line in view as events arrive.
    useEffect(() => {
        const node = scrollRef.current;
        if (node) {
            node.scrollTop = node.scrollHeight;
        }
    }, [events]);

    const send = async (op: 'interrupt' | 'steer' | 'rollback' | 'fork', body: Record<string, unknown>) => {
        setBusy(op);
        try {
            await api(`/gateway/sessions/${encodeURIComponent(id)}/control`, 'POST', { op, ...body });
            setError(null);
        } catch (failure) {
            setError(
                failure instanceof ApiError && failure.message ? failure.message : 'The control couldn’t be sent.',
            );
        } finally {
            setBusy(null);
        }
    };

    const running = runState === 'running' && state !== 'ended';
    const lastTurnId = [...events].reverse().find((event) => event.nativeTurnId)?.nativeTurnId ?? null;

    return (
        <div className="grid min-w-0 gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">Live transcript</span>
                <Badge variant={running ? 'secondary' : 'outline'} data-tone="indigo">
                    {running ? 'Working' : events.length > 0 ? 'Idle' : 'Waiting'}
                </Badge>
            </div>
            <div
                ref={scrollRef}
                className="grid max-h-64 min-w-0 gap-0.5 overflow-y-auto rounded-[0.5rem] bg-muted/40 p-2 font-mono text-xs"
                aria-live="polite"
                aria-label="Coding session thread events"
            >
                {events.length === 0 && !error && (
                    <p className="m-0 text-muted-foreground">The agent’s steps will appear here as it works.</p>
                )}
                {events.map((event) => {
                    const { label, detail } = eventLabel(event.kind, event.payload);
                    return (
                        <p key={event.id} className="m-0 [overflow-wrap:anywhere]">
                            <span className="text-muted-foreground">{label}</span>
                            {detail && <span className="ml-1">{detail}</span>}
                        </p>
                    );
                })}
            </div>
            {error && (
                <p className="m-0 text-xs text-muted-foreground" role="status">
                    {error}
                </p>
            )}
            {state !== 'ended' && (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {running && (
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => void send('interrupt', {})}
                        >
                            {busy === 'interrupt' ? 'Interrupting…' : 'Interrupt'}
                        </Button>
                    )}
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => {
                            const message = window.prompt('Steer the agent with new words:');
                            if (message && message.trim()) {
                                void send('steer', { message });
                            }
                        }}
                    >
                        {busy === 'steer' ? 'Steering…' : 'Steer'}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || !lastTurnId}
                        title={lastTurnId ? `Roll back to turn ${lastTurnId}` : 'No turn to roll back to yet'}
                        onClick={() => {
                            if (lastTurnId && window.confirm('Roll the thread back to the last turn?')) {
                                void send('rollback', { beforeTurnId: lastTurnId });
                            }
                        }}
                    >
                        {busy === 'rollback' ? 'Rolling back…' : 'Roll back'}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || !lastTurnId}
                        title={lastTurnId ? `Fork from turn ${lastTurnId}` : 'No turn to fork from yet'}
                        onClick={() => {
                            if (lastTurnId && window.confirm('Fork the thread from the last turn?')) {
                                void send('fork', { lastTurnId });
                            }
                        }}
                    >
                        {busy === 'fork' ? 'Forking…' : 'Fork'}
                    </Button>
                </div>
            )}
        </div>
    );
}
