import { Context } from 'effect';
import { expect, it, onTestFinished, vi } from 'vitest';

import { AppTurns } from '../src/server/composition/app/turns.js';
import { RequestSenders } from '../src/server/composition/dots.js';
import { Ports } from '../src/server/composition/ports.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// The turns edge (`AppTurns`) holds the chat's runtime requests and a
// socio's turn; `Platform` delegates to it. The map `handle` records who
// sent each request in is the one `RequestSenders` reads, and the step
// fills `ports.turns` with the same service.

it('lets RequestSenders see the user handle recorded', async () => {
    const { edge, platform, workspace, dispose } = await makeTestRuntime();
    onTestFinished(dispose);
    const services = edge.services as Context.Context<never>;
    const turns = Context.getUnsafe(services, AppTurns);
    const senders = Context.getUnsafe(services, RequestSenders);
    const dot = workspace.dots()[0];
    workspace.bindThread('t', dot.id, 'T', 'owner');
    // What reaches the runtime, with no model behind it.
    const reached: Request[] = [];
    vi.spyOn(platform.handler, 'fetch').mockImplementation(async (request: Request) => {
        reached.push(request);
        return new Response('ran');
    });
    const before = Date.now();
    const request = () =>
        new Request(`http://localhost/api/copilotkit/agent/${dot.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: 't', runId: 'r', messages: [], tools: [] }),
        });
    // Through the facade and through the service: the same edge.
    expect(await (await platform.handle(request(), 'owner')).text()).toBe('ran');
    expect(await (await turns.handle(request(), 'owner')).text()).toBe('ran');
    expect(reached).toHaveLength(2);
    for (const sent of reached) {
        const sender = senders(sent);
        expect(sender?.userId).toBe('owner');
        expect(sender?.receivedAt).toBeGreaterThanOrEqual(before);
        expect(sender?.receivedAt).toBeLessThanOrEqual(Date.now());
    }
    // A request `handle` never saw has no sender.
    expect(senders(request())).toBeUndefined();
});

it('fills ports.turns with the step’s one AppTurns', async () => {
    const { edge, dispose } = await makeTestRuntime();
    onTestFinished(dispose);
    const services = edge.services as Context.Context<never>;
    expect(Context.getUnsafe(services, Ports).turns.get()).toBe(Context.getUnsafe(services, AppTurns));
});

it('refuses a turn while setup is incomplete, with the same message', async () => {
    const { edge, platform, workspace, dispose } = await makeTestRuntime({ config: { model: '' } });
    onTestFinished(dispose);
    const dot = workspace.dots()[0];
    workspace.bindThread('t', dot.id, 'T', 'owner');
    const missing = (await platform.setup()).missing;
    expect(missing.length).toBeGreaterThan(0);
    const message = `Setup required: ${missing.join(', ')}. Configure the model in the server environment.`;
    const turns = Context.getUnsafe(edge.services as Context.Context<never>, AppTurns);
    await expect(turns.requireReady()).rejects.toThrow(message);
    await expect(platform.turnOutcome('t', 'Hi', new AbortController().signal)).rejects.toThrow(message);
    await expect(platform.requireReady()).rejects.toThrow(message);
});
