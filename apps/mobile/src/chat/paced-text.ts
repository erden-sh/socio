// Paced streaming (CB-365):
// a reply being written shows a few words at a time, as the web's grows with
// each delta, instead of repainting on every AG-UI TEXT_MESSAGE_CONTENT delta
// or waiting for whole paragraphs. The caller keeps the full text as it
// arrives and hands it in; only what is shown is paced:
// - at most one release every PACED_TEXT_TICK_MS (20 a second at most, however
//   fast the deltas come), so the Markdown renderer isn't asked for a frame
//   per token;
// - each release shows about 1/PACED_TEXT_DRAIN_TICKS of what is waiting (a
//   word at least), rounded up to the end of a word, so a burst (a slow
//   network, a model that sends paragraphs) drains at a steady pace over about
//   250 ms instead of landing at once;
// - the line being written holds back what would flash as another block: a
//   line of list or heading markers alone (`-`, `1.`, `##`, `---`, `>`; a
//   paragraph line under `-` or `=` would read as a heading), and a code fence
//   or table row until its line ends. A code block that is still open shows
//   as a code block that grows, as the web's does;
// - a word still being written shows once the deltas pause (PACED_TEXT_QUIET_MS:
//   a tool call, a slow model);
// - a reply first seen with much text (the chat opened mid-stream, its row
//   drawn again) shows what is there at once.
// Finishing (the run ends, fails or is stopped) shows the full text at once.
// What is shown is always a prefix of the text handed in: nothing is dropped
// or reordered, and the last release equals it exactly.

/** The shortest time between two releases of a streaming reply's text. */
export const PACED_TEXT_TICK_MS = 50;
/** A release shows about this fraction of what waits: a burst drains over this many ticks. */
export const PACED_TEXT_DRAIN_TICKS = 5;
/** With no delta for this long, a word still being written shows too. */
export const PACED_TEXT_QUIET_MS = 300;
/** A reply whose first text is this long or more shows at once (opened mid-stream). */
export const PACED_TEXT_CATCH_UP_CHARS = 400;
/** A run of text with no space (a URL, CJK) is cut every this many characters. */
const LONG_RUN = 24;

const isSpace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// Characters a block marker is made of: list bullets and numbers, headings,
// setext and thematic lines, quotes and fences.
const MARKER = new Set([...'-*+_=#>`~.)0123456789 \t']);

/**
 * Where a cut may fall in the line starting at `start`: anywhere past its first
 * character that isn't a marker (`after`), or only once the line ends
 * (`after: Infinity`) for a fence or table row.
 */
function lineRule(text: string, start: number): number {
    let index = start;
    while (index < text.length && (text[index] === ' ' || text[index] === '\t')) {
        index++;
    }
    if (text.startsWith('```', index) || text.startsWith('~~~', index) || text[index] === '|') {
        return Number.POSITIVE_INFINITY;
    }
    while (index < text.length && text[index] !== '\n' && MARKER.has(text[index]!)) {
        index++;
    }
    // The line is markers so far: wait for its content (or its end).
    return index < text.length && text[index] !== '\n' ? index : Number.POSITIVE_INFINITY;
}

/**
 * The end of the text to show next: the first cut at or past `target`, else the
 * last one before it, else `from` (nothing more yet). A cut falls after a run
 * of spaces (the next word not started), every LONG_RUN characters of a long
 * run, or at the text's end when `end` (the deltas paused); never inside the
 * markers that start a line, nor inside a fence or table row's line.
 */
export function nextCut(text: string, from: number, target: number, end: boolean): number {
    let lineStart = text.lastIndexOf('\n', from - 1) + 1;
    let after = lineRule(text, lineStart);
    let runStart = from;
    while (runStart > lineStart && !isSpace(text.charCodeAt(runStart - 1))) {
        runStart--;
    }
    let best = from;
    for (let cut = from + 1; cut <= text.length; cut++) {
        const previous = text.charCodeAt(cut - 1);
        if (previous === 10) {
            lineStart = cut;
            after = lineRule(text, lineStart);
        }
        if (isSpace(previous)) {
            runStart = cut;
        }
        const atEnd = cut === text.length;
        const word = atEnd
            ? end || isSpace(previous)
            : (isSpace(previous) && !isSpace(text.charCodeAt(cut))) ||
              (cut - runStart >= LONG_RUN && (cut - runStart) % LONG_RUN === 0 && !isHighSurrogate(previous));
        if (!word || (cut !== lineStart && cut <= after)) {
            continue;
        }
        best = cut;
        if (cut >= target) {
            break;
        }
    }
    return best;
}

/** One streaming reply's paced display. */
export interface PacedText {
    /** The text shown now. */
    readonly shown: string;
    /** Hands in the reply's full text so far. Ignored once finished. */
    push(text: string): void;
    /** The run ended, failed or was stopped: shows the full text at once, then ignores further calls. */
    finish(): void;
    /** Stops without showing anything more (the view went away). */
    dispose(): void;
}

export interface PacedTextOptions {
    /** Called with the text to show, each time it changes. */
    onRelease: (shown: string) => void;
    /** The text already shown (a reply that was streaming before), '' by default. */
    initial?: string;
}

/**
 * Paces one streaming reply: a few words at a time, at most every
 * {@link PACED_TEXT_TICK_MS}, draining what waits over about
 * {@link PACED_TEXT_DRAIN_TICKS} releases. A push after a quiet spell releases at once.
 */
export function createPacedText(options: PacedTextOptions): PacedText {
    let shown = options.initial ?? '';
    let latest = shown;
    let pushed = false;
    let step = 1;
    let releasedAt = Number.NEGATIVE_INFINITY;
    let pushedAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A timer that only waits for the deltas to pause: a push brings the next tick forward.
    let waitingForQuiet = false;
    let done = false;

    const cancelTimer = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const release = (text: string) => {
        shown = text;
        releasedAt = Date.now();
        options.onRelease(text);
    };

    const schedule = (wait: number, quiet: boolean) => {
        timer = setTimeout(tick, Math.max(0, wait));
        waitingForQuiet = quiet;
    };

    function tick() {
        timer = null;
        if (done) {
            return;
        }
        const now = Date.now();
        const quiet = now - pushedAt >= PACED_TEXT_QUIET_MS;
        const cut = nextCut(latest, shown.length, shown.length + step, quiet);
        const released = cut > shown.length;
        if (released) {
            release(latest.slice(0, cut));
        }
        if (latest.length === shown.length) {
            return;
        }
        if (released) {
            schedule(PACED_TEXT_TICK_MS, false);
        } else if (!quiet) {
            // Only a word or a line's markers wait: look again once the deltas pause.
            schedule(pushedAt + PACED_TEXT_QUIET_MS - now, true);
        }
        // Quiet and still held (a list marker, a fence line): the next push or finish shows it.
    }

    return {
        get shown() {
            return shown;
        },
        push(text) {
            if (done || text === latest) {
                return;
            }
            const first = !pushed;
            pushed = true;
            pushedAt = Date.now();
            // Not the text shown grown (never expected): start again from it, at once.
            const replaced = !text.startsWith(shown);
            if (replaced) {
                shown = '';
                releasedAt = Number.NEGATIVE_INFINITY;
            }
            latest = text;
            const waiting = latest.length - shown.length;
            step = Math.max(1, Math.ceil(waiting / PACED_TEXT_DRAIN_TICKS));
            if (replaced || (first && waiting >= PACED_TEXT_CATCH_UP_CHARS)) {
                step = waiting;
            }
            if (timer !== null && !waitingForQuiet) {
                return;
            }
            cancelTimer();
            const wait = releasedAt + PACED_TEXT_TICK_MS - pushedAt;
            if (wait <= 0) {
                tick();
            } else {
                schedule(wait, false);
            }
        },
        finish() {
            if (done) {
                return;
            }
            done = true;
            cancelTimer();
            if (latest !== shown) {
                release(latest);
            }
        },
        dispose() {
            done = true;
            cancelTimer();
        },
    };
}
