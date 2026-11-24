// Testing only: the fake model's scripts for the native app's chats,
// served by serve-fake-model.ts when a turn's last user message mentions:
//
// - "smoke review": a `review_space_page` call (the page review sheet), then
//   an answer that says what the person decided;
// - "smoke 20k": a Markdown answer of about 20,000 characters (headings,
//   tables, lists, closed fences, and an unclosed fence at the end), sent in
//   slices of SMOKE_20K_SLICE characters every SMOKE_20K_INTERVAL_MS
//   (scrolling and frame rate while a long answer streams);
// - "smoke slow-stream": one short line a second for 60 s (a request still
//   in flight when the app goes to the background, is locked or is stopped).
//
// Pure data, so tests can read each script without starting the server.

/** The draft the "smoke review" turn asks the person to review. */
export const smokeReviewDraft = {
    title: 'Smoke review',
    content: [
        '# Smoke review',
        '',
        'A draft from the fake model, to be saved or skipped.',
        '',
        '- It has a list',
        '- and **bold** text.',
    ].join('\n'),
    // The default Space: the server picks it on save.
    spaceId: null,
};

/**
 * The answer after the review's result: the card's or the sheet's answer
 * (saved or declined). The `skipped` branch is synthetic-only, reached only
 * when a test hands it a `{ skipped: true }` result directly. Through the real
 * server it can't happen: when the person sends a new message instead,
 * `withReviewsClosed()` puts the skipped result before that message, and the
 * fake model reads only what follows the last user message.
 */
export function smokeReviewAnswer(result: unknown): string {
    let parsed: { approved?: unknown; skipped?: unknown; url?: unknown } = {};
    try {
        parsed = typeof result === 'string' ? JSON.parse(result) : ((result ?? {}) as typeof parsed);
    } catch {
        // A result that isn't JSON counts as declined.
    }
    if (parsed.approved === true) {
        return typeof parsed.url === 'string'
            ? `Saved the review as [Smoke review](${parsed.url}).`
            : 'Saved the review.';
    }
    if (parsed.skipped === true) {
        return 'The review closed without an answer: nothing was saved.';
    }
    return 'Not saved: you declined the draft.';
}

/** The 20k answer's slice size (characters) and the time between slices. */
export const SMOKE_20K_SLICE = 250;
export const SMOKE_20K_INTERVAL_MS = 50;
/** The answer's minimum length before its unclosed tail. */
const SMOKE_20K_LENGTH = 20_000;

function smoke20kSection(index: number): string {
    const n = index + 1;
    return [
        `## Section ${n}`,
        `Section ${n} of the long answer. It has a paragraph with \`inline code\`, a [link](https://example.test/section/${n}) and **bold** text, then a table, two lists and a closed code block.`,
        [
            '| Item | Count | Price | Note |',
            '| --- | ---: | ---: | --- |',
            ...Array.from(
                { length: 5 },
                (_, row) =>
                    `| item ${n}.${row + 1} | ${(n * 7 + row * 3) % 50} | ${((n + row) * 1.25).toFixed(2)} | row ${row + 1} |`,
            ),
        ].join('\n'),
        [
            `- the first point of section ${n}`,
            '- a second point',
            '  - a nested point under it',
            '  - and another',
            '- a third point',
        ].join('\n'),
        ['1. Step one', '2. Step two', '3. Step three'].join('\n'),
        [
            '```ts',
            `export function section${n}(items: number[]): number {`,
            '    return items.reduce((sum, item) => sum + item, 0);',
            '}',
            '```',
        ].join('\n'),
    ].join('\n\n');
}

/** The "smoke 20k" answer: whole sections to 20,000 characters, then an unclosed fence. */
export function smoke20kAnswer(): string {
    const sections = ['# A 20k answer'];
    let length = sections[0]!.length;
    for (let index = 0; length < SMOKE_20K_LENGTH; index++) {
        const section = smoke20kSection(index);
        sections.push(section);
        length += section.length + 2;
    }
    sections.push(
        [
            '## Cut off',
            'The answer ends inside a code block, as one cut off at its limit would.',
            '```sql\nSELECT item, count\nFROM smoke_items\nWHERE count > 10',
        ].join('\n\n'),
    );
    return sections.join('\n\n');
}

/** The "smoke 20k" answer in fixed slices, one per SMOKE_20K_INTERVAL_MS. */
export function smoke20kParts(): string[] {
    const answer = smoke20kAnswer();
    const parts: string[] = [];
    for (let start = 0; start < answer.length; start += SMOKE_20K_SLICE) {
        parts.push(answer.slice(start, start + SMOKE_20K_SLICE));
    }
    return parts;
}

/** "smoke slow-stream": one line a second, the last at 60 s. */
export const SMOKE_SLOW_INTERVAL_MS = 1_000;
export function smokeSlowParts(): string[] {
    return Array.from({ length: 60 }, (_, index) =>
        index === 59 ? 'Second 60. Done streaming slowly.' : `Second ${index + 1}.${(index + 1) % 10 ? ' ' : '\n\n'}`,
    );
}
