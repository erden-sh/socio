import { CopilotKitProvider } from '@copilotkit/react-core/v2';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { copilotKitOptions } from '../src/modules/chat/copilotkit-options';

// CopilotKit's web inspector fetches a notification feed from
// cdn.copilotkit.ai and posts usage events to telemetry.copilotkit.ai, from
// the browser. The provider mounts it when NODE_ENV is "development", the
// page is on localhost and `enableInspector` is not false. jsdom's page is
// http://localhost:3000/, so only the option keeps it off here.
// tests/integration/telemetry.test.ts checks the wiring. SECURITY.md, "Vendor telemetry".

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const nodeEnv = process.env.NODE_ENV;
let host: HTMLDivElement;
let root: Root | undefined;
let requests: string[];
let errors: string[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    requests = [];
    errors = [];
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(Response.json({ version: '0.0.0', agents: {}, telemetryDisabled: true }));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
    });
    host = document.createElement('div');
    document.body.append(host);
});

afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    process.env.NODE_ENV = nodeEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Mounts a provider as App.tsx does, in the given build mode. */
async function mount(mode: string, options: object) {
    process.env.NODE_ENV = mode;
    root = createRoot(host);
    await act(async () =>
        root?.render(
            <CopilotKitProvider {...options}>
                <p>shell</p>
            </CopilotKitProvider>,
        ),
    );
    // The runtime info request is the provider's first effect; the
    // inspector's import starts in the same commit.
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

const inspectorMount = () => host.querySelector('span[style="display: contents;"]');
const inspectorErrors = () => errors.filter((line) => line.includes('CopilotKit inspector'));

// The canary: without the option, development on localhost loads the
// inspector, which here is the stub (vite.config.ts, vitest.shared.ts).
it('the probe sees the inspector load when the option is missing', async () => {
    await mount('development', { runtimeUrl: copilotKitOptions.runtimeUrl });
    await vi.waitFor(() => expect(inspectorErrors()).toHaveLength(1));
    expect(inspectorMount()).not.toBeNull();
    expect(inspectorErrors()[0]).toContain('The CopilotKit web inspector is not part of Socio.');
});

it.each(['development', 'production', 'test'])('keeps the inspector off in %s', async (mode) => {
    await mount(mode, copilotKitOptions);
    expect(inspectorMount()).toBeNull();
    expect(inspectorErrors()).toEqual([]);
    expect(document.querySelector('cpk-web-inspector')).toBeNull();
    // The provider talks only to the app's runtime.
    for (const url of requests) {
        expect(url).toMatch(/^\/api\/copilotkit(\/|$)/);
    }
});
