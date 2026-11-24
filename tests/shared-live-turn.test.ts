import { EventType, type BaseEvent } from '@ag-ui/core';
import { expect, it } from 'vitest';

import {
    applyRoomEvent,
    NO_LIVE_TURN,
    stillLive,
    type LiveTurn,
    type RoomMessage,
} from '@socio/shared/rooms/live-turn';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';
import { SENDER_METADATA, SENDER_NAME_METADATA, SOCIO_METADATA } from '@socio/shared/types';

// A room's running turn from its live stream (CB-212): people's
// messages, the reply as it is written, "thinking…", replayed without
// doubling, and what the transcript has stored since.

const play = (events: object[], me = 'mo', from: LiveTurn = NO_LIVE_TURN) =>
    events.reduce<LiveTurn>((turn, event) => applyRoomEvent(turn, event as BaseEvent, me), from);

const turn = [
    {
        type: AG_UI_EVENT.RUN_STARTED,
        runId: 'r1',
        timestamp: 10,
        input: {
            messages: [
                { id: 'old', role: 'assistant', content: 'earlier' },
                {
                    id: 'u1',
                    role: 'user',
                    content: 'Plan my week',
                    metadata: { [SENDER_METADATA]: 'ada', [SENDER_NAME_METADATA]: 'Ada' },
                },
            ],
        },
    },
    { type: AG_UI_EVENT.REASONING_START, messageId: 'th' },
];

it('follows the running turn from the stream: its people’s messages, thinking, then the reply as it is written', () => {
    const thinking = play(turn);
    expect(thinking).toMatchObject({ running: true, phase: 'thinking' });
    expect(thinking.messages).toEqual([
        {
            id: 'u1',
            role: 'user',
            content: 'Plan my week',
            author: { name: 'Ada', you: false, id: 'ada' },
            at: 10,
        },
    ]);
    const writing = play(
        [
            { type: AG_UI_EVENT.REASONING_END, messageId: 'th' },
            { type: AG_UI_EVENT.TOOL_CALL_START, toolCallId: 'c', toolCallName: 'x' },
            {
                type: AG_UI_EVENT.TEXT_MESSAGE_START,
                messageId: 't1',
                role: 'assistant',
                metadata: { [SOCIO_METADATA]: 'sebas' },
            },
            { type: AG_UI_EVENT.TEXT_MESSAGE_CONTENT, messageId: 't1', delta: 'Mon' },
            { type: AG_UI_EVENT.TEXT_MESSAGE_CONTENT, messageId: 't1', delta: 'day' },
        ],
        'mo',
        thinking,
    );
    expect(writing).toMatchObject({
        running: true,
        phase: 'writing',
        streamingId: 't1',
    });
    expect(writing.messages.at(-1)).toEqual({
        id: 't1',
        role: 'assistant',
        content: 'Monday',
        socioId: 'sebas',
    });
    // Replayed (a reconnect): each message once, the reply started over.
    const again = play(
        [
            ...turn,
            {
                type: AG_UI_EVENT.TEXT_MESSAGE_START,
                messageId: 't1',
                role: 'assistant',
            },
            { type: AG_UI_EVENT.TEXT_MESSAGE_CONTENT, messageId: 't1', delta: 'Mon' },
        ],
        'mo',
        writing,
    );
    expect(again.messages.map((message) => message.content)).toEqual(['Plan my week', 'Mon']);
    // The reader's own message says so.
    expect(play(turn, 'ada').messages[0]!.author?.you).toBe(true);
    // It ends: nothing runs; its messages stay until the transcript has them.
    const ended = play(
        [
            { type: AG_UI_EVENT.TEXT_MESSAGE_END, messageId: 't1' },
            { type: AG_UI_EVENT.RUN_ERROR, message: 'failed' },
        ],
        'mo',
        writing,
    );
    expect(ended).toMatchObject({ running: false, phase: undefined });
    expect(ended.streamingId).toBeUndefined();
    const stored: RoomMessage[] = [{ id: 'u1', role: 'user', content: 'Plan my week' }];
    expect(stillLive(ended, stored).messages.map((m) => m.id)).toEqual(['t1']);
    expect(stillLive(ended, [...stored, { ...stored[0]!, id: 't1' }])).toEqual({
        ...ended,
        messages: [],
    });
});

it('names every AG-UI event type as @ag-ui/core does', () => {
    expect(AG_UI_EVENT).toEqual({ ...EventType });
});
