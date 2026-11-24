import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { useFollowRun } from '../src/modules/chat/use-follow-run';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('puts the transcript back when following a run fails partway', async () => {
    const transcript: Message[] = [
        { id: 'u1', role: 'user', content: 'Keep a list' },
        { id: 'a1', role: 'assistant', content: 'Approve it and I will carry on.' },
    ];
    const agent = {
        messages: transcript,
        setMessages(messages: Message[]) {
            agent.messages = messages;
        },
    };
    // The replay delivers one message, then the connection drops.
    const copilotkit = {
        connectAgent: vi.fn(async () => {
            agent.setMessages([transcript[0]]);
            throw new Error('connection lost');
        }),
    };
    const onError = vi.fn();
    let follow!: ReturnType<typeof useFollowRun>;
    function Probe() {
        follow = useFollowRun({
            agent,
            copilotkit,
            running: false,
            setRunning: () => {},
            onDone: () => {},
            onError,
        });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => follow.onContinuation('c1'));
    expect(copilotkit.connectAgent).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(agent.messages).toEqual(transcript);
    expect(follow.messages).toEqual(transcript);
    act(() => root.unmount());
});
