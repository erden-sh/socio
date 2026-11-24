import { CopilotKitProvider } from '@copilotkit/react-core/v2';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { TIME_ZONE_HEADER } from '@socio/shared/time-zone';

// CB-159: the web app sends the browser's time zone with every chat
// request, in a header, never in a message's text.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
});

/** The app's provider options, as a browser in `zone` loads them. */
async function optionsIn(zone: string) {
    vi.resetModules();
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
        this: Intl.DateTimeFormat,
    ) {
        return { ...resolved.call(this), timeZone: zone };
    });
    const { copilotKitOptions } = await import('../src/modules/chat/copilotkit-options');
    spy.mockRestore();
    return copilotKitOptions;
}

it('sends the browser’s time zone in a header with the chat runtime’s requests', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const options = await optionsIn('America/New_York');
    expect(options.headers).toEqual({ [TIME_ZONE_HEADER]: 'America/New_York' });
    const sent: Array<{ url: string; zone: string | null }> = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(
            new URL(input instanceof Request ? input.url : String(input), 'http://localhost'),
            input instanceof Request ? input : init,
        );
        sent.push({
            url: new URL(request.url).pathname,
            zone: request.headers.get(TIME_ZONE_HEADER),
        });
        return Promise.resolve(
            Response.json({
                version: '0.0.0',
                agents: {},
                telemetryDisabled: true,
            }),
        );
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
        root?.render(
            <CopilotKitProvider {...options}>
                <p>shell</p>
            </CopilotKitProvider>,
        ),
    );
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    for (const request of sent) {
        expect(request.url).toMatch(/^\/api\/copilotkit(\/|$)/);
        expect(request.zone).toBe('America/New_York');
    }
});

it('sends no header for a zone that isn’t a valid IANA name', async () => {
    expect((await optionsIn('+05:30')).headers).toEqual({});
});
