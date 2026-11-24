import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { State } from '@socio/shared/types';
import {
    DICTATION_LABELS,
    DICTATION_METHODS,
    DICTATION_NOTES,
    availableDictation,
    type DictationAllowed,
    type DictationMethod,
} from '@socio/shared/voice/dictation';
import {
    DICTATION_LANGUAGES,
    DICTATION_LANGUAGE_OPTIONS,
    dictationLanguageHint,
    type DictationLanguage,
} from '@socio/shared/voice/dictation-languages';
import {
    DEFAULT_TRANSCRIBE_MODEL,
    OPENAI_TRANSCRIBE_URL,
    TRANSCRIBE_KEY_MAX,
    TRANSCRIBE_KEY_PATTERN,
    TRANSCRIBE_MODEL_MAX,
    TRANSCRIBE_MODEL_PATTERN,
    TRANSCRIBE_URL_MAX,
    isOpenAiTranscribeUrl,
    normalizeTranscribeUrl,
    type TranscriptionKey,
    type TranscriptionStreaming,
    type TranscriptionView,
} from '@socio/shared/voice/transcription';

import { useShell } from '../../shell/shell-context';
import { SettingsCard, nativeSelect } from '../settings/AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from '../settings/autosave';

import { deviceDictationSupported, serverDictationSupported } from './use-dictation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Settings → Account → Profile → Dictation (CB-101): how the composer's mic
 * turns speech into text for this person, on every device. Saved at once.
 */
export function DictationPreference() {
    const { workspace, state, mutate } = useShell();
    const [browser, setBrowser] = useState<{
        device: boolean;
        server: boolean;
    }>();
    useEffect(
        () =>
            setBrowser({
                device: deviceDictationSupported(),
                server: serverDictationSupported(),
            }),
        [],
    );
    const allowed = state.settings.dictationMethods ?? 'both';
    const server = !!workspace.setup.transcription;
    const saved = workspace.preferences?.dictation ?? null;
    const [value, setValue] = useState<DictationMethod | null>(saved);
    useEffect(() => setValue(saved), [saved]);
    const here = availableDictation({
        device: !!browser?.device,
        server: !!browser?.server && server,
        allowed,
    });
    const why = (method: DictationMethod) =>
        allowed !== 'both' && allowed !== method
            ? 'Your admin turned this off.'
            : method === 'server' && !server
              ? 'The server has no transcription server set up.'
              : browser && !browser[method]
                ? 'This browser can’t do this.'
                : '';
    const save = async (next: DictationMethod | null) => {
        const previous = value;
        setValue(next);
        if (await mutate('/preferences', 'PATCH', { dictation: next })) {
            toast.success('Dictation saved');
        } else {
            setValue(previous);
        }
    };
    return (
        <SettingsCard>
            <fieldset className="grid gap-3" data-slot="dictation-preference">
                <legend className="mb-1 font-medium">Dictation</legend>
                <p className="text-muted-foreground">
                    How the mic in the chat composer turns your speech into text. The text goes into your message for
                    you to edit and send. This follows you on every device; a way that doesn’t work on one isn’t offered
                    there.
                </p>
                <label className="flex items-start gap-2">
                    <input
                        type="radio"
                        name="dictation"
                        data-slot="radio"
                        className="mt-1"
                        checked={value === null}
                        onChange={() => void save(null)}
                    />
                    <span>
                        <span className="font-medium">Ask me</span>
                        <span className="block text-muted-foreground">
                            The first time you tap the mic where both ways work.
                        </span>
                    </span>
                </label>
                {DICTATION_METHODS.map((method) => (
                    <label key={method} className="flex items-start gap-2">
                        <input
                            type="radio"
                            name="dictation"
                            data-slot="radio"
                            className="mt-1"
                            checked={value === method}
                            onChange={() => void save(method)}
                        />
                        <span>
                            <span className="font-medium">{DICTATION_LABELS[method]}</span>
                            <span className="block text-muted-foreground">
                                {DICTATION_NOTES[method]}
                                {why(method) && ` ${why(method)}`}
                            </span>
                        </span>
                    </label>
                ))}
                {browser && !here.length && (
                    <p className="text-muted-foreground">Dictation isn’t available in this browser on this server.</p>
                )}
            </fieldset>
            <DictationLanguageSetting />
        </SettingsCard>
    );
}

/**
 * Settings → Account → Profile → Dictation language (CB-221): the hint
 * the transcription server gets with this person's recordings, live text
 * and self-hosted calls. Auto sends none. Saved at once.
 */
export function DictationLanguageSetting() {
    const { workspace, mutate } = useShell();
    const saved = dictationLanguageHint(workspace.preferences?.dictationLanguage);
    const [value, setValue] = useState<DictationLanguage | undefined>(saved);
    useEffect(() => setValue(saved), [saved]);
    const save = async (next: DictationLanguage | undefined) => {
        const previous = value;
        setValue(next);
        if (await mutate('/preferences', 'PATCH', { dictationLanguage: next ?? null })) {
            toast.success(next ? `Dictation language: ${DICTATION_LANGUAGES[next]}` : 'Dictation language: Auto');
        } else {
            setValue(previous);
        }
    };
    return (
        <section className="mt-4 grid gap-1.5 border-t pt-4" data-slot="dictation-language">
            <label htmlFor="dictation-language" className="font-medium">
                Dictation language
            </label>
            <p id="dictation-language-help" className="text-muted-foreground">
                Auto detects the language as you speak. Pick one if dictation keeps guessing wrong. Used when our server
                transcribes, not “On this device”.
            </p>
            <select
                id="dictation-language"
                data-slot="native-select"
                aria-describedby="dictation-language-help"
                className={`${nativeSelect} w-full sm:w-64`}
                value={value ?? 'auto'}
                onChange={(event) => {
                    const next = dictationLanguageHint(event.target.value);
                    void save(next);
                }}
            >
                <option value="auto">Auto</option>
                {DICTATION_LANGUAGE_OPTIONS.map(({ code, name }) => (
                    <option key={code} value={code}>
                        {name}
                    </option>
                ))}
            </select>
        </section>
    );
}

/**
 * Settings → Workspace → General → Dictation: which ways the composer
 * offers everyone, over `DICTATION_METHODS` in the environment.
 */
export function DictationAllowedSetting({
    state,
    readOnly,
    mutate,
}: {
    state: State;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const [value, setValue] = useState<DictationAllowed>(state.settings.dictationMethods ?? 'both');
    return (
        <SettingsCard>
            <section className="grid gap-2" data-slot="dictation-allowed">
                <label htmlFor="dictation-allowed" className="font-medium">
                    Dictation
                </label>
                <p className="text-muted-foreground">
                    The ways the chat composer’s mic may turn speech into text. On this device, the browser does it, and
                    on iPhone Safari may send the audio to Apple. On our server, the transcription server below does.
                </p>
                <select
                    id="dictation-allowed"
                    className={`${nativeSelect} w-fit`}
                    disabled={readOnly}
                    value={value}
                    onChange={async (event) => {
                        const next = event.target.value as DictationAllowed;
                        const previous = value;
                        setValue(next);
                        if (await mutate('/settings', 'PATCH', { dictationMethods: next })) {
                            toast.success('Dictation saved');
                        } else {
                            setValue(previous);
                        }
                    }}
                >
                    <option value="both">Both: each person picks</option>
                    <option value="device">{DICTATION_LABELS.device} only</option>
                    <option value="server">{DICTATION_LABELS.server} only</option>
                </select>
                {readOnly && <p className="text-muted-foreground">Only an admin can change this.</p>}
            </section>
        </SettingsCard>
    );
}

const KEY_LINES: Record<TranscriptionKey, string> = {
    settings: 'Sends the key set here.',
    transcribe: 'Sends the key in VOICE_TRANSCRIBE_API_KEY.',
    voice: 'Sends OpenAI’s key, VOICE_API_KEY.',
    none: 'Sends no key.',
    withheld: 'No key is sent to this server.',
    insecure:
        'Sends nothing: this server has a key, and a key goes only over https (or to this machine). Change the URL to https.',
    unreadable: 'Sends nothing: the key set here can’t be opened (its data key is gone). Replace or clear it.',
};
/** With the environment's URL, the fix is in the environment (CB-204). */
const ENV_INSECURE =
    'Sends nothing: VOICE_TRANSCRIBE_API_KEY goes only over https (or to this machine). Set an https VOICE_TRANSCRIBE_URL, or unset VOICE_TRANSCRIBE_API_KEY.';
/** A URL saved here, and the environment's key applies at its origin. */
const MIXED_INSECURE =
    'Sends nothing: VOICE_TRANSCRIBE_API_KEY applies to this URL and goes only over https (or to this machine). Change the URL to https, or unset VOICE_TRANSCRIBE_API_KEY.';
const keyLine = (key: TranscriptionKey, view: Partial<TranscriptionView>) =>
    key === 'withheld' && view.keyHost
        ? `No key is sent to this server (the key is set for ${view.keyHost}).`
        : key === 'insecure' && view.source === 'env'
          ? ENV_INSECURE
          : key === 'insecure' && view.insecureKey === 'transcribe'
            ? MIXED_INSECURE
            : KEY_LINES[key];

/**
 * Settings → Workspace → General → Transcription (CB-101): where "On our
 * server" dictation sends recordings, over `VOICE_TRANSCRIBE_URL` and
 * `VOICE_TRANSCRIBE_MODEL`. Any OpenAI-compatible speech-to-text server.
 * An admin may set its key here too (CB-204): write-only, so this shows
 * only whether one is set and which key is sent, never a key.
 *
 * It saves as it changes (CB-308): the URL and model when their field
 * loses focus, and only a real, valid change, since a new URL clears the
 * saved key (the toast says so, and offers no Undo, which couldn't bring
 * the key back). A key saves on Enter or when its field loses focus, and
 * only when one was typed; it isn't shown again, in the field or a toast.
 */
export function TranscriptionSetting({
    state,
    available,
    readOnly,
    mutate,
}: {
    state: State;
    /** `workspace.setup.transcription`. */
    available: boolean;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const current = state.settings.transcription;
    // `custom`: set here, over the server's default. Undo of a first change
    // goes back to the default rather than saving it here.
    const auto = useAutosave(
        {
            url: current?.url ?? '',
            model: current?.model ?? '',
            custom: current?.source === 'settings',
        },
        ({ url, model, custom }) =>
            mutate('/settings', 'PATCH', {
                transcription: custom ? { url: normalizeTranscribeUrl(url), model: model.trim() } : null,
            }),
    );
    const busy = auto.status === 'saving';
    /** The new key being typed; undefined when not replacing it. */
    const [secret, setSecret] = useState<string>();
    const keySaved = !!current?.keySaved;
    const typedUrl = (url: string) => normalizeTranscribeUrl(url) ?? url.trim();
    /** The URL field differs from the URL saved, even half typed. */
    const urlEdited = typedUrl(auto.value.url) !== auto.saved().url;
    /** And leaving the field would save it: a usable URL. */
    const urlChanging = urlEdited && !!normalizeTranscribeUrl(auto.value.url);
    const commitServer = () => {
        const saved = auto.saved();
        const url = typedUrl(auto.value.url);
        const model = auto.value.model.trim();
        const unchanged = url === saved.url && model === saved.model;
        auto.edit({ url, model, custom: unchanged ? saved.custom : true });
        // The key goes with a new URL: said, and not undone.
        const clearsKey = (next: { url: string }, previous: { url: string }) => keySaved && next.url !== previous.url;
        void auto.commit(
            (next, previous) =>
                next.url === previous.url
                    ? 'Transcription model saved'
                    : clearsKey(next, previous)
                      ? 'Transcription URL saved. The saved key was cleared; add the key for the new server.'
                      : 'Transcription URL saved',
            (value) => {
                if (!normalizeTranscribeUrl(value.url)) {
                    return 'Use an http or https URL, without a password or query.';
                }
                if (
                    !value.model ||
                    value.model.length > TRANSCRIBE_MODEL_MAX ||
                    !TRANSCRIBE_MODEL_PATTERN.test(value.model)
                ) {
                    return 'Name the model, such as whisper-1.';
                }
            },
            (next, previous) => !clearsKey(next, previous),
        );
    };
    /** Enter or leaving the key field: saves a key that was typed. */
    const saveKey = (field: HTMLInputElement) => {
        const key = field.value.trim();
        if (!key) {
            // Nothing typed: the field goes away, nothing is saved.
            setSecret(undefined);
            return;
        }
        // A key is only for the saved URL.
        if (urlEdited) {
            auto.setError('Fix the URL first: the key is for the saved one.');
            return;
        }
        if (key.length > TRANSCRIBE_KEY_MAX || !TRANSCRIBE_KEY_PATTERN.test(key)) {
            auto.setError('Paste the key: one line, without spaces.');
            return;
        }
        // The field empties at once, so a second Enter or blur saves nothing,
        // and goes away: the key isn't shown again.
        field.value = '';
        setSecret(undefined);
        // The URL saved (or being saved): the server refuses the key if
        // another is in force by then.
        const url = auto.saved().url;
        void auto.perform(() => mutate('/settings', 'PATCH', { transcriptionKey: { key, url } }), 'Key saved');
    };
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="transcription"
                // Enter in the URL or model saves too, like leaving the field.
                onSubmit={(e) => {
                    e.preventDefault();
                    commitServer();
                }}
            >
                <AutosaveHeader title="Transcription" status={!readOnly ? auto.status : undefined}>
                    Where “On our server” dictation sends a recording to become text: any OpenAI-compatible
                    speech-to-text server, at its <code>/v1/audio/transcriptions</code>. A server in your own network
                    keeps the audio there. The language is detected.
                </AutosaveHeader>
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                        <label htmlFor="transcription-url" className="font-medium">
                            Base URL
                        </label>
                        <Input
                            id="transcription-url"
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={TRANSCRIBE_URL_MAX}
                            placeholder={OPENAI_TRANSCRIBE_URL}
                            disabled={readOnly}
                            value={auto.value.url}
                            onChange={(event) => auto.edit({ url: event.target.value })}
                            onBlur={commitServer}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <label htmlFor="transcription-model" className="font-medium">
                            Model
                        </label>
                        <Input
                            id="transcription-model"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={TRANSCRIBE_MODEL_MAX}
                            placeholder={DEFAULT_TRANSCRIBE_MODEL}
                            disabled={readOnly}
                            value={auto.value.model}
                            onChange={(event) => auto.edit({ model: event.target.value })}
                            onBlur={commitServer}
                        />
                    </div>
                </div>
                <p className="text-muted-foreground" data-slot="transcription-key">
                    {current?.source === 'settings'
                        ? 'Set here, over the server’s default.'
                        : 'The server’s default (VOICE_TRANSCRIBE_URL).'}{' '}
                    {current?.key && keyLine(current.key, current)}
                    {!available &&
                        current?.key !== 'insecure' &&
                        current?.key !== 'unreadable' &&
                        (current?.url
                            ? ' Not available: OpenAI’s URL needs VOICE_API_KEY, VOICE_TRANSCRIBE_API_KEY or a key set here.'
                            : ' Not available: no usable URL.')}
                </p>
                <div className="grid gap-1.5" data-slot="transcription-secret">
                    <label htmlFor="transcription-secret" className="font-medium">
                        Key
                    </label>
                    <p className="text-muted-foreground">
                        {keySaved ? 'A key is set here.' : 'No key is set here.'} It is sent only to the URL above, as a
                        bearer token, and only over https or to this machine; it is never shown again. A new URL clears
                        it.
                        {keySaved && urlChanging && ' Saving this URL clears the key.'}
                    </p>
                    {!readOnly &&
                        (secret !== undefined ? (
                            <div className="grid gap-1.5">
                                <Input
                                    id="transcription-secret"
                                    type="password"
                                    autoComplete="off"
                                    data-1p-ignore
                                    data-lpignore="true"
                                    data-bwignore
                                    spellCheck={false}
                                    maxLength={TRANSCRIBE_KEY_MAX}
                                    className="w-full sm:w-80"
                                    placeholder="The server’s key"
                                    // Opened by Replace key or Set a key, for typing at once.
                                    autoFocus
                                    value={secret}
                                    onChange={(event) => setSecret(event.target.value)}
                                    onBlur={(event) => saveKey(event.currentTarget)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Escape') {
                                            event.preventDefault();
                                            // Emptied first: a blur as the field goes saves nothing.
                                            event.currentTarget.value = '';
                                            setSecret(undefined);
                                            return;
                                        }
                                        if (event.key !== 'Enter') {
                                            return;
                                        }
                                        event.preventDefault();
                                        saveKey(event.currentTarget);
                                    }}
                                />
                                <p className="text-muted-foreground">
                                    {urlEdited
                                        ? 'Fix the URL first: the key is for the saved one.'
                                        : 'Saves on Enter or when you leave the field. Esc cancels.'}
                                </p>
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-2">
                                <Button type="button" variant="outline" disabled={busy} onClick={() => setSecret('')}>
                                    {keySaved ? 'Replace key' : 'Set a key'}
                                </Button>
                                {keySaved && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() =>
                                            void auto.perform(
                                                () =>
                                                    mutate('/settings', 'PATCH', {
                                                        transcriptionKey: null,
                                                    }),
                                                'Key cleared',
                                            )
                                        }
                                    >
                                        Clear key
                                    </Button>
                                )}
                            </div>
                        ))}
                </div>
                <SaveError error={auto.error} />
                {readOnly ? (
                    <p className="text-muted-foreground">Only an admin can change this.</p>
                ) : (
                    auto.value.custom && (
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                onClick={() =>
                                    void auto.change(
                                        { custom: false },
                                        keySaved
                                            ? 'Using the server’s default. The saved key was cleared.'
                                            : 'Using the server’s default',
                                        !keySaved,
                                    )
                                }
                            >
                                Use the server’s default
                            </Button>
                        </div>
                    )
                )}
                {/* Saved at once, apart from the URL and model above. */}
                <LiveTextSetting
                    current={current}
                    chosen={state.settings.transcriptionStreaming ?? null}
                    readOnly={readOnly}
                    busy={busy}
                    onChange={async (next) => {
                        let saved = false;
                        await auto.perform(async () => {
                            saved = await mutate('/settings', 'PATCH', {
                                transcriptionStreaming: next,
                            });
                            return saved;
                        }, 'Live text saved');
                        return saved;
                    }}
                />
            </form>
        </SettingsCard>
    );
}

const LIVE_TEXT: Record<TranscriptionStreaming, string> = {
    auto: 'Automatic: where the server has it',
    on: 'On: try it every time',
    off: 'Off: record, then send',
};
const LIVE_TEXT_SHORT: Record<TranscriptionStreaming, string> = {
    auto: 'automatic',
    on: 'on',
    off: 'off',
};

/**
 * Transcription's live text (CB-222), over `VOICE_TRANSCRIBE_STREAMING`:
 * saved at once, like the ways to dictate.
 */
function LiveTextSetting({
    current,
    chosen,
    readOnly,
    busy,
    onChange,
}: {
    current: State['settings']['transcription'];
    /** An admin's choice; null: the server's default. */
    chosen: TranscriptionStreaming | null;
    readOnly: boolean;
    busy: boolean;
    /** null goes back to the server's default. */
    onChange: (next: TranscriptionStreaming | null) => Promise<boolean>;
}) {
    const saved = chosen ?? 'default';
    const [value, setValue] = useState<string>(saved);
    useEffect(() => setValue(saved), [saved]);
    const inForce = current?.streaming ?? 'auto';
    const why =
        inForce === 'off' || current?.realtime !== false || !current?.url
            ? ''
            : isOpenAiTranscribeUrl(current.url)
              ? ' Not with OpenAI’s URL: it records, then sends.'
              : ' Not with this URL: the stream goes only over https (or to this machine).';
    return (
        <div className="grid gap-1.5" data-slot="transcription-streaming">
            <label htmlFor="transcription-streaming" className="font-medium">
                Live text
            </label>
            <p className="text-muted-foreground">
                The words show as a preview while people speak: the audio streams through this server to the
                transcription server’s <code>/v1/realtime</code> socket, with the same key. On Done the whole recording
                is transcribed, as without live text, and its text replaces the preview. Where there is no socket, or it
                drops, there is no preview.
                {why}
            </p>
            <select
                id="transcription-streaming"
                className={`${nativeSelect} w-fit`}
                disabled={readOnly || busy}
                value={value}
                onChange={async (event) => {
                    const next = event.target.value;
                    setValue(next);
                    const choice = next === 'default' ? null : (next as TranscriptionStreaming);
                    if (!(await onChange(choice))) {
                        setValue(saved);
                    }
                }}
            >
                <option value="default">
                    {chosen
                        ? 'The server’s default (VOICE_TRANSCRIBE_STREAMING)'
                        : `The server’s default: ${LIVE_TEXT_SHORT[inForce]}`}
                </option>
                {(Object.keys(LIVE_TEXT) as TranscriptionStreaming[]).map((option) => (
                    <option key={option} value={option}>
                        {LIVE_TEXT[option]}
                    </option>
                ))}
            </select>
        </div>
    );
}
