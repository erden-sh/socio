// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Branding } from '@socio/shared/branding';
import type { SetupStatus, State } from '@socio/shared/types';
import type { VoiceCallsView } from '@socio/shared/voice/voice-call';

import { BrandingSetting } from '../src/modules/settings/BrandingSetting';
import { VoiceCallsSetting } from '../src/modules/voice/VoiceCallSettings';

// The Workspace settings cards that kept a Save button after the first
// autosave pass (CB-308): Branding and Calls now save as they change too,
// in the style of settings-autosave-ui.test.tsx.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(toast.success).mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const field = <T extends HTMLElement = HTMLInputElement>(id: string) => host.querySelector<T>(`#${id}`)!;
const status = () => host.querySelector('[data-slot="save-status"]')!.textContent;
const alert = () => host.querySelector('[role="alert"]')?.textContent;
const type = (id: string, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(id), value);
        field(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
// React listens for focusout to run onBlur.
const leave = (id: string) =>
    act(async () => {
        field(id).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
/** The Undo of the toast shown last. */
const undo = () =>
    act(async () => {
        const options = vi.mocked(toast.success).mock.lastCall![1] as {
            action: { label: string; onClick: () => void };
        };
        expect(options.action.label).toBe('Undo');
        options.action.onClick();
    });
/**
 * Picks a file in a file field, and waits for it to be read: until every
 * FileReader the change started has finished (its `loadend`), however long
 * jsdom takes, then for what the field does with the result.
 */
const pick = (id: string, file: File) =>
    act(async () => {
        const reads: Array<Promise<unknown>> = [];
        const readAsDataURL = FileReader.prototype.readAsDataURL;
        const spy = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (
            this: FileReader,
            blob: Blob,
        ) {
            reads.push(new Promise((resolve) => this.addEventListener('loadend', resolve, { once: true })));
            readAsDataURL.call(this, blob);
        });
        Object.defineProperty(field(id), 'files', {
            value: [file],
            configurable: true,
        });
        try {
            field(id).dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
            spy.mockRestore();
        }
        await Promise.all(reads);
        // The field's handler resumes after the read, in microtasks: a task
        // boundary lets all of them run.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

const branding = (value: Branding | null, mutate: (...args: unknown[]) => Promise<boolean>) =>
    act(async () => root.render(<BrandingSetting branding={value} mutate={mutate} />));

it('saves the workspace name when its field is left, refuses an empty one, and undoes', async () => {
    const mutate = vi.fn(async () => true);
    await branding({ name: 'Acme', logo: '/acme.png' }, mutate);
    expect(buttons()).not.toContain('Save branding');
    await leave('branding-name');
    expect(mutate).not.toHaveBeenCalled();
    type('branding-name', '  ');
    await leave('branding-name');
    expect(mutate).not.toHaveBeenCalled();
    expect(alert()).toBe('Name the workspace: it shows in navigation and on sign-in.');
    type('branding-name', ' Acme Brain ');
    await leave('branding-name');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        branding: { name: 'Acme Brain', logo: '/acme.png' },
    });
    expect(alert()).toBeUndefined();
    expect(status()).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith('Workspace name saved', expect.anything());
    await undo();
    expect(field('branding-name').value).toBe('Acme');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        branding: { name: 'Acme', logo: '/acme.png' },
    });
});

it('uploads a logo as soon as it is picked, and Undo puts the last one back', async () => {
    const mutate = vi.fn(async () => true);
    await branding({ name: 'Acme', logo: '/acme.png' }, mutate);
    await pick('branding-logo', new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(alert()).toBe('Choose a PNG, JPEG or WebP image up to 256 KB.');
    await pick(
        'branding-logo',
        new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', {
            type: 'image/png',
        }),
    );
    expect(mutate).toHaveBeenCalledOnce();
    const saved = (mutate.mock.lastCall as unknown as [string, string, { branding: Branding }])[2].branding;
    expect(saved.name).toBe('Acme');
    expect(saved.logo).toMatch(/^data:image\/png;base64,/);
    expect(host.querySelector('img')!.getAttribute('src')).toBe(saved.logo);
    expect(status()).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith('Logo saved', expect.anything());
    await undo();
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        branding: { name: 'Acme', logo: '/acme.png' },
    });
    expect(host.querySelector('img')!.getAttribute('src')).toBe('/acme.png');
});

it('undoes a first change back to the deployment’s branding, and says why a save failed', async () => {
    const mutate = vi.fn(async () => true);
    await branding(null, mutate);
    type('branding-name', 'Acme');
    await leave('branding-name');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        branding: { name: 'Acme', logo: '/favicon.svg' },
    });
    await undo();
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        branding: null,
    });
    mutate.mockResolvedValue(false);
    type('branding-name', 'Acme Brain');
    await leave('branding-name');
    expect(field('branding-name').value).toBe('Socio');
    expect(alert()).toBe('Could not save. Review the workspace error and retry.');
});

const speech = (fields: Partial<VoiceCallsView['speech']> = {}): VoiceCallsView => ({
    backend: 'self-hosted',
    backendSource: 'env',
    speech: {
        url: '',
        model: 'kokoro',
        voice: 'auto',
        source: 'env',
        key: 'none',
        ...fields,
    },
});
const calls = (view: VoiceCallsView, mutate: (...args: unknown[]) => Promise<boolean>) =>
    act(async () =>
        root.render(
            <VoiceCallsSetting
                state={{ settings: { voiceCalls: view } } as unknown as State}
                setup={{ voice: true, voiceCloud: true } as SetupStatus}
                readOnly={false}
                mutate={mutate}
            />,
        ),
    );

it('saves the calls backend at once, and the speech server as its fields are left', async () => {
    const mutate = vi.fn(async () => true);
    await calls(speech(), mutate);
    const card = host.querySelector('[data-slot="voice-calls"]')!;
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save');
    const backend = field<HTMLSelectElement>('voice-backend');
    await act(async () => {
        backend.value = 'cloud';
        backend.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        voiceBackend: 'cloud',
        voiceSpeech: null,
    });
    expect(toast.success).toHaveBeenLastCalledWith('Calls saved', expect.anything());
    type('speech-url', 'ftp://voice.lan');
    await leave('speech-url');
    expect(mutate).toHaveBeenCalledOnce();
    expect(alert()).toMatch(/http or https/);
    type('speech-url', 'http://10.20.0.5:8880/v1');
    await leave('speech-url');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        voiceBackend: 'cloud',
        voiceSpeech: {
            url: 'http://10.20.0.5:8880',
            model: 'kokoro',
            voice: 'auto',
        },
    });
    expect(status()).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith('Speech server saved', expect.anything());
    // Undo of the first speech server change goes back to the server's.
    await undo();
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        voiceBackend: 'cloud',
        voiceSpeech: null,
    });
    expect(field('speech-url').value).toBe('');
});
