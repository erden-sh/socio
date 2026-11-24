import { describe, expect, it } from 'vitest';

import type { CorpusDocument } from '../../src/editor/corpus';
import {
    LIVE_CORPUS_PROBLEMS,
    type LiveCorpusFile,
    runCorpusSession,
    runSummary,
    takeLiveCorpusFrom,
    unexpectedProblem,
} from '../../src/editor/live-corpus';

// The live corpus on the device (src/editor/live-corpus.ts):
// only a missing file is "none"; a file that can't be read, isn't a corpus or
// won't delete fails the run, in words that hold no page text, file contents
// or names.

const PAGE_TEXT = 'Quarterly plan for Acme: confidential';
const DOCUMENT: CorpusDocument = {
    name: 'live/3f2a9c',
    markdown: PAGE_TEXT,
    golden: PAGE_TEXT,
    supported: true,
    reason: null,
    edited: `${PAGE_TEXT}\n\nTyped on the phone.`,
};

/** A file in memory; `fail` makes a step throw an error that carries the page's text. */
function fakeFile(content: string | null, fail: { read?: boolean; delete?: 'throws' | 'stays'; check?: boolean } = {}) {
    let there = content !== null;
    const file: LiveCorpusFile & { readonly there: boolean } = {
        get exists() {
            if (fail.check) {
                throw new Error(`stat failed for ${PAGE_TEXT}`);
            }
            return there;
        },
        get there() {
            return there;
        },
        text: async () => {
            if (fail.read) {
                throw new Error(`read failed: ${PAGE_TEXT}`);
            }
            return content!;
        },
        delete: () => {
            if (fail.delete === 'throws') {
                throw new Error(`delete failed: ${PAGE_TEXT}`);
            }
            if (fail.delete !== 'stays') {
                there = false;
            }
        },
    };
    return file;
}

function expectSanitized(problem: string) {
    expect(problem).not.toContain(PAGE_TEXT);
    expect(problem).not.toContain('Acme');
    expect(problem).not.toContain(DOCUMENT.name);
}

describe('taking the live corpus', () => {
    it('is none when no file was copied in', async () => {
        expect(await takeLiveCorpusFrom(fakeFile(null))).toEqual({ kind: 'none' });
    });

    it('takes a valid corpus and deletes it', async () => {
        const file = fakeFile(JSON.stringify([DOCUMENT]));
        expect(await takeLiveCorpusFrom(file)).toEqual({ kind: 'taken', documents: [DOCUMENT] });
        expect(file.there).toBe(false);
    });

    it('fails on a file it can’t read, and deletes it', async () => {
        const file = fakeFile(JSON.stringify([DOCUMENT]), { read: true });
        const taken = await takeLiveCorpusFrom(file);
        expect(taken).toEqual({ kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.read });
        expect(file.there).toBe(false);
    });

    it('fails on a truncated or invalid file, and deletes it', async () => {
        for (const content of [
            JSON.stringify([DOCUMENT]).slice(0, 40),
            JSON.stringify([{ ...DOCUMENT, extra: PAGE_TEXT }]),
            '',
        ]) {
            const file = fakeFile(content);
            const taken = await takeLiveCorpusFrom(file);
            expect(taken).toEqual({ kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.invalid });
            expect(file.there).toBe(false);
        }
    });

    it('fails when the delete throws or leaves the file, even after a good read', async () => {
        for (const mode of ['throws', 'stays'] as const) {
            const file = fakeFile(JSON.stringify([DOCUMENT]), { delete: mode });
            const taken = await takeLiveCorpusFrom(file);
            expect(taken).toEqual({ kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.deleted });
            expect(file.there).toBe(true);
        }
    });

    it('names the delete when both the read and the delete fail', async () => {
        const taken = await takeLiveCorpusFrom(fakeFile('{', { delete: 'throws' }));
        expect(taken).toEqual({ kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.deleted });
    });

    it('fails when it can’t tell whether a file is there', async () => {
        expect(await takeLiveCorpusFrom(fakeFile('[]', { check: true }))).toEqual({
            kind: 'failed',
            problem: LIVE_CORPUS_PROBLEMS.check,
        });
    });

    it('words every problem without page text, contents or names', () => {
        for (const problem of Object.values(LIVE_CORPUS_PROBLEMS)) {
            expectSanitized(problem);
        }
    });
});

describe('the run summary', () => {
    const passed = [{ name: 'a.md', ok: true }] as never;

    it('passes when every document matches and the live corpus didn’t fail', () => {
        expect(runSummary(passed, null)).toBe('All 1 documents match the web.');
    });

    it('fails when the live corpus failed, however the documents compared', () => {
        const summary = runSummary(passed, LIVE_CORPUS_PROBLEMS.deleted);
        expect(summary).toMatch(/^The run failed: /);
        expect(summary).not.toMatch(/^All /);
        expectSanitized(summary);
    });
});

describe('the whole run (runCorpusSession)', () => {
    const doc = (name: string): CorpusDocument => ({ ...DOCUMENT, name });
    const synthetic = [doc('a.md'), doc('b.md'), doc('c.md')];

    it('logs one line and passes when every document matches', async () => {
        const lines: string[] = [];
        const outcome = await runCorpusSession(synthetic, {
            take: async () => ({ kind: 'none' }),
            run: async (documents, _live, onResult) =>
                documents.map((document) => {
                    const result = { name: document.name, ok: true };
                    onResult(result);
                    return result;
                }),
            log: (line) => lines.push(line),
        });
        expect(outcome.stopped).toBeNull();
        expect(outcome.summary).toBe('All 3 documents match the web.');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ synthetic: 3, live: 0, failures: [] });
    });

    it('fails, names the unfinished documents and logs a sanitized line on an exception after partial progress', async () => {
        const lines: string[] = [];
        const seen: string[] = [];
        const live = [doc('live/1'), doc('live/2')];
        const outcome = await runCorpusSession(synthetic, {
            take: async () => ({ kind: 'taken', documents: live }),
            run: async (documents, _live, onResult) => {
                // Two documents compare, then the runner throws with the page's text in its message.
                for (const document of documents.slice(0, 2)) {
                    onResult({ name: document.name, ok: true });
                }
                throw new TypeError(`cannot read ${PAGE_TEXT}`);
            },
            log: (line) => lines.push(line),
            onResult: (result) => seen.push(result.name),
        });
        expect(seen).toEqual(['a.md', 'b.md']);
        expect(outcome.stopped).toEqual({
            problem: 'The run stopped on an unexpected error (TypeError).',
            unfinished: 3,
        });
        expect(outcome.summary).toMatch(/^The run failed: /);
        expect(outcome.summary).not.toMatch(/^All /);
        expect(outcome.summary).toContain('The run stopped on an unexpected error (TypeError).');
        expect(outcome.summary).toContain('3 of 5 documents didn’t finish.');
        expectSanitized(outcome.summary);
        expect(lines).toHaveLength(1);
        const logged = JSON.parse(lines[0]!);
        expect(logged).toMatchObject({
            error: true,
            problem: outcome.stopped!.problem,
            unfinished: 3,
            synthetic: 2,
            live: 0,
            summary: outcome.summary,
        });
        expect(lines[0]).not.toContain(PAGE_TEXT);
        expect(runSummary(outcome.results, null, outcome.stopped)).toBe(outcome.summary);
    });

    it('counts the whole live corpus as unfinished when taking it throws', async () => {
        const lines: string[] = [];
        const outcome = await runCorpusSession(synthetic, {
            take: async () => {
                throw new Error(PAGE_TEXT);
            },
            run: async () => [],
            log: (line) => lines.push(line),
        });
        expect(outcome.stopped).toEqual({ problem: 'The run stopped on an unexpected error (Error).', unfinished: 3 });
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(PAGE_TEXT);
    });

    it('never names an error by anything but a plain name', () => {
        const odd = new Error('x');
        odd.name = `Leak ${PAGE_TEXT}`;
        expect(unexpectedProblem(odd)).toBe('The run stopped on an unexpected error (unknown).');
        expect(unexpectedProblem('string thrown')).toBe('The run stopped on an unexpected error (unknown).');
    });
});
