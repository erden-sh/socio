// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { characterFor, LOCALS, LOCAL_NAMES } from '@socio/shared/mascot';
import type { Dot, State, WorkspaceState } from '@socio/shared/types';

import { Mascot } from '../src/locals/Mascot';
import { ChatHeader } from '../src/modules/chat/chat-chrome';
import { WorkspaceDialog } from '../src/modules/settings/WorkspaceDialog';

vi.mock('../src/modules/chat/ModelSelect', () => ({
    ModelSelect: () => null,
    useModelOptions: () => undefined,
}));
vi.mock('../src/modules/settings/WebIdentityField', () => ({
    WebIdentityField: () => null,
    useWebIdentity: () => ({ save: async () => {} }),
}));
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});
const dot = (id: string, character?: Dot['character']) =>
    ({
        id,
        spaceId: 's1',
        spaceIds: ['s1'],
        name: `Socio ${id}`,
        instructions: 'Keep it.',
        researchAllowed: false,
        memoryAllowed: false,
        createdAt: 0,
        ownerId: 'me',
        character,
    }) as Dot;
async function dialog(dots: Dot[], editing?: Dot) {
    const mutate = vi.fn(async (_path: string, _method: string, _body?: unknown) => true);
    await act(async () =>
        root.render(
            // A saved socio's dialog links to its Soul (CB-179).
            <MemoryRouter>
                <WorkspaceDialog
                    dialog={{ type: 'dot', spaceId: 's1', dot: editing }}
                    state={
                        {
                            settings: { researchAllowed: true, memoryAllowed: true },
                        } as State
                    }
                    workspace={
                        {
                            user: { id: 'me', name: 'Me', role: 'member' },
                            spaces: [{ id: 's1', name: 'Shared', description: '', createdAt: 0 }],
                            dots,
                            conversations: [],
                        } as unknown as WorkspaceState
                    }
                    onClose={() => {}}
                    mutate={mutate}
                />
            </MemoryRouter>,
        ),
    );
    return mutate;
}
const radios = () => [
    ...document.querySelectorAll<HTMLInputElement>('[data-slot="dot-character"] input[type="radio"]'),
];
const submit = async () =>
    act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

it('renders the chosen character, else the one the id hashes to', async () => {
    const id = 'legacy-socio';
    const other = LOCALS.find((local) => local !== characterFor(id))!;
    const local = () => document.querySelector('[data-local]')?.getAttribute('data-local');
    await act(async () => root.render(<Mascot identity={id} character={other} />));
    expect(local()).toBe(other);
    await act(async () => root.render(<Mascot identity={id} character={null} />));
    expect(local()).toBe(characterFor(id));
    // A value from a newer or older cast falls back rather than breaking.
    await act(async () => root.render(<Mascot identity={id} character="godzilla" />));
    expect(local()).toBe(characterFor(id));
    // The chat header passes it through.
    await act(async () =>
        root.render(
            <ChatHeader identity={id} mascotCharacter={other} mascotName="Legacy" title="Chat" status={null} />,
        ),
    );
    expect(local()).toBe(other);
});

it('offers every character as a labelled radio group and saves the choice on create', async () => {
    // Sebas and Manny are taken, so Mingo is suggested; duplicates stay allowed.
    const mutate = await dialog([dot('a', 'sebas'), dot('b', 'manny')]);
    const group = document.querySelector('[data-slot="dot-character"]')!;
    expect(group.tagName).toBe('FIELDSET');
    expect(group.querySelector('legend')?.textContent).toBe('Character');
    expect(radios().map((radio) => radio.value)).toEqual([...LOCALS]);
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
    expect(radios().map((radio) => radio.getAttribute('aria-label'))).toEqual(
        LOCALS.map((local) => `${LOCAL_NAMES[local].name}, the ${LOCAL_NAMES[local].kind}`),
    );
    // Each is inside its visible label, so the picture and name are its target.
    for (const radio of radios()) {
        expect(radio.closest('label')?.textContent).toContain(radio.getAttribute('aria-label')!.split(',')[0]);
    }
    expect(radios().find((radio) => radio.checked)?.value).toBe('mingo');
    // The pictures are decorative: the label names each choice.
    expect(group.querySelectorAll('[role="img"]')).toHaveLength(0);
    await act(async () => radios()[0]!.click());
    expect(radios()[0]!.checked).toBe(true);
    await submit();
    expect(mutate.mock.calls[0]).toMatchObject(['/dots', 'POST', { character: 'sebas' }]);
});

it('starts an existing socio on its current character and saves a change', async () => {
    const current = dot('existing-one');
    current.character = characterFor(current.id);
    const mutate = await dialog([current], current);
    expect(radios().find((radio) => radio.checked)?.value).toBe(current.character);
    const other = radios().find((radio) => radio.value !== current.character)!;
    await act(async () => other.click());
    await submit();
    expect(mutate.mock.calls[0]).toMatchObject([`/dots/${current.id}`, 'PUT', { character: other.value }]);
});

it('renders the four new Miami-native locals (CB-272) as static avatars', async () => {
    const newLocals = ['lino', 'flake', 'iggy', 'rosy'] as const;
    // Each is offered as a radio option with its name and kind.
    await dialog([dot('a', 'sebas')]);
    const labels = radios().map((radio) => radio.getAttribute('aria-label'));
    for (const local of newLocals) {
        const label = `${LOCAL_NAMES[local].name}, the ${LOCAL_NAMES[local].kind}`;
        expect(labels).toContain(label);
    }
    // Each renders its avatar under the right data-local, using only a root
    // rig (no animated parts) without error.
    for (const local of newLocals) {
        await act(async () => root.render(<Mascot identity={`x-${local}`} character={local} />));
        const avatar = document.querySelector('[data-local]')!;
        expect(avatar.getAttribute('data-local')).toBe(local);
        // The cleaned art ships a single root group and no background tile.
        const svgEl = document.querySelector('[data-local] svg')!;
        expect(svgEl.getAttribute('viewBox')).toBe('0 0 512 512');
        expect(svgEl.hasAttribute('width')).toBe(false);
        expect(svgEl.hasAttribute('height')).toBe(false);
        expect(svgEl.querySelectorAll('[data-rig="root"]')).toHaveLength(1);
        // No canvas-covering background rect: the app supplies the surface.
        const bgRect = svgEl.querySelector('rect[width="512"][height="512"]');
        expect(bgRect).toBeNull();
    }
});
