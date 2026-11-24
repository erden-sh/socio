import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createPacedText,
    nextCut,
    PACED_TEXT_CATCH_UP_CHARS,
    PACED_TEXT_QUIET_MS,
    PACED_TEXT_TICK_MS,
} from '../../src/chat/paced-text';

// Paced streaming (CB-365): a streaming
// reply shows a few words at a time, at a steady pace, on the device's timers,
// and what it shows is always a prefix of the text that came.

const PARAGRAPH =
    'SQLite keeps the whole database in one file, so a backup is a copy and a test can start from an empty file in a moment.';

const REPLY = [
    '## A long answer',
    PARAGRAPH,
    `Steps:\n- one point\n- **another** point\n1. first\n2. second`,
    '```sql\nSELECT name\nFROM dots\nORDER BY name;\n```',
    '| Item | Count |\n| --- | ---: |\n| a | 1 |\n| b | 2 |',
    '> A quote that runs on for a while.',
    'Setext title\n---',
    `A link to https://example.test/${'x'.repeat(60)} and the end.`,
].join('\n\n');

/** A line of the text shown that would read as another block than the full text's. */
function flashes(shown: string, full: string): string | null {
    const lineStart = shown.lastIndexOf('\n') + 1;
    const partial = shown.slice(lineStart);
    const lineEnd = full.indexOf('\n', lineStart);
    const whole = full.slice(lineStart, lineEnd === -1 ? full.length : lineEnd);
    if (partial === '' || partial === whole) {
        return null;
    }
    if (/^\s*(?:```|~~~|\|)/.test(whole)) {
        return `a fence or table line cut: ${JSON.stringify(partial)}`;
    }
    if (/^[\s\d\-*+_=#>`~.)]*$/.test(partial)) {
        return `markers alone: ${JSON.stringify(partial)}`;
    }
    return null;
}

describe('nextCut', () => {
    it('cuts after a word, never inside one', () => {
        expect(nextCut('Hello, world', 0, 3, false)).toBe(7);
        expect(nextCut('Hello, world', 0, 9, false)).toBe(7);
        expect(nextCut('Hello, world', 0, 9, true)).toBe(12);
        expect(nextCut('Hello', 0, 3, false)).toBe(0);
        expect(nextCut('Hello ', 0, 3, false)).toBe(6);
    });

    it('takes a whole run of spaces and blank lines with the word before it', () => {
        expect(nextCut('One.\n\nTwo', 0, 2, false)).toBe(6);
    });

    it('holds a line of markers until its content starts', () => {
        expect(nextCut('Intro\n- ', 0, 8, false)).toBe(6);
        expect(nextCut('Intro\n- ', 0, 8, true)).toBe(6);
        expect(nextCut('Intro\n- one two', 0, 9, false)).toBe(12);
        expect(nextCut('Intro\n---', 0, 9, true)).toBe(6);
        expect(nextCut('Intro\n---\nNext ', 0, 10, false)).toBe(10);
        expect(nextCut('Intro\n## ', 0, 9, true)).toBe(6);
        expect(nextCut('Intro\n12. ', 0, 9, true)).toBe(6);
    });

    it('holds a fence or table line until it ends', () => {
        expect(nextCut('Intro\n```sql ', 0, 12, true)).toBe(6);
        expect(nextCut('Intro\n```sql\nSELECT ', 0, 12, false)).toBe(13);
        expect(nextCut('Intro\n```sql\nSELECT ', 13, 14, false)).toBe(20);
        expect(nextCut('Intro\n| a | b |', 0, 12, true)).toBe(6);
        expect(nextCut('Intro\n| a | b |\n', 0, 12, false)).toBe(16);
    });

    it('cuts a long run with no space every 24 characters', () => {
        const run = 'x'.repeat(60);
        expect(nextCut(run, 0, 1, false)).toBe(24);
        expect(nextCut(run, 24, 25, false)).toBe(48);
        expect(nextCut(run, 48, 49, false)).toBe(48);
    });

    it('never cuts between the halves of a surrogate pair', () => {
        const run = `${'x'.repeat(23)}😀${'x'.repeat(10)}`;
        expect(nextCut(run, 0, 1, false)).toBe(0);
    });
});

describe('createPacedText', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function paced(initial?: string) {
        const releases: Array<{ text: string; at: number }> = [];
        const start = Date.now();
        const text = createPacedText({
            ...(initial === undefined ? {} : { initial }),
            onRelease: (shown) => releases.push({ text: shown, at: Date.now() - start }),
        });
        return { text, releases };
    }

    /** Streams `full` in pieces of `size` characters, one every `everyMs`. */
    function stream(text: { push(text: string): void }, full: string, size: number, everyMs: number) {
        for (let end = size; end < full.length + size; end += size) {
            text.push(full.slice(0, Math.min(end, full.length)));
            vi.advanceTimersByTime(everyMs);
        }
    }

    it('shows a paragraph a few words at a time, before it ends (CB-365)', () => {
        const { text, releases } = paced();
        // A model's tokens: about four characters every 30 ms.
        stream(text, PARAGRAPH, 4, 30);
        const beforeEnd = releases.filter((release) => release.text.length < PARAGRAPH.length);
        expect(beforeEnd.length).toBeGreaterThanOrEqual(10);
        for (const release of beforeEnd) {
            expect(PARAGRAPH.startsWith(release.text)).toBe(true);
            // Whole words: each release ends after a space.
            expect(release.text).toMatch(/ $/);
        }
        // No release adds more than a few words at once.
        const sizes = releases.map((release, index) => release.text.length - (releases[index - 1]?.text.length ?? 0));
        expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
        vi.advanceTimersByTime(PACED_TEXT_QUIET_MS);
        expect(text.shown).toBe(PARAGRAPH);
    });

    it('releases at most every tick however fast the deltas come', () => {
        const { text, releases } = paced();
        stream(text, PARAGRAPH.repeat(4), 1, 2);
        const gaps = releases.slice(1).map((release, index) => release.at - releases[index]!.at);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(PACED_TEXT_TICK_MS);
    });

    it('drains a burst over several releases at a steady pace', () => {
        const { text, releases } = paced();
        text.push('Hi ');
        expect(releases).toEqual([{ text: 'Hi ', at: 0 }]);
        vi.advanceTimersByTime(PACED_TEXT_TICK_MS);
        text.push(`Hi ${PARAGRAPH}\n\n`);
        vi.advanceTimersByTime(1_000);
        const burst = releases.slice(1);
        expect(burst.length).toBeGreaterThanOrEqual(4);
        expect(burst.at(-1)!.text).toBe(`Hi ${PARAGRAPH}\n\n`);
        expect(burst.at(-1)!.at - burst[0]!.at).toBeLessThanOrEqual(10 * PACED_TEXT_TICK_MS);
    });

    it('shows a word still being written once the deltas pause', () => {
        const { text } = paced();
        text.push('Let me check');
        expect(text.shown).toBe('Let ');
        vi.advanceTimersByTime(PACED_TEXT_TICK_MS);
        expect(text.shown).toBe('Let me ');
        vi.advanceTimersByTime(PACED_TEXT_QUIET_MS - PACED_TEXT_TICK_MS - 1);
        expect(text.shown).toBe('Let me ');
        vi.advanceTimersByTime(1);
        expect(text.shown).toBe('Let me check');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('a push brings the release forward from a wait for the pause', () => {
        const { text } = paced();
        text.push('Let');
        expect(text.shown).toBe('');
        vi.advanceTimersByTime(PACED_TEXT_TICK_MS);
        // Waiting for the pause; the next word comes first and shows at once.
        text.push('Let me ');
        expect(text.shown).toBe('Let ');
    });

    it('shows a reply first seen with much text at once (opened mid-stream)', () => {
        const long = `${PARAGRAPH}\n\n${PARAGRAPH}\n\n${PARAGRAPH}\n\n${PARAGRAPH} and on`;
        expect(long.length).toBeGreaterThan(PACED_TEXT_CATCH_UP_CHARS);
        const { text, releases } = paced();
        text.push(long);
        expect(releases).toEqual([{ text: long.slice(0, -2), at: 0 }]);
    });

    it('shows a prefix of what came at every release, and exactly the text at the end', () => {
        // Random pieces at random times, a few seeds.
        for (let seed = 1; seed <= 20; seed++) {
            let state = seed;
            const random = () => {
                state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
                return state / 2 ** 31;
            };
            const { text, releases } = paced();
            let end = 0;
            let latest = '';
            const seen: string[] = [];
            while (end < REPLY.length) {
                end = Math.min(REPLY.length, end + 1 + Math.floor(random() * 12));
                latest = REPLY.slice(0, end);
                text.push(latest);
                const before = releases.length;
                vi.advanceTimersByTime(Math.floor(random() * 80));
                for (const release of releases.slice(before)) {
                    seen.push(release.text);
                }
                for (const release of releases) {
                    expect(latest.startsWith(release.text)).toBe(true);
                }
            }
            vi.advanceTimersByTime(PACED_TEXT_QUIET_MS);
            text.finish();
            const shown = releases.map((release) => release.text);
            // Growing, never back, never the same twice.
            for (let index = 1; index < shown.length; index++) {
                expect(shown[index]!.startsWith(shown[index - 1]!)).toBe(true);
                expect(shown[index]!.length).toBeGreaterThan(shown[index - 1]!.length);
            }
            for (const release of shown.slice(0, -1)) {
                expect(flashes(release, REPLY)).toBeNull();
            }
            expect(text.shown).toBe(REPLY);
            expect(shown.at(-1)).toBe(REPLY);
        }
    });

    it('shows the full text on finish, open fence and half word included', () => {
        const { text, releases } = paced();
        text.push('A.\n\n');
        text.push('A.\n\nB.\n\n```ts\nx(');
        text.finish();
        expect(releases.map((release) => release.text).at(-1)).toBe('A.\n\nB.\n\n```ts\nx(');
        expect(vi.getTimerCount()).toBe(0);
        const count = releases.length;
        text.push('A.\n\nB.\n\n```ts\nx()\n```\n');
        text.finish();
        vi.advanceTimersByTime(PACED_TEXT_TICK_MS);
        expect(releases).toHaveLength(count);
        expect(text.shown).toBe('A.\n\nB.\n\n```ts\nx(');
    });

    it('finishes without a release when everything is shown', () => {
        const { text, releases } = paced();
        text.push('A. ');
        text.finish();
        expect(releases).toHaveLength(1);
    });

    it('shows nothing more once disposed', () => {
        const { text, releases } = paced();
        text.push('A. ');
        text.push('A. B. C. ');
        text.dispose();
        vi.advanceTimersByTime(PACED_TEXT_QUIET_MS);
        text.push('A. B. C. D. ');
        text.finish();
        expect(releases).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('starts from text already shown', () => {
        const { text, releases } = paced('A.\n\n');
        expect(text.shown).toBe('A.\n\n');
        text.push('A.\n\nB');
        expect(releases).toEqual([]);
        text.push('A.\n\nB. ');
        expect(releases).toEqual([{ text: 'A.\n\nB. ', at: 0 }]);
    });

    it('starts again at once from text that isn’t the shown text grown', () => {
        const { text } = paced();
        text.push('One two ');
        vi.advanceTimersByTime(PACED_TEXT_TICK_MS);
        text.push('Other words here ');
        expect(text.shown).toBe('Other words here ');
    });
});
