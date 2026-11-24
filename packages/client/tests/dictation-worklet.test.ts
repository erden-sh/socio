import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { wavFile } from '../src/modules/voice/dictation-stream.js';

// CB-222: live dictation's AudioWorklet (public/dictation-worklet.js), run
// here outside a browser, and the WAV the composer sends when the stream
// fails.

const source = readFileSync(new URL('../../../public/dictation-worklet.js', import.meta.url), 'utf8');

/** The worklet at `rate`, fed `seconds` of `signal`; its 16 kHz output. */
function capture(rate: number, signal: (t: number) => number, seconds = 1) {
    let Processor:
        | (new (options: unknown) => {
              process(inputs: Float32Array[][]): boolean;
              port: { onmessage: (event: { data: unknown }) => void };
          })
        | undefined;
    const posted: unknown[] = [];
    class Base {
        port = {
            postMessage: (data: unknown) => posted.push(data),
            onmessage: null as unknown,
        };
    }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
        Base,
        (_name: string, constructor: typeof Processor) => (Processor = constructor),
        rate,
    );
    const processor = new Processor!({ processorOptions: { rate: 16000 } });
    const total = Math.round(rate * seconds);
    // Render quanta of 128 frames, as browsers run worklets.
    for (let n = 0; n < total; n += 128) {
        const block = new Float32Array(Math.min(128, total - n));
        for (let i = 0; i < block.length; i++) {
            block[i] = signal((n + i) / rate);
        }
        processor.process([[block]]);
    }
    processor.port.onmessage({ data: 'flush' });
    expect(posted.at(-1)).toBe('flushed');
    const chunks = posted.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer);
    // About 100 ms each, but the last.
    for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.byteLength).toBe(3200);
    }
    const out = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength / 2, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(new Int16Array(chunk), at);
        at += chunk.byteLength / 2;
    }
    return out;
}
const rms = (samples: Int16Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
const tone = (hz: number) => (t: number) => 0.5 * Math.sin(2 * Math.PI * hz * t);

it('makes 16,000 samples a second from 48, 44.1 and 24 kHz', () => {
    for (const rate of [48000, 44100, 24000]) {
        const out = capture(rate, tone(1000));
        expect(Math.abs(out.length - 16000), `${rate}`).toBeLessThanOrEqual(1);
    }
});

it('keeps speech frequencies and filters out what 16 kHz can’t hold', () => {
    for (const rate of [48000, 44100]) {
        // Skip the filter's start.
        const kept = rms(capture(rate, tone(1000)).subarray(400));
        expect(kept / (0.5 * 0x7fff * Math.SQRT1_2), `${rate}`).toBeGreaterThan(0.95);
        // 12 kHz would fold back to 4 kHz: at least 40 dB down instead.
        const folded = rms(capture(rate, tone(12000)).subarray(400));
        expect(20 * Math.log10(folded / kept), `${rate}`).toBeLessThan(-40);
    }
});

it('writes a 16-bit mono WAV header for the samples', async () => {
    const samples = new Int16Array([1, -2, 3]);
    const wav = wavFile([samples, new Int16Array([4])], 16000);
    expect(wav.type).toBe('audio/wav');
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(bytes.length).toBe(44 + 8);
    const view = new DataView(bytes.buffer);
    const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    expect(text(0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(text(8)).toBe('WAVE');
    expect(text(12)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(8);
    expect([...new Int16Array(bytes.buffer.slice(44))]).toEqual([1, -2, 3, 4]);
});
