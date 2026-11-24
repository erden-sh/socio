// Live dictation's audio (CB-222, packages/client/src/modules/voice/dictation-stream.ts): the
// microphone at the context's rate (often 48 kHz; iOS picks its own), as
// 16-bit mono PCM at `processorOptions.rate`, in chunks of about 100 ms
// posted to the page. Before it is resampled, a low-pass filter (a
// Hamming-windowed sinc, cut off at 0.45 of the new rate) takes out what
// the new rate can't hold, so it doesn't fold back as noise; each output
// sample is interpolated between the two filtered input samples around
// it; only those are filtered. "flush" posts what is left, then "flushed".
class Pcm16Capture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const rate = options.processorOptions.rate;
        /** Input samples per output sample. */
        this.step = sampleRate / rate;
        this.chunk = new Int16Array(Math.round(rate / 10));
        this.length = 0;
        // About 20 input samples per output sample of filter, an odd count;
        // none when not downsampling.
        const count = this.step > 1 ? Math.round(this.step * 20) | 1 : 1;
        const cutoff = (0.45 * rate) / sampleRate;
        this.taps = new Float32Array(count);
        let sum = 0;
        for (let i = 0; i < count; i++) {
            const x = i - (count - 1) / 2;
            const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
            const window = count > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (count - 1)) : 1;
            this.taps[i] = sinc * window;
            sum += this.taps[i];
        }
        for (let i = 0; i < count; i++) this.taps[i] /= sum;
        // The last `count` input samples, twice over (each is written at `at`
        // and `at + count`), so the filter reads one run of them.
        this.history = new Float32Array(count * 2);
        this.at = 0;
        /** The filtered value at the previous input sample. */
        this.previous = 0;
        /** When the next output sample falls, in input samples from this one. */
        this.next = 0;
        this.port.onmessage = (event) => {
            if (event.data !== 'flush') return;
            this.post();
            this.port.postMessage('flushed');
        };
    }
    post() {
        if (!this.length) return;
        const pcm = this.chunk.slice(0, this.length);
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.length = 0;
    }
    process(inputs) {
        const channel = inputs[0] && inputs[0][0];
        if (!channel) return true;
        const { taps, history } = this;
        const count = taps.length;
        for (let i = 0; i < channel.length; i++) {
            history[this.at] = history[this.at + count] = channel[i];
            this.at = this.at + 1 === count ? 0 : this.at + 1;
            // Filtered only where an output sample falls next to it: between
            // the previous input sample and this one, or this one and the next.
            if (this.next > 1) {
                this.next -= 1;
                continue;
            }
            let filtered = 0;
            for (let k = 0, j = this.at; k < count; k++, j++) filtered += taps[k] * history[j];
            while (this.next <= 0) {
                const t = this.next + 1;
                const value = Math.max(-1, Math.min(1, this.previous + (filtered - this.previous) * t));
                this.chunk[this.length++] = value < 0 ? value * 0x8000 : value * 0x7fff;
                if (this.length === this.chunk.length) this.post();
                this.next += this.step;
            }
            this.next -= 1;
            this.previous = filtered;
        }
        return true;
    }
}
registerProcessor('socio-pcm16', Pcm16Capture);
