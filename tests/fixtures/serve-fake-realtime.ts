// Testing only (CB-222): the fake realtime transcription server
// (fake-realtime.ts) on loopback, for watching live text in a local app.
//
//   node --import tsx tests/fixtures/serve-fake-realtime.ts [port] [token]
//
// Then start the app with VOICE_TRANSCRIBE_URL=http://127.0.0.1:<port>
// and, with a token, VOICE_TRANSCRIBE_API_KEY=<token>. It hears a word of
// a scripted sentence about every 350 ms of audio, whatever is said.
import { startFakeRealtime } from './fake-realtime.js';

const port = Number(process.argv[2] ?? 4483);
const fake = await startFakeRealtime({
    port,
    token: process.argv[3] || undefined,
    words: 'Remind me to send the quarterly numbers to the board on Friday morning, and ask Rulo for the updated hiring plan before then'.split(
        ' ',
    ),
    bytesPerWord: 11_200,
    wordsPerTurn: 12,
    batchText: 'From the recording.',
});
console.log(`Fake realtime transcription on ${fake.url}`);
