import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { approvalNoteMessagePrefix, type ApprovalView } from '@socio/shared/approvals';
import type { Conversation, Dot } from '@socio/shared/types';

import { useDecidedLine } from '../src/modules/approvals/ApprovalCard';
import { Chat } from '../src/modules/chat/Chat';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * A stand-in for CopilotKit: an agent whose messages the test sets, a core
 * whose connect and run are spies, and a tool-calls view that renders each
 * call through the chat's `*` renderer with its tool result.
 */
const kit = vi.hoisted(() => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    const agent = {
        messages: [] as Message[],
        setMessages(next: Message[]) {
            agent.messages = next;
            listeners.forEach((fn) => fn());
        },
        addMessage(message: Message) {
            agent.setMessages([...agent.messages, message]);
        },
        subscribe: () => ({ unsubscribe() {} }),
        listen(fn: Listener) {
            listeners.add(fn);
            return () => void listeners.delete(fn);
        },
    };
    return {
        agent,
        copilotkit: {
            subscribe: () => ({ unsubscribe() {} }),
            connectAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            runAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            stopAgent: () => {},
        },
        render: undefined as undefined | ((props: unknown) => unknown),
    };
});
vi.mock('@copilotkit/react-core/v2', async () => {
    const React = await import('react');
    return {
        useAgent: () => {
            const [, force] = React.useReducer((n: number) => n + 1, 0);
            React.useEffect(() => kit.agent.listen(force), []);
            return { agent: kit.agent, isReady: true };
        },
        useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
        useRenderTool: (tool: { name?: string; render: (props: unknown) => unknown }) => {
            // Only the chat's wildcard renderer (approval cards), not named ones.
            if (tool.name !== '*') {
                return;
            }
            kit.render = tool.render;
        },
        useHumanInTheLoop: () => {},
        CopilotChatToolCallsView: ({
            message,
            messages,
        }: {
            message: {
                toolCalls?: Array<{ id: string; function: { name: string } }>;
            };
            messages: Message[];
        }) =>
            (message.toolCalls ?? []).map((call) => (
                <div key={call.id}>
                    {
                        kit.render?.({
                            name: call.function.name,
                            toolCallId: call.id,
                            args: {},
                            status: 'complete',
                            result: messages.find(
                                (entry) =>
                                    entry.role === 'tool' && (entry as { toolCallId?: string }).toolCallId === call.id,
                            )?.content,
                        }) as ReactNode
                    }
                </div>
            )),
    };
});

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Socio',
    instructions: 'Socio helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const thread: Conversation = {
    id: 'c1',
    dotId: 'd1',
    ownerId: 'bob',
    title: 'Chat',
    createdAt: 1,
};
const pending = (id: string) => ({
    status: 'pending_approval',
    approval: { id, summary: 'Save job', url: `/approvals/${id}` },
    message: 'Waiting.',
});
const history = (): Message[] => [
    { id: 'u1', role: 'user', content: 'Save my job and schedule it.' },
    {
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [
            {
                id: 't1',
                type: 'function',
                function: { name: 'job_save', arguments: '{}' },
            },
            {
                id: 't2',
                type: 'function',
                function: { name: 'schedule_create', arguments: '{}' },
            },
        ],
    },
    {
        id: 'r1',
        role: 'tool',
        toolCallId: 't1',
        content: JSON.stringify(pending('ap1')),
    },
    {
        id: 'r2',
        role: 'tool',
        toolCallId: 't2',
        content: JSON.stringify(pending('ap2')),
    },
    { id: 'a2', role: 'assistant', content: 'Approve them and I will carry on.' },
];
const NOTE = '[Approval decided. The user approved "Save job".]';
const carriedOn = (): Message[] => [
    ...history(),
    {
        id: `${approvalNoteMessagePrefix}n1`,
        role: 'user',
        content: NOTE,
        metadata: { socioSource: 'approval_decided' },
    } as Message,
    { id: 'a3', role: 'assistant', content: 'Saved and scheduled: all done.' },
];
const view = (id: string, extra: Partial<ApprovalView> = {}): ApprovalView => ({
    id,
    dotId: 'd1',
    dotName: 'Socio',
    capability: 'job.save',
    capabilityLabel: 'Save jobs',
    summary: id === 'ap1' ? 'Save job “Prices”' : 'Schedule “Prices”',
    details: [],
    status: 'pending',
    decidedVia: null,
    createdAt: 1,
    expiresAt: Date.now() + 86_400_000,
    auto: null,
    continuation: null,
    ...extra,
});

let views: Record<string, ApprovalView>;
let decisions: string[];
let root: Root;
let host: HTMLElement;
beforeEach(() => {
    views = { ap1: view('ap1'), ap2: view('ap2') };
    decisions = [];
    kit.agent.messages = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
                headers: { 'Content-Type': 'application/json' },
            });
        if (path.endsWith('/page-context')) {
            return json(null);
        }
        if (path === '/api/me/inference/options') {
            return json({ options: [], automatic: null });
        }
        const decision = path.match(/^\/api\/approvals\/(\w+)\/decision$/);
        if (decision && init?.method === 'POST') {
            const id = decision[1];
            decisions.push(id);
            const approve = JSON.parse(String(init.body)).decision === 'approve';
            // The first of the turn's two waits; the last starts the Dot's turn,
            // which both cards then report.
            const last = decisions.length === 2;
            const status = approve ? 'approved' : 'denied';
            for (const key of last ? ['ap1', 'ap2'] : [id]) {
                views[key] = view(key, {
                    status: key === id ? status : views[key].status,
                    decidedVia: 'user',
                    outcome: key === 'ap1' ? 'Saved job “Prices” version 1.' : null,
                    continuation: last
                        ? { status: 'running', id: 'n1', detail: null, waitingFor: 0 }
                        : { status: 'waiting', id: null, detail: null, waitingFor: 1 },
                });
            }
            return json(views[id]);
        }
        const one = path.match(/^\/api\/approvals\/(\w+)$/);
        if (one) {
            return json(views[one[1]]);
        }
        return new Response(JSON.stringify({ error: 'Not here' }), { status: 404 });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const text = () => host.textContent ?? '';
const card = (summary: string) =>
    [...host.querySelectorAll<HTMLElement>('[data-slot="approval-card"]')].find((item) =>
        item.textContent?.includes(summary),
    )!;
const click = (within: HTMLElement, name: string) =>
    act(() => {
        [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)!.click();
    });

it('words each state of carrying on after a decision', () => {
    let decidedLine!: ReturnType<typeof useDecidedLine>;
    function Probe() {
        decidedLine = useDecidedLine();
        return null;
    }
    const probe = createRoot(document.createElement('div'));
    act(() => probe.render(<Probe />));
    const decided = (extra: Partial<ApprovalView>) =>
        decidedLine(view('ap1', { status: 'approved', decidedVia: 'user', ...extra }));
    expect(decided({})).toBe('Approved.');
    expect(
        decided({
            continuation: {
                status: 'waiting',
                id: null,
                detail: null,
                waitingFor: 2,
            },
        }),
    ).toBe('Approved. The socio carries on once you decide the other 2 requests from this turn.');
    expect(
        decided({
            status: 'denied',
            continuation: {
                status: 'waiting',
                id: null,
                detail: null,
                waitingFor: 0,
            },
        }),
    ).toBe('Denied. The socio is carrying on…');
    expect(
        decided({
            continuation: { status: 'running', id: 'n', detail: null, waitingFor: 0 },
        }),
    ).toBe('Approved. The socio is carrying on…');
    expect(
        decided({
            continuation: { status: 'done', id: 'n', detail: null, waitingFor: 0 },
        }),
    ).toBe('Approved. The socio carried on in the conversation.');
    expect(
        decided({
            continuation: {
                status: 'skipped',
                id: null,
                detail: 'Socio is paused, so the socio did not carry on.',
                waitingFor: 0,
            },
        }),
    ).toBe('Approved. Socio is paused, so the socio did not carry on.');
    expect(decided({ decidedVia: 'auto' })).toBe('Decided by auto review in your place.');
    expect(decided({ status: 'expired', decidedVia: 'expiry' })).toBe('Expired without a decision.');
    for (const line of [decided({}), decided({ status: 'denied' })]) {
        expect(line).not.toMatch(/Tell the socio/);
    }
    act(() => probe.unmount());
});

it('carries on in the open chat after the last decision: one turn, followed live, its note hidden', async () => {
    const connect = vi
        .spyOn(kit.copilotkit, 'connectAgent')
        // Opening the chat loads its history; following the Dot's turn replays
        // it, then the turn.
        .mockImplementationOnce(async () => kit.agent.setMessages(history()))
        .mockImplementation(async () => {
            kit.agent.setMessages(history().slice(0, 2));
            await new Promise((resolve) => setTimeout(resolve, 30));
            kit.agent.setMessages(carriedOn());
        });
    const run = vi.spyOn(kit.copilotkit, 'runAgent');
    act(() =>
        root.render(
            <Chat
                thread={thread}
                dot={dot}
                onConsumed={() => {}}
                voiceReady={false}
                calls={[]}
                paused={false}
                onSaved={() => {}}
                onSchedule={() => {}}
            />,
        ),
    );
    await until(() => text().includes('Schedule “Prices”'), 'the two cards');
    expect(connect).toHaveBeenCalledTimes(1);

    // The first decision waits for the other.
    click(card('Save job “Prices”'), 'Approve');
    await until(() => text().includes('The socio carries on once you decide the other request'), 'the waiting line');
    expect(connect).toHaveBeenCalledTimes(1);

    // The last one: the server runs the turn, the chat follows it once.
    click(card('Schedule “Prices”'), 'Deny');
    await until(() => text().includes('Saved and scheduled: all done.'), 'the reply');
    expect(text()).toContain('Denied. The socio is carrying on…');
    // Both cards report the turn; it is followed once, and nothing is sent.
    await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    expect(decisions).toEqual(['ap1', 'ap2']);
    // The note is the Dot's, never a bubble of the user's.
    expect(text()).not.toContain(NOTE);
    expect(host.querySelectorAll('[data-chat-body="user"]')).toHaveLength(1);
});
