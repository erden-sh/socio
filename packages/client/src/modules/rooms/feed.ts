import { EventType, type BaseEvent } from '@ag-ui/core';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { QueuedMessage, SteeringView } from '@socio/shared/chat/steering';
import {
    applyRoomEvent,
    NO_LIVE_TURN,
    stillLive,
    type LiveTurn,
    type RoomMessage,
    type RoomPhase,
} from '@socio/shared/rooms/live-turn';
import {
    ROOM_STREAM_CLOSED,
    ROOM_STREAM_CURSOR,
    type RoomStreamClosed,
    type RoomStreamCursor,
} from '@socio/shared/rooms/rooms';
import { TraceTimes, type Span } from '@socio/shared/runs/trace-times';
import type { TranscriptTurnProblem } from '@socio/shared/types';

import { api, ApiError } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { CurrentUser } from '../../shell/current-user';

export type { RoomMessage, RoomPhase };

/** A `TraceTimes.snapshot` as the transcript route sends it (CB-283). */
interface TraceTimesSnapshot {
    messages: Iterable<[string, number]>;
    tools: Iterable<[string, Span]>;
    reasoning: Iterable<[string, Span]>;
}

/** What `GET /conversations/:id/transcript` answers for a room. */
interface RoomTranscript {
    messages: RoomMessage[];
    /** The newest run it holds: the live stream goes on from there. */
    cursor?: number;
    /** The person messages the running turn took so far (CB-215). */
    inTurn?: string[];
    problems?: TranscriptTurnProblem[];
    /** When each step happened (CB-72, CB-128), for the trace (CB-283). */
    times?: TraceTimesSnapshot;
}

/**
 * What a room's screen reads (CB-212): the shared transcript, whether a
 * turn runs, and the reader's own queued messages. One shape whatever
 * feeds it: the room's live stream, or polling when the stream can't be
 * had.
 */
export interface RoomFeed {
    /**
     * Undefined until the first read. Oldest first, as stored, then the
     * running turn's messages as they come (the stream's).
     */
    messages?: RoomMessage[];
    /** A turn runs in the room, whoever started it. */
    running: boolean;
    /**
     * What the running turn does: thinking (another person's turn shows only
     * that, never the reasoning), using tools, or writing.
     */
    phase?: RoomPhase;
    /** The reply being written now, if any. */
    streamingId?: string;
    /** Turns that ended without an answer: refused, failed, cut off. */
    problems: TranscriptTurnProblem[];
    /**
     * When each step of a socio's turn happened (CB-72, CB-128), so the room
     * transcript shows its thinking traces and tool calls (CB-283). Kept for
     * the room's lifetime, absorbing the live stream's times as they come.
     */
    times?: TraceTimes;
    /** The reader's messages waiting for the socio, oldest first. */
    queued: QueuedMessage[];
    /** The most that may wait; undefined until read. */
    limit?: number;
    /**
     * The reader's messages a turn took from the queue that the transcript
     * doesn't show yet (it stores a turn's messages as it goes): shown as
     * being read, so a message never vanishes between the two.
     */
    delivering: QueuedMessage[];
    /** The last read failed: what it said. */
    error: string;
    /** The room no longer answers the reader (removed, left, gone). */
    gone: boolean;
    /** Updates come live (the stream), not by polling. */
    live: boolean;
    /** Reads again now (after a send, a stop, a membership change). */
    refresh: () => void;
    /**
     * The reader just queued `message`: it shows until the transcript has
     * it, even when a turn takes it before the next read.
     */
    sent: (message: QueuedMessage) => void;
}

/**
 * How often the room is read while a turn runs, and while it is quiet,
 * when its live stream can't be had (the fallback).
 */
export const ROOM_POLL_MS = { running: 1_500, idle: 4_000 } as const;
/** The live stream is tried again after this, doubling up to the most. */
export const ROOM_STREAM_RETRY_MS = { first: 2_000, most: 30_000 } as const;

/**
 * The room's feed (CB-212). The transcript (`/transcript`) and the
 * reader's queue (`/steering`) are read when the room opens; then the
 * room's live stream (`/stream`, from the transcript's cursor) shows the
 * running turn as it happens (its people's messages, the reply as it is
 * written, "thinking…" for another person's reasoning) and, as each turn
 * is stored, its cursor has both read again. When the server ends the
 * stream (`closed`: the reader removed or gone, the room archived, Rooms
 * off) the room is read again, and the stream opened again while the
 * reader may still read it. Without a stream (none in this browser, or it
 * dropped) the room is polled as before (faster while a turn runs) until
 * the stream is back. A tab out of view doesn't poll; it reads again as it
 * comes back, and at once on another tab's note. The latest read wins, so
 * an older answer never undoes a newer one.
 */
export function useRoomFeed(threadId: string): RoomFeed {
    const me = useContext(CurrentUser)?.id;
    const [messages, setMessages] = useState<RoomMessage[]>();
    const [problems, setProblems] = useState<TranscriptTurnProblem[]>([]);
    const [steering, setSteering] = useState<Partial<SteeringView>>({});
    const [error, setError] = useState('');
    const [gone, setGone] = useState(false);
    const [delivering, setDelivering] = useState<QueuedMessage[]>([]);
    const [turn, setTurn] = useState<LiveTurn>(NO_LIVE_TURN);
    const [live, setLive] = useState(false);
    const [loaded, setLoaded] = useState(false);
    // When each step happened (CB-283): rebuilt from the transcript's
    // snapshot, and kept up as the live stream adds times.
    const [times, setTimes] = useState<TraceTimes>();
    const timesRef = useRef<TraceTimes | undefined>(undefined);
    timesRef.current = times;
    const reads = useRef(0);
    // The queue as last read, to tell which messages a turn took.
    const lastQueue = useRef<QueuedMessage[]>([]);
    // Where the stream goes on from: the newest run the reader has.
    const cursor = useRef(0);
    const turnRef = useRef(turn);
    turnRef.current = turn;
    const base = `/conversations/${encodeURIComponent(threadId)}`;
    const load = useCallback(async () => {
        const read = (reads.current += 1);
        try {
            // The queue first, then the transcript: a message a turn took from
            // the queue before this read is in the transcript's running turn
            // (`inTurn`), so one that is in neither was canceled (CB-215).
            // Only members have a queue; a read-only room still has one to read.
            const queue = await api<SteeringView>(`${base}/steering`).catch(() => undefined);
            const transcript = await api<RoomTranscript>(`${base}/transcript`);
            if (read !== reads.current) {
                return;
            }
            setMessages(transcript.messages);
            setProblems(transcript.problems ?? []);
            // Rebuild the trace's times from the snapshot (CB-283), then absorb
            // what the live stream has added since (a turn still running).
            if (transcript.times) {
                const rebuilt = new TraceTimes();
                rebuilt.absorb(transcript.times);
                setTimes(rebuilt);
            } else {
                setTimes(undefined);
            }
            if (transcript.cursor !== undefined) {
                cursor.current = Math.max(cursor.current, transcript.cursor);
            }
            setTurn((current) => stillLive(current, transcript.messages));
            if (queue) {
                setSteering(queue);
                // What shows already: the transcript and the running turn's.
                const shown = [...transcript.messages, ...turnRef.current.messages];
                const taken = tookFromQueue(lastQueue.current, queue.messages, shown);
                setDelivering((current) =>
                    queue.running
                        ? stillDelivering([...current, ...taken], queue.messages, shown, transcript.inTurn)
                        : [],
                );
                lastQueue.current = queue.messages;
            }
            setError('');
            setGone(false);
            setLoaded(true);
        } catch (cause) {
            if (read !== reads.current) {
                return;
            }
            if (cause instanceof ApiError && cause.status === 404) {
                setGone(true);
            } else {
                setError(cause instanceof Error ? cause.message : 'Could not load this room.');
            }
        }
    }, [base]);
    useEffect(() => {
        setMessages(undefined);
        setProblems([]);
        setSteering({});
        setError('');
        setGone(false);
        setDelivering([]);
        setTurn(NO_LIVE_TURN);
        setLive(false);
        setLoaded(false);
        setTimes(undefined);
        lastQueue.current = [];
        cursor.current = 0;
    }, [base]);
    const canPoll = useLiveTopic(`conversation:${threadId}`, () => void load());

    // The live stream, once the room was read (its cursor known).
    useEffect(() => {
        if (!loaded || gone || typeof EventSource === 'undefined') {
            return;
        }
        let source: EventSource | undefined;
        let retry: ReturnType<typeof setTimeout> | undefined;
        let wait: number = ROOM_STREAM_RETRY_MS.first;
        let stopped = false;
        const open = () => {
            if (stopped) {
                return;
            }
            source = new EventSource(`/api${base}/stream?after=${cursor.current}`);
            source.onopen = () => {
                wait = ROOM_STREAM_RETRY_MS.first;
                setLive(true);
            };
            source.onmessage = (frame: MessageEvent<string>) => {
                let event: BaseEvent;
                try {
                    event = JSON.parse(frame.data) as BaseEvent;
                } catch {
                    return;
                }
                setTurn((current) => applyRoomEvent(current, event, me));
                // A step's time as the live stream stamps it (CB-283): kept with the
                // transcript's snapshot, so a running turn's trace shows its times too.
                if (event.timestamp !== undefined) {
                    setTimes((current) => {
                        const next = current ?? new TraceTimes();
                        next.add(event);
                        return next;
                    });
                }
                // Someone's turn took messages from the queue (the reader's too).
                if (event.type === EventType.RUN_STARTED) {
                    void load();
                }
            };
            source.addEventListener(ROOM_STREAM_CURSOR, (frame) => {
                try {
                    const { seq } = JSON.parse((frame as MessageEvent<string>).data) as RoomStreamCursor;
                    if (typeof seq === 'number') {
                        cursor.current = Math.max(cursor.current, seq);
                    }
                } catch {
                    // A cursor that can't be read: the next one says.
                }
                void load();
            });
            source.addEventListener(ROOM_STREAM_CLOSED, (frame) => {
                let reason: RoomStreamClosed['reason'] | undefined;
                try {
                    reason = (JSON.parse((frame as MessageEvent<string>).data) as RoomStreamClosed).reason;
                } catch {
                    // Read again: the room says what changed.
                }
                // Ended by the server: read the room again (a 404 is "gone"); a
                // reader who may still read it connects again.
                drop();
                setTurn(NO_LIVE_TURN);
                void load();
                if (reason !== 'removed' && reason !== 'left') {
                    later(0);
                }
            });
            source.onerror = () => {
                // Dropped (or refused): poll until it is back, from the newest
                // run read since.
                drop();
                later(wait);
                wait = Math.min(wait * 2, ROOM_STREAM_RETRY_MS.most);
            };
        };
        const drop = () => {
            source?.close();
            source = undefined;
            setLive(false);
        };
        const later = (ms: number) => {
            clearTimeout(retry);
            retry = setTimeout(open, ms);
        };
        open();
        return () => {
            stopped = true;
            clearTimeout(retry);
            drop();
        };
    }, [base, loaded, gone, load, me]);

    const running = live ? turn.running : !!steering.running;
    // The reader's own messages waiting while a turn runs: a room admin may
    // cancel them (CB-215), which the stream doesn't say, so they are read
    // again as often as without it.
    const waiting = running && (!!steering.messages?.length || delivering.length > 0);
    // Polling: the first read, and while there is no stream (or the
    // reader's messages wait).
    useEffect(() => {
        void load();
    }, [load]);
    useEffect(() => {
        const back = () => {
            if (!document.hidden) {
                void load();
            }
        };
        document.addEventListener('visibilitychange', back);
        if (live && !waiting) {
            return () => document.removeEventListener('visibilitychange', back);
        }
        const timer = setInterval(
            () => {
                if (typeof document !== 'undefined' && document.hidden) {
                    return;
                }
                if (canPoll()) {
                    void load();
                }
            },
            running ? ROOM_POLL_MS.running : ROOM_POLL_MS.idle,
        );
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', back);
        };
    }, [load, canPoll, running, live, waiting]);
    const pending = stillLive(turn, messages).messages;
    return {
        messages: messages && [...messages, ...pending],
        running,
        ...(live && running && turn.phase ? { phase: turn.phase } : {}),
        ...(live && turn.streamingId ? { streamingId: turn.streamingId } : {}),
        problems,
        times,
        queued: steering.messages ?? [],
        limit: steering.limit,
        delivering: delivering.filter((message) => !pending.some((shown) => shown.id === message.id)),
        error,
        gone,
        live,
        refresh: () => void load(),
        sent: (message) => {
            lastQueue.current = [...lastQueue.current, message];
            void load();
        },
    };
}

/**
 * Queued messages the transcript already shows are delivered: a queued
 * message keeps its id when a turn takes it, so a read that caught it in
 * both places shows it once.
 */
export function stillQueued(queued: readonly QueuedMessage[], messages: readonly RoomMessage[] | undefined) {
    if (!messages) {
        return [...queued];
    }
    const shown = new Set(messages.map((message) => message.id));
    return queued.filter((message) => !shown.has(message.id));
}

/**
 * The messages that left the queue since the last read without showing
 * in the transcript: a turn took them.
 */
export function tookFromQueue(
    before: readonly QueuedMessage[],
    queue: readonly QueuedMessage[],
    messages: readonly RoomMessage[],
) {
    const waiting = new Set(queue.map((message) => message.id));
    const shown = new Set(messages.map((message) => message.id));
    return before.filter((message) => !waiting.has(message.id) && !shown.has(message.id));
}

/**
 * Those still being read: neither back in the queue (a turn that failed
 * puts them back) nor in the transcript yet; each once. Given the running
 * turn's person messages (`inTurn`, the transcript's), only those it took:
 * one it didn't was canceled, by a room admin say (CB-215), and goes.
 */
export function stillDelivering(
    delivering: readonly QueuedMessage[],
    queue: readonly QueuedMessage[],
    messages: readonly RoomMessage[],
    inTurn?: readonly string[],
) {
    const elsewhere = new Set([...queue.map((message) => message.id), ...messages.map((message) => message.id)]);
    const taken = inTurn && new Set(inTurn);
    const seen = new Set<string>();
    return delivering.filter((message) => {
        if (elsewhere.has(message.id) || seen.has(message.id)) {
            return false;
        }
        if (taken && !taken.has(message.id)) {
            return false;
        }
        seen.add(message.id);
        return true;
    });
}
