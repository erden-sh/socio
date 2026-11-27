import { createElement as h, type ReactNode, useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Update Socio over the workspace (CB-553), rendered: the gate closes over the
// screens and opens again without mounting them anew, so what a form holds in
// React state (New Space's name and description) is still there, and while it
// is up nothing underneath takes a touch, a screen reader's focus or Android's
// back. React Native's views are stood in for by host elements of the same
// names, with their props as given; BackHandler and Keyboard by fakes that
// record what the layer does.

const native = vi.hoisted(() => ({
    os: 'android' as 'android' | 'ios',
    back: [] as Array<() => boolean | null | undefined>,
    dismissed: 0,
}));

vi.mock('react-native', () => {
    const host =
        (name: string) =>
        (props: Record<string, unknown>): ReactNode =>
            h(name, props);
    return {
        View: host('View'),
        TextInput: host('TextInput'),
        Pressable: host('Pressable'),
        Platform: {
            get OS() {
                return native.os;
            },
        },
        StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: { position: 'absolute' } },
        Keyboard: {
            dismiss: () => {
                native.dismissed += 1;
            },
        },
        BackHandler: {
            addEventListener: (_event: string, listener: () => boolean | null | undefined) => {
                native.back.push(listener);
                return { remove: () => native.back.splice(native.back.indexOf(listener), 1) };
            },
        },
    };
});

vi.mock('react-native-screens', () => ({
    FullWindowOverlay: (props: { children: ReactNode }) => h('FullWindowOverlay', props),
}));

const { UpdateGateLayer } = await import('../../src/screens/update-gate-layer');
const { BackHandler } = await import('react-native');

/** Android's back as React Native dispatches it: the newest listener first, until one returns true. */
function pressBack(): boolean {
    for (const listener of [...native.back].reverse()) {
        if (listener() === true) {
            return true;
        }
    }
    return false;
}

let mounts = 0;
let unmounts = 0;
let stackBack = 0;
let tapped = 0;

/** New Space as far as the gate is concerned: its fields in React state, and a stack that takes back. */
function NewSpaceForm() {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    useEffect(() => {
        mounts += 1;
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            stackBack += 1;
            return true;
        });
        return () => {
            unmounts += 1;
            subscription.remove();
        };
    }, []);
    return h(
        'View',
        { testID: 'new-space' },
        h('TextInput', { testID: 'new-space-name', value: name, onChangeText: setName }),
        h('TextInput', { testID: 'new-space-description', value: description, onChangeText: setDescription }),
        h('Pressable', { testID: 'new-space-create', onPress: () => (tapped += 1) }),
    );
}

const gate = h('View', { testID: 'update-required-screen' });
const app = (closed: boolean) => h(UpdateGateLayer, { closed, gate, children: h(NewSpaceForm) });

async function render(closed: boolean): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
        renderer = create(app(closed));
    });
    return renderer!;
}

// Host elements only: a stand-in view is a component that renders a host element with the same props.
const hosts = (renderer: ReactTestRenderer, testID: string) =>
    renderer.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID);
const byId = (renderer: ReactTestRenderer, testID: string) => {
    const [only, ...more] = hosts(renderer, testID);
    if (only === undefined || more.length > 0) {
        throw new Error(`expected one ${testID}`);
    }
    return only;
};
const has = (renderer: ReactTestRenderer, testID: string) => hosts(renderer, testID).length > 0;

describe('Update Socio over the workspace (CB-553)', () => {
    let renderer: ReactTestRenderer | undefined;

    beforeEach(() => {
        native.os = 'android';
        native.back.length = 0;
        native.dismissed = 0;
        mounts = 0;
        unmounts = 0;
        stackBack = 0;
        tapped = 0;
    });

    afterEach(async () => {
        await act(async () => renderer?.unmount());
        renderer = undefined;
    });

    it('keeps what a form holds through a 426 and back, never mounting it again', async () => {
        renderer = await render(false);
        await act(async () => {
            byId(renderer!, 'new-space-name').props.onChangeText('Roadmap');
            byId(renderer!, 'new-space-description').props.onChangeText('What ships next');
        });

        await act(async () => renderer!.update(app(true)));
        expect(has(renderer, 'update-required-screen')).toBe(true);
        expect(byId(renderer, 'new-space-name').props.value).toBe('Roadmap');

        await act(async () => renderer!.update(app(false)));
        expect(has(renderer, 'update-required-screen')).toBe(false);
        expect(byId(renderer, 'new-space-name').props.value).toBe('Roadmap');
        expect(byId(renderer, 'new-space-description').props.value).toBe('What ships next');
        expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
    });

    it('lets no touch or screen reader reach the screens while it is up, and gives them back after', async () => {
        renderer = await render(false);
        const underneath = () => byId(renderer!, 'update-gate-underneath');
        expect(underneath().props.style).toContainEqual({ pointerEvents: 'auto' });
        expect(underneath().props.importantForAccessibility).toBe('auto');
        expect(underneath().props.accessibilityElementsHidden).toBe(false);

        await act(async () => renderer!.update(app(true)));
        expect(underneath().props.style).toContainEqual({ pointerEvents: 'none' });
        expect(underneath().props.importantForAccessibility).toBe('no-hide-descendants');
        expect(underneath().props.accessibilityElementsHidden).toBe(true);
        const cover = byId(renderer, 'update-gate-cover');
        expect(cover.props.accessibilityViewIsModal).toBe(true);
        expect(cover.findAll((node) => node.props.testID === 'update-required-screen').length).toBeGreaterThan(0);
        // The cover comes after the screens, so it is drawn over them and hit first.
        const layer = renderer.toJSON();
        expect(
            layer !== null &&
                !Array.isArray(layer) &&
                layer.children?.map((child) => typeof child === 'object' && child.props.testID),
        ).toEqual(['update-gate-underneath', 'update-gate-cover']);

        await act(async () => renderer!.update(app(false)));
        expect(underneath().props.style).toContainEqual({ pointerEvents: 'auto' });
        expect(underneath().props.importantForAccessibility).toBe('auto');
        expect(has(renderer, 'update-gate-cover')).toBe(false);
        byId(renderer, 'new-space-create').props.onPress();
        expect(tapped).toBe(1);
    });

    it("keeps Android's back from the hidden stack while it is up", async () => {
        renderer = await render(false);
        expect(pressBack()).toBe(true);
        expect(stackBack).toBe(1);

        await act(async () => renderer!.update(app(true)));
        expect(pressBack()).toBe(true);
        expect(pressBack()).toBe(true);
        expect(stackBack).toBe(1);

        await act(async () => renderer!.update(app(false)));
        expect(pressBack()).toBe(true);
        expect(stackBack).toBe(2);
        expect(native.back).toHaveLength(1);
    });

    it('takes the keyboard down as it closes, and only then', async () => {
        renderer = await render(false);
        expect(native.dismissed).toBe(0);
        await act(async () => renderer!.update(app(true)));
        expect(native.dismissed).toBe(1);
        await act(async () => renderer!.update(app(true)));
        expect(native.dismissed).toBe(1);
        await act(async () => renderer!.update(app(false)));
        expect(native.dismissed).toBe(1);
    });

    it('opens closed on a cold start, with the screens mounted under it', async () => {
        renderer = await render(true);
        expect(has(renderer, 'update-required-screen')).toBe(true);
        expect(mounts).toBe(1);
        expect(native.dismissed).toBe(1);
        await act(async () => renderer!.update(app(false)));
        expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
    });

    it('paints the whole screen itself, safe areas included, on both platforms', async () => {
        // The gate's Screen keeps its content inside the safe areas; the cover under it fills the
        // window with the screen color, so nothing of the workspace shows by the home indicator.
        for (const os of ['ios', 'android'] as const) {
            native.os = os;
            renderer = await render(true);
            const cover = byId(renderer, 'update-gate-cover');
            expect(cover.props.style).toEqual({ position: 'absolute' });
            expect(cover.props.className).toBe('bg-screen');
            await act(async () => renderer?.unmount());
            renderer = undefined;
        }
    });

    it('draws over native sheets and modals on iOS, in a full-window overlay', async () => {
        native.os = 'ios';
        renderer = await render(true);
        const overlay = renderer.root.findByType('FullWindowOverlay' as never);
        expect(
            overlay.findAll((node) => typeof node.type === 'string' && node.props.testID === 'update-gate-cover'),
        ).toHaveLength(1);
        native.os = 'android';
        await act(async () => renderer!.update(app(false)));
        await act(async () => renderer!.update(app(true)));
        expect(renderer.root.findAllByType('FullWindowOverlay' as never)).toHaveLength(0);
        expect(has(renderer, 'update-gate-cover')).toBe(true);
    });
});
