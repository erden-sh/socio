// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { Rig, run, type CharacterRig } from '../src/locals/rig';
import { RigAvatar } from '../src/locals/RigAvatar';

const definition: CharacterRig = {
    id: 'sebas',
    name: 'Sebas',
    svg: '<svg viewBox="0 0 512 512"><g data-rig="root" /></svg>',
    parts: { root: { pivot: [256, 256] } },
    motion: ({ t }) => ({ root: { r: t } }),
};
afterEach(() => vi.unstubAllGlobals());
it('bounds actual SVG writes on a 120 Hz display while keeping the pose moving', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (next: FrameRequestCallback) => {
        frame = next;
        return 1;
    });
    const host = document.createElement('div');
    host.innerHTML = definition.svg;
    const part = host.querySelector('g')!;
    const writes = vi.spyOn(part, 'setAttribute');
    const rig = new Rig(definition, host.querySelector('svg')!, 1);
    const stop = run(rig);
    for (let i = 1; i <= 120; i++) {
        frame!((i * 1000) / 120);
    }
    expect(writes.mock.calls.length).toBeLessThanOrEqual(32);
    expect(writes.mock.calls.length).toBeGreaterThanOrEqual(28);
    expect(part.getAttribute('transform')).not.toBe('matrix(1 0 0 1 0 0)');
    stop();
    frame!(1010);
});
it('renders a still character without scheduling an animation loop', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const frames = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frames);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
        await act(async () =>
            root.render(<RigAvatar character="sebas" state="idle" definition={{ ...definition, static: true }} />),
        );
        expect(host.querySelector('svg')).not.toBeNull();
        expect(frames).not.toHaveBeenCalled();
    } finally {
        await act(async () => root.unmount());
    }
});
