import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

import type { AuthProvider } from '../src/server/auth/contract.js';
import { warmUp } from '../src/server/composition/lifecycle/warm.js';

// The boot's warm-up (composition/lifecycle/warm.ts): before the server
// listens, sign-in's modules load and one signed-out page renders in
// process, so the first real requests don't pay for either on the main
// thread while /healthz waits. It never stops the boot.

const provider = (warm?: AuthProvider['warm']) => ({ provider: { warm } as unknown as AuthProvider });

it('loads sign-in, then renders a page in process, and logs both times', async () => {
    const order: string[] = [];
    const app = new Hono();
    app.get('/', (c) => {
        order.push(`page ${c.req.header('accept')} ${new URL(c.req.url).host}`);
        return c.html('<p>signed out</p>');
    });
    const lines: string[] = [];
    let clock = 0;
    const times = await warmUp(
        app,
        provider(async () => {
            order.push('sign-in');
            clock += 600;
        }),
        {
            origin: 'http://127.0.0.1:4310',
            log: (line) => lines.push(line),
            now: () => (clock += 10),
        },
    );
    expect(order).toEqual(['sign-in', 'page text/html 127.0.0.1:4310']);
    expect(times).toEqual({ signIn: 610, page: 10 });
    expect(lines).toEqual(['Warm-up: sign-in loaded in 610 ms, a page rendered in 10 ms.']);
});

it('finishes before it resolves: the server listens only after both', async () => {
    let signedIn = false;
    let rendered = false;
    const app = new Hono();
    app.get('/', async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        rendered = true;
        return c.text('ok');
    });
    await warmUp(
        app,
        provider(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            signedIn = true;
        }),
        { log: () => {} },
    );
    expect({ signedIn, rendered }).toEqual({ signedIn: true, rendered: true });
});

it('goes on when sign-in or the page fails, and says so', async () => {
    const app = new Hono();
    app.get('/', () => {
        throw new Error('render failed');
    });
    const lines: string[] = [];
    await warmUp(
        app,
        provider(() => Promise.reject(new Error('no module'))),
        { log: (line) => lines.push(line), now: () => 0 },
    );
    expect(lines).toEqual([
        "Warm-up: sign-in didn't load (no module); the first request loads it.",
        'Warm-up: the page answered 500.',
        'Warm-up: sign-in loaded in 0 ms, a page rendered in 0 ms.',
    ]);
});

it('skips sign-in for a provider with nothing to load (mock auth)', async () => {
    const app = new Hono();
    const page = vi.fn((c) => c.text('ok'));
    app.get('/', page);
    const lines: string[] = [];
    await warmUp(app, provider(undefined), { log: (line) => lines.push(line), now: () => 0 });
    expect(page).toHaveBeenCalledTimes(1);
    expect(lines).toEqual(['Warm-up: sign-in loaded in 0 ms, a page rendered in 0 ms.']);
});
