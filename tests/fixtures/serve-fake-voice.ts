// Testing only (CB-265): the loopback fake of socio-voice
// (fake-realtime.ts) as a server, for a local smoke test of self-hosted
// calls and live dictation. It "hears" a word every second of audio,
// whatever the audio is, ends a turn every four words, and stops hearing
// after three turns a call; `POST /v1/audio/speech` answers a short tone as PCM.
//
//   node --import tsx tests/fixtures/serve-fake-voice.ts [port] [token]
//
// Then start the app with VOICE_TRANSCRIBE_URL=http://127.0.0.1:<port>,
// VOICE_TRANSCRIBE_API_KEY=<token> (when given), VOICE_BACKEND=self-hosted
// and VOICE_SPEECH_URL=http://127.0.0.1:<port>. Nothing here leaves this
// machine.
import { startFakeRealtime } from './fake-realtime.js';

const port = Number(process.argv[2] ?? 0);
const token = process.argv[3];
const fake = await startFakeRealtime({
    port,
    ...(token ? { token } : {}),
    words: ['what', 'is', 'on', 'today'],
    bytesPerWord: 32_000,
    wordsPerTurn: 4,
    maxTurns: 3,
    speech: { bytes: 24_000 * 2, gapMs: 200 },
});
console.log(`Fake voice server on ${fake.url}`);
const stop = () => void fake.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
