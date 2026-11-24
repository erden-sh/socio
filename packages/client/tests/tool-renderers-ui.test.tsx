import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import { Chat } from '../src/modules/chat/Chat';
import { ModulesProvider } from '../src/modules/context';
import { toolRenderers } from '../src/modules/derive';
import { clientModules } from '../src/modules/registry';
import type { ClientModule } from '../src/modules/types';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out.
Element.prototype.scrollIntoView = () => {};

/**
 * Tool renderers contributed by client modules (WORKSPACE-SHELL step 9):
 * the chat shows page reviews and the computer's screen without naming the
 * modules they come from. CopilotKit is a stand-in whose tool-calls view
 * draws each call through the renderer a module registered for its name.
 */
const kit = vi.hoisted(() => {
    const agent = {
        messages: [] as Message[],
        subscribe: () => ({ unsubscribe() {} }),
    };
    return {
        agent,
        copilotkit: {
            subscribe: () => ({ unsubscribe() {} }),
            connectAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            runAgent: async (_: { agent: unknown }): Promise<unknown> => undefined,
            stopAgent: () => {},
        },
        human: new Map<string, (props: unknown) => unknown>(),
    };
});
vi.mock('@copilotkit/react-core/v2', async () => {
    return {
        useAgent: () => ({ agent: kit.agent, isReady: true }),
        useCopilotKit: () => ({ copilotkit: kit.copilotkit }),
        useRenderTool: () => {},
        useHumanInTheLoop: (tool: { name: string; render: (props: unknown) => unknown }) => {
            kit.human.set(tool.name, tool.render);
        },
        CopilotChatToolCallsView: ({
            message,
        }: {
            message: {
                toolCalls?: Array<{
                    id: string;
                    function: { name: string; arguments: string };
                }>;
            };
        }) =>
            (message.toolCalls ?? []).map((call) => (
                <div key={call.id}>
                    {
                        kit.human.get(call.function.name)?.({
                            name: call.function.name,
                            toolCallId: call.id,
                            args: JSON.parse(call.function.arguments),
                            status: 'executing',
                            respond: async () => {},
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
    name: 'Dot',
    instructions: 'Dot helps.',
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
const call = (id: string, name: string, args: unknown) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
});

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    kit.human.clear();
    vi.stubGlobal('fetch', async (input: string) => {
        const path = new URL(input, 'http://app.test').pathname;
        if (path === '/api/me/inference/options') {
            return new Response(JSON.stringify({ options: [], automatic: null }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response('null', {
            headers: { 'Content-Type': 'application/json' },
        });
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

const show = async (messages: Message[], modules: readonly ClientModule[] = clientModules) => {
    kit.agent.messages = messages;
    await act(async () =>
        root.render(
            <ModulesProvider modules={modules}>
                <Chat
                    thread={thread}
                    dot={dot}
                    onConsumed={() => {}}
                    voiceReady={false}
                    calls={[]}
                    paused={false}
                    onSaved={() => {}}
                    onSchedule={() => {}}
                    onComputer={() => {}}
                />
            </ModulesProvider>,
        ),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
};
const trace = () => host.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]');
const open = (details: HTMLDetailsElement) =>
    act(() => {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
    });

it('registers the page review with the chat, and shows its call as a card', async () => {
    await show([
        { id: 'u1', role: 'user', content: 'Draft a launch brief.' },
        {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [
                call('t1', 'review_space_page', {
                    title: 'Launch brief',
                    content: '# Goals',
                    spaceId: 's1',
                }),
            ],
        },
    ]);
    expect([...kit.human.keys()]).toEqual(['review_space_page']);
    const review = host.querySelector('section[aria-label="Review page draft"]');
    expect(review?.textContent).toContain('Launch brief');
    // A card, not a step of the turn's trace.
    expect(trace()).toBeNull();
});

it('shows the computer under the steps of the turn that used its browser', async () => {
    await show([
        { id: 'u1', role: 'user', content: 'Open the site.' },
        {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [call('t1', 'computer_navigate', { url: 'https://a.test' })],
        },
        { id: 'r1', role: 'tool', toolCallId: 't1', content: '{"ok":true}' },
        { id: 'a2', role: 'assistant', content: 'Opened.' },
        { id: 'u2', role: 'user', content: 'Now list the files.' },
        {
            id: 'a3',
            role: 'assistant',
            content: '',
            toolCalls: [call('t2', 'computer_files_list', {})],
        },
        { id: 'r2', role: 'tool', toolCallId: 't2', content: '[]' },
        { id: 'a4', role: 'assistant', content: 'Nothing there.' },
    ]);
    const traces = [...host.querySelectorAll<HTMLDetailsElement>('[data-slot="turn-trace"]')];
    expect(traces).toHaveLength(2);
    for (const details of traces) {
        await open(details);
    }
    // The browser turn has the screen; the file-only turn does not.
    expect(traces[0].textContent).toContain('Current browser view');
    expect(traces[1].textContent).not.toContain('Current browser view');
    expect(host.querySelectorAll('[aria-label="Expand Dot computer"]')).toHaveLength(1);
});

it('draws nothing for tools no module renders, and needs no module by name', async () => {
    const bare = clientModules.filter((module) => !module.toolRenderers);
    await show(
        [
            { id: 'u1', role: 'user', content: 'Draft a launch brief.' },
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                toolCalls: [call('t1', 'review_space_page', { title: 'T', content: 'C' })],
            },
        ],
        bare,
    );
    expect(kit.human.size).toBe(0);
    expect(host.querySelector('section[aria-label="Review page draft"]')).toBeNull();
});

it('collects renderers from the modules that declare them', () => {
    expect(toolRenderers(clientModules).map((renderer) => renderer.moduleId)).toEqual(['spaces', 'dots']);
});
