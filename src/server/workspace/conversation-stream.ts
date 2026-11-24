import { EventType, type BaseEvent } from '@ag-ui/client';
import type { Observable, Subscription } from 'rxjs';

import {
    ROOM_STREAM_CLOSED,
    ROOM_STREAM_CURSOR,
    type RoomStreamCloseReason,
    type RoomStreamClosed,
    type RoomStreamCursor,
} from '@socio/shared/rooms/rooms';

import type { ReaderEventsShape, StreamsShape } from '../rooms/contract.js';
import type { RunnerShape } from '../turns/contract.js';

/** Silence before a keep-alive comment: under proxies' idle timeouts. */
export const STREAM_KEEP_ALIVE_MS = 15_000;

/**
 * A conversation's events for one reader, as server-sent events (CB-212).
 * `connect` is the AG-UI runtime's connect: the runs after
 * the reader's cursor (`HISTORY_AFTER_HEADER`), then the turn in
 * progress, then the end, AG-UI frames only. `follow` stays open across
 * turns (`LocalAgentRunner.watch`) and adds Socio's named frames: a
 * cursor after each finished run, and why the server ended it.
 *
 * In a room the reader sees what the rule lets them (`readerFilter`:
 * other people's private results withheld). The stream is held in
 * `RoomStreams` under the conversation and the reader, so it closes the
 * moment they may no longer read it, on this runtime or another, and when
 * the server stops. A private chat is its owner's, unfiltered, as the
 * runtime's connect always was.
 */
export function conversationStream(input: {
    runner: RunnerShape;
    streams: StreamsShape;
    /** A room's events as one reader may see them (`ReaderEvents`, `readerFilter`). */
    readerEvents: ReaderEventsShape;
    threadId: string;
    /** Who reads it: a room's member, or a private chat's owner. */
    reader: string;
    /** A room: what `reader` sees is filtered (`readerFilter`). */
    room: boolean;
    /**
     * A private chat that became a room since its stream opened: the stream
     * ends at the next turn, so its owner connects again as a member and
     * never sees other people's turns unfiltered.
     */
    converted?: () => boolean;
    signal: AbortSignal;
    mode:
        | { kind: 'connect'; headers?: Record<string, string> }
        | {
              kind: 'follow';
              after: number;
          };
    keepAliveMs?: number;
}): Response {
    const { runner, streams, readerEvents, threadId, reader, room, signal, mode } = input;
    const encoder = new TextEncoder();
    const follow = mode.kind === 'follow';
    let finished = false;
    let subscription: Subscription | undefined;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const write = (text: string) => {
        if (finished) {
            return;
        }
        try {
            controller.enqueue(encoder.encode(text));
        } catch {
            end();
            return;
        }
        arm();
    };
    const arm = () => {
        clearTimeout(timer);
        if (finished) {
            return;
        }
        timer = setTimeout(() => write(': keep-alive\n\n'), input.keepAliveMs ?? STREAM_KEEP_ALIVE_MS);
        timer.unref?.();
    };
    const named = (name: string, data: unknown, id?: number) =>
        write(`event: ${name}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
    function end() {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', end);
        subscription?.unsubscribe();
        release?.();
        try {
            controller.close();
        } catch {
            // Already closed by the reader.
        }
    }
    const close = (reason?: RoomStreamCloseReason) => {
        if (finished) {
            return;
        }
        if (follow && reason) {
            named(ROOM_STREAM_CLOSED, { reason } satisfies RoomStreamClosed);
        }
        end();
    };
    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
            if (signal.aborted) {
                return end();
            }
            signal.addEventListener('abort', end, { once: true });
            // Every stream is held, a private chat's too: the server's stop ends
            // them all, and one its reader may no longer read ends within seconds.
            release = streams.open(threadId, reader, { close }, room);
            const filter = !room
                ? undefined
                : readerEvents.filter(reader, {
                      runActor: (runId) => runner.runActor(runId),
                      toolActors: () => runner.toolActors(threadId),
                  });
            const source: Observable<BaseEvent> = follow
                ? runner.watch(threadId, mode.after, (seq) =>
                      named(ROOM_STREAM_CURSOR, { seq } satisfies RoomStreamCursor, seq),
                  )
                : runner.connect({ threadId, headers: mode.headers });
            subscription = source.subscribe({
                next: (event) => {
                    if (!filter && event.type === EventType.RUN_STARTED && input.converted?.()) {
                        return end();
                    }
                    const seen = filter ? filter(event) : event;
                    if (seen) {
                        write(`data: ${JSON.stringify(seen)}\n\n`);
                    }
                },
                complete: end,
                error: end,
            });
            // The source may end before `subscribe` returns.
            if (finished) {
                subscription.unsubscribe();
            }
            arm();
        },
        cancel: end,
    });
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Through a buffering proxy (Nginx), frames as they come.
            'X-Accel-Buffering': 'no',
        },
    });
}
