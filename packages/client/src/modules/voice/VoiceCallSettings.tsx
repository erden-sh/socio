import type { SetupStatus, State } from '@socio/shared/types';
import {
    TRANSCRIBE_MODEL_MAX,
    TRANSCRIBE_MODEL_PATTERN,
    TRANSCRIBE_URL_MAX,
    normalizeTranscribeUrl,
} from '@socio/shared/voice/transcription';
import {
    DEFAULT_SPEECH_MODEL,
    DEFAULT_SPEECH_VOICE,
    SPEECH_VOICE_MAX,
    SPEECH_VOICE_PATTERN,
    type SpeechKey,
    type VoiceBackend,
    type VoiceCallsView,
} from '@socio/shared/voice/voice-call';

import { SettingsCard, nativeSelect } from '../settings/AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from '../settings/autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const BACKENDS: Record<VoiceBackend, string> = {
    cloud: 'Cloud: OpenAI Realtime',
    'self-hosted': 'Self-hosted: our voice server',
};

const speechKeyLine = (speech: VoiceCallsView['speech']): string => {
    const lines: Record<SpeechKey, string> = {
        speech: 'It is sent VOICE_SPEECH_API_KEY.',
        transcription: 'It is sent the transcription server’s key (the same server).',
        none: 'No key is sent to it.',
        withheld: `No key is sent to this server (VOICE_SPEECH_API_KEY is for ${speech.keyHost ?? 'another host'}).`,
        insecure: 'Nothing is sent: its key goes only over https (or to this machine). Change the URL to https.',
    };
    return lines[speech.key];
};

/**
 * Settings → General → Calls (CB-265): which backend voice calls use, over
 * `VOICE_BACKEND`, and the speech server self-hosted calls speak with,
 * over `VOICE_SPEECH_*`. It saves as it changes (CB-308): the backend at
 * once, the speech server's fields when they lose focus.
 */
export function VoiceCallsSetting({
    state,
    setup,
    readOnly,
    mutate,
}: {
    state: State;
    setup: SetupStatus;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const view = state.settings.voiceCalls;
    const chosen = state.settings.voiceBackend ?? null;
    const speech = view?.speech;
    // `custom`: the speech server is set here, over the server's default.
    // Undo of a first change goes back to the default rather than saving it.
    const auto = useAutosave(
        {
            backend: chosen ?? 'default',
            url: speech?.url ?? '',
            model: speech?.model ?? DEFAULT_SPEECH_MODEL,
            voice: speech?.voice ?? DEFAULT_SPEECH_VOICE,
            custom: speech?.source === 'settings',
        },
        ({ backend, url, model, voice, custom }) =>
            mutate('/settings', 'PATCH', {
                voiceBackend: backend === 'default' ? null : backend,
                voiceSpeech: custom
                    ? {
                          url: url ? normalizeTranscribeUrl(url) : '',
                          model: model.trim(),
                          voice: voice.trim(),
                      }
                    : null,
            }),
    );
    const busy = auto.status === 'saving';
    const commitSpeech = () => {
        const saved = auto.saved();
        const typed = auto.value.url.trim();
        const url = typed ? (normalizeTranscribeUrl(typed) ?? typed) : '';
        const model = auto.value.model.trim();
        const voice = auto.value.voice.trim();
        const unchanged = url === saved.url && model === saved.model && voice === saved.voice;
        auto.edit({ url, model, voice, custom: unchanged ? saved.custom : true });
        void auto.commit('Speech server saved', (value) => {
            if (value.url && !normalizeTranscribeUrl(value.url)) {
                return 'Use an http or https URL, without a password or query.';
            }
            if (
                !value.model ||
                value.model.length > TRANSCRIBE_MODEL_MAX ||
                !TRANSCRIBE_MODEL_PATTERN.test(value.model)
            ) {
                return 'Name the speech model, such as kokoro or tts-1.';
            }
            if (!value.voice || value.voice.length > SPEECH_VOICE_MAX || !SPEECH_VOICE_PATTERN.test(value.voice)) {
                return 'Name the voice, such as auto, af_heart or alloy.';
            }
        });
    };
    const inForce = view?.backend ?? 'cloud';
    const status =
        inForce === 'cloud'
            ? setup.voiceCloud
                ? 'Calls use OpenAI’s Realtime API.'
                : 'Calls need VOICE_API_KEY and VOICE_MODEL on the server.'
            : setup.voice
              ? `Calls use the transcription server’s realtime socket, and each thing said is a turn of the socio.${setup.voiceSpeech ? ' Replies are spoken by the speech server below.' : ' Replies are spoken by each person’s device: no speech server is set.'}`
              : 'Not available: the transcription server (above) needs a realtime socket over https, or on this machine, and can’t be OpenAI’s.';
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="voice-calls"
                // Enter in a field saves too, like leaving it.
                onSubmit={(e) => {
                    e.preventDefault();
                    commitSpeech();
                }}
            >
                <AutosaveHeader title="Calls" status={!readOnly ? auto.status : undefined}>
                    Voice calls with a socio. <strong>Cloud</strong> sends the call’s audio to OpenAI, whose realtime
                    model speaks for the socio and asks it for research. <strong>Self-hosted</strong> keeps the audio on
                    your servers: speech becomes text on the transcription server above, each thing said is a normal
                    turn of the socio (its model, tools, permissions, approvals and limits, as a typed message), and the
                    reply is spoken by the speech server below. When the self-hosted server is down, people see why and,
                    where cloud is set up, can make that call with cloud voice instead.
                </AutosaveHeader>
                <div className="grid gap-1.5">
                    <label htmlFor="voice-backend" className="font-medium">
                        Backend
                    </label>
                    <select
                        id="voice-backend"
                        className={`${nativeSelect} w-fit max-w-full`}
                        disabled={readOnly}
                        value={auto.value.backend}
                        onChange={(event) => void auto.change({ backend: event.target.value }, 'Calls saved')}
                    >
                        <option value="default">
                            {chosen
                                ? 'The server’s default (VOICE_BACKEND)'
                                : `The server’s default: ${BACKENDS[inForce].split(':')[0].toLowerCase()}`}
                        </option>
                        {(Object.keys(BACKENDS) as VoiceBackend[]).map((option) => (
                            <option key={option} value={option}>
                                {BACKENDS[option]}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground" data-slot="voice-calls-status">
                        {status}
                    </p>
                </div>
                <div className="grid gap-1">
                    <h4 className="font-medium">Speech server</h4>
                    <p className="text-muted-foreground">
                        For self-hosted calls: any server with OpenAI’s <code>/v1/audio/speech</code> that answers{' '}
                        <code>response_format: pcm</code> (16-bit, 24 kHz). Leave the URL empty and each person’s device
                        speaks the replies.
                    </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-1.5">
                        <label htmlFor="speech-url" className="font-medium">
                            Base URL
                        </label>
                        <Input
                            id="speech-url"
                            type="url"
                            inputMode="url"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={TRANSCRIBE_URL_MAX}
                            placeholder="https://voice.example.lan"
                            disabled={readOnly}
                            value={auto.value.url}
                            onChange={(event) => auto.edit({ url: event.target.value })}
                            onBlur={commitSpeech}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <label htmlFor="speech-model" className="font-medium">
                            Model
                        </label>
                        <Input
                            id="speech-model"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={TRANSCRIBE_MODEL_MAX}
                            placeholder={DEFAULT_SPEECH_MODEL}
                            disabled={readOnly}
                            value={auto.value.model}
                            onChange={(event) => auto.edit({ model: event.target.value })}
                            onBlur={commitSpeech}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <label htmlFor="speech-voice" className="font-medium">
                            Voice
                        </label>
                        <Input
                            id="speech-voice"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={SPEECH_VOICE_MAX}
                            placeholder={DEFAULT_SPEECH_VOICE}
                            disabled={readOnly}
                            value={auto.value.voice}
                            onChange={(event) => auto.edit({ voice: event.target.value })}
                            onBlur={commitSpeech}
                        />
                    </div>
                </div>
                <p className="text-muted-foreground" data-slot="speech-key">
                    {speech?.source === 'settings'
                        ? 'Set here, over the server’s default.'
                        : 'The server’s default (VOICE_SPEECH_URL).'}{' '}
                    {speech?.url ? speechKeyLine(speech) : 'No speech server: devices speak.'}
                </p>
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
                                    void auto.change({ custom: false }, 'Speech server back to the server’s default')
                                }
                            >
                                Use the server’s default
                            </Button>
                        </div>
                    )
                )}
            </form>
        </SettingsCard>
    );
}
