// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';

import type { State } from '@socio/shared/types';
import type { TranscriptionView } from '@socio/shared/voice/transcription';

import { TranscriptionSetting } from '../src/modules/voice/DictationSettings';

// Settings → General → Transcription (CB-101): admins edit the server and
// model; members read them. Which key is sent shows, never the key. It
// saves as it changes (CB-308): fields when they lose focus, a key on Enter
// or blur.

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    vi.mocked(toast.success).mockReset();
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
});

async function render(transcription: TranscriptionView, { readOnly = false, available = true } = {}) {
    const mutate = vi.fn(async () => true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const state = { settings: { transcription } } as unknown as State;
    await act(async () =>
        root!.render(<TranscriptionSetting state={state} available={available} readOnly={readOnly} mutate={mutate} />),
    );
    return { mutate, form: host.querySelector('[data-slot="transcription"]')! };
}
const input = (id: string) => host!.querySelector<HTMLInputElement>(`#${id}`)!;
async function type(id: string, text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(id), text);
        input(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
}
// React listens for focusout to run onBlur.
const leave = (id: string) =>
    act(async () => {
        input(id).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
    });
const enter = (id: string) =>
    act(async () => {
        input(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
    });
/** The text and options of the toast shown last. */
const lastToast = () => vi.mocked(toast.success).mock.lastCall!;

const openai: TranscriptionView = {
    url: 'https://api.openai.com',
    model: 'gpt-4o-mini-transcribe',
    source: 'env',
    key: 'voice',
};

it('is read-only for members, and says which key is sent', async () => {
    const { form } = await render(openai, { readOnly: true });
    expect(input('transcription-url').value).toBe('https://api.openai.com');
    expect(input('transcription-url').disabled).toBe(true);
    expect(input('transcription-model').disabled).toBe(true);
    expect(form.textContent).toContain('VOICE_API_KEY');
    expect(form.textContent).toContain('Only an admin can change this.');
    expect(form.querySelector('button')).toBeNull();
});

it('saves a lab server for an admin as each field is left, and refuses a URL that is not http(s)', async () => {
    const { form, mutate } = await render(openai);
    // No Save button: the fields save themselves.
    expect([...form.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save');
    // Leaving it unchanged saves nothing.
    await leave('transcription-url');
    expect(mutate).not.toHaveBeenCalled();
    await type('transcription-url', 'ftp://stt.lab');
    await leave('transcription-url');
    expect(mutate).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')?.textContent).toMatch(/http/);

    await type('transcription-url', 'http://10.20.0.5:8000/v1');
    await leave('transcription-url');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        transcription: {
            url: 'http://10.20.0.5:8000',
            model: 'gpt-4o-mini-transcribe',
        },
    });
    expect(form.querySelector('[role="alert"]')).toBeNull();
    expect(form.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
    // The field shows the URL as saved.
    expect(input('transcription-url').value).toBe('http://10.20.0.5:8000');
    // No key was saved here, so none was cleared: Undo is offered.
    expect(lastToast()[0]).toBe('Transcription URL saved');
    expect(lastToast()[1]).toMatchObject({ action: { label: 'Undo' } });

    await type('transcription-model', ' whisper-1 ');
    await leave('transcription-model');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        transcription: { url: 'http://10.20.0.5:8000', model: 'whisper-1' },
    });
    expect(lastToast()[0]).toBe('Transcription model saved');
});

it('saves a new URL over a saved key without Undo, and says the key was cleared', async () => {
    const { mutate } = await render(keyed);
    // The same URL, typed differently, is not a change: the key stays.
    await type('transcription-url', 'https://voice.example.test/');
    await leave('transcription-url');
    expect(mutate).not.toHaveBeenCalled();
    await type('transcription-url', 'https://other.example');
    await leave('transcription-url');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        transcription: { url: 'https://other.example', model: 'whisper-1' },
    });
    expect(lastToast()).toEqual([
        'Transcription URL saved. The saved key was cleared; add the key for the new server.',
        undefined,
    ]);
});

it('puts the saved URL back and says why when the save fails', async () => {
    const { form, mutate } = await render(openai);
    mutate.mockResolvedValue(false);
    await type('transcription-url', 'https://stt.example');
    await leave('transcription-url');
    expect(mutate).toHaveBeenCalledOnce();
    expect(input('transcription-url').value).toBe('https://api.openai.com');
    expect(form.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not save. Review the workspace error and retry.',
    );
    expect(toast.success).not.toHaveBeenCalled();
});

it("goes back to the server's default", async () => {
    const { form, mutate } = await render({
        url: 'http://10.20.0.5:8000',
        model: 'whisper-1',
        source: 'settings',
        key: 'none',
    });
    expect(form.textContent).toContain('Sends no key.');
    const reset = [...form.querySelectorAll('button')].find((b) => b.textContent?.includes('default'))!;
    await act(async () => reset.click());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        transcription: null,
    });
});

it('says when server dictation is not available', async () => {
    const { form } = await render({ ...openai, key: 'none' }, { available: false });
    expect(form.textContent).toMatch(/Not available/);
});

it("says no key is sent to an admin's server at another origin", async () => {
    const { form } = await render({
        url: 'http://192.168.1.50:8000',
        model: 'whisper-1',
        source: 'settings',
        key: 'withheld',
        keyHost: '10.20.0.5:8000',
    });
    expect(form.textContent).toContain('No key is sent to this server (the key is set for 10.20.0.5:8000).');
});

// CB-204: the key an admin sets for the server is write-only.
const keyed: TranscriptionView = {
    url: 'https://voice.example.test',
    model: 'whisper-1',
    source: 'settings',
    key: 'settings',
    keySaved: true,
};
const button = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === label)!;

it('shows only whether a key is set, and replaces or clears it', async () => {
    const { form, mutate } = await render(keyed);
    const secret = form.querySelector('[data-slot="transcription-secret"]')!;
    expect(form.textContent).toContain('Sends the key set here.');
    expect(secret.textContent).toContain('A key is set here.');
    expect(secret.textContent).toContain('A new URL clears it.');
    // No field holds a key until Replace is chosen.
    expect(host!.querySelector('#transcription-secret')).toBeNull();
    await act(async () => button('Replace key').click());
    const field = input('transcription-secret');
    expect(field.type).toBe('password');
    expect(field.value).toBe('');
    // Not offered to password managers.
    expect(field.autocomplete).toBe('off');
    for (const name of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) {
        expect(field.hasAttribute(name)).toBe(true);
    }
    // No Save key button: leaving the field saves what was typed.
    expect(button('Save key')).toBeUndefined();
    await type('transcription-secret', 'new-key-123');
    await leave('transcription-secret');
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        transcriptionKey: {
            key: 'new-key-123',
            url: 'https://voice.example.test',
        },
    });
    // Saved: the field goes away, and the key with it. The toast confirms
    // without the key, and offers no Undo.
    expect(host!.querySelector('#transcription-secret')).toBeNull();
    expect(host!.innerHTML).not.toContain('new-key-123');
    expect(lastToast()).toEqual(['Key saved']);
    expect(form.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
    // Opened and left empty: nothing is saved, and the field goes away.
    await act(async () => button('Replace key').click());
    await leave('transcription-secret');
    expect(mutate).toHaveBeenCalledOnce();
    expect(host!.querySelector('#transcription-secret')).toBeNull();
    // Esc drops what was typed.
    await act(async () => button('Replace key').click());
    await type('transcription-secret', 'never-sent');
    await act(async () => {
        input('transcription-secret').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host!.querySelector('#transcription-secret')).toBeNull();
    expect(mutate).toHaveBeenCalledOnce();
    await act(async () => button('Clear key').click());
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        transcriptionKey: null,
    });
});

it('saves a key for the saved URL only, and says a new URL clears it', async () => {
    const { form, mutate } = await render(keyed);
    await type('transcription-url', 'https://other.example');
    expect(form.textContent).toContain('Saving this URL clears the key.');
    await act(async () => button('Replace key').click());
    await type('transcription-secret', 'new-key-123');
    expect(form.textContent).toContain('Fix the URL first');
    // Neither leaving the key field nor Enter gets round it.
    await leave('transcription-secret');
    expect(mutate).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('Fix the URL first');
    await enter('transcription-secret');
    expect(mutate).not.toHaveBeenCalled();
    // Half typed or empty counts as edited too, but saving it wouldn't
    // clear the key, so that isn't said.
    for (const half of ['https://', '']) {
        await (async () => {
            await type('transcription-url', half);
            expect(form.textContent).not.toContain('the key is cleared');
            expect(form.textContent).toContain('Fix the URL first');
        })();
    }
    await type('transcription-url', 'voice.example');
    expect(form.textContent).not.toContain('the key is cleared');
    await act(async () => {
        input('transcription-secret').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutate).not.toHaveBeenCalled();
});

it('saves a key with Enter when the URL is the saved one', async () => {
    const { mutate } = await render(keyed);
    await act(async () => button('Replace key').click());
    await type('transcription-secret', 'new-key-123');
    await act(async () => {
        input('transcription-secret').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
    });
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        transcriptionKey: {
            key: 'new-key-123',
            url: 'https://voice.example.test',
        },
    });
});

it('sets a first key, and refuses one with spaces', async () => {
    const { form, mutate } = await render({
        ...keyed,
        key: 'none',
        keySaved: undefined,
    });
    expect(form.textContent).toContain('No key is set here.');
    expect(button('Clear key')).toBeUndefined();
    await act(async () => button('Set a key').click());
    await type('transcription-secret', 'two words');
    await enter('transcription-secret');
    expect(mutate).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')?.textContent).toMatch(/spaces/);
});

it('lets members see whether a key is set, not change it', async () => {
    const { form } = await render(keyed, { readOnly: true });
    expect(form.textContent).toContain('A key is set here.');
    expect(form.querySelector('button')).toBeNull();
});

it('says why nothing is sent over plain http, or with a key it cannot open', async () => {
    const insecure = await render({ ...keyed, url: 'http://10.20.0.5:8000', key: 'insecure' }, { available: false });
    expect(insecure.form.textContent).toContain('a key goes only over https');
    expect(insecure.form.textContent).not.toContain('Not available: OpenAI');
    act(() => root?.unmount());
    host?.remove();
    // The environment's URL: the fix is in the environment.
    const env = await render(
        {
            ...keyed,
            url: 'http://10.20.0.5:8000',
            source: 'env',
            key: 'insecure',
            keySaved: undefined,
        },
        { available: false },
    );
    expect(env.form.textContent).toContain('Set an https VOICE_TRANSCRIBE_URL, or unset VOICE_TRANSCRIBE_API_KEY.');
    act(() => root?.unmount());
    host?.remove();
    // A URL saved here, with the environment's key at its origin: both fixes.
    const mixed = await render(
        {
            ...keyed,
            url: 'http://10.20.0.5:8000/stt',
            key: 'insecure',
            insecureKey: 'transcribe',
            keySaved: undefined,
        },
        { available: false },
    );
    expect(mixed.form.textContent).toContain('Change the URL to https, or unset VOICE_TRANSCRIBE_API_KEY.');
    act(() => root?.unmount());
    host?.remove();
    const unreadable = await render({ ...keyed, key: 'unreadable' }, { available: false });
    expect(unreadable.form.textContent).toContain('can’t be opened');
});

it('saves live text at once, and says where it isn’t used (CB-222)', async () => {
    const { form, mutate } = await render({
        url: 'https://voice.example.test',
        model: 'parakeet-tdt-0.6b-v3',
        source: 'settings',
        key: 'settings',
        streaming: 'auto',
        realtime: true,
    });
    const select = host!.querySelector<HTMLSelectElement>('#transcription-streaming')!;
    // No admin's choice: the server's default, and what it is.
    expect(select.value).toBe('default');
    expect(select.options[0].textContent).toBe('The server’s default: automatic');
    expect(form.textContent).toContain('/v1/realtime');
    expect(form.textContent).not.toMatch(/Not with/);
    await act(async () => {
        select.value = 'off';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        transcriptionStreaming: 'off',
    });
    await act(async () => {
        select.value = 'default';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        transcriptionStreaming: null,
    });
    act(() => root!.unmount());
    host!.remove();

    const openaiForm = (await render({ ...openai, streaming: 'auto', realtime: false })).form;
    expect(openaiForm.textContent).toContain('Not with OpenAI’s URL: it records, then sends.');
    act(() => root!.unmount());
    host!.remove();

    const lab = await render(
        {
            url: 'http://10.20.0.5:8000',
            model: 'whisper-1',
            source: 'settings',
            key: 'none',
            streaming: 'on',
            realtime: false,
        },
        { readOnly: true },
    );
    expect(lab.form.textContent).toMatch(/only over https/);
    expect(host!.querySelector<HTMLSelectElement>('#transcription-streaming')!.disabled).toBe(true);
});
