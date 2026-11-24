// @vitest-environment jsdom
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bridgeExtensions } from '../../editor/bridges';
import { editorExtensions, editorProps } from '../../editor/extensions';
import { attachPageSession, receiveForEditor } from '../../editor/page-bridge';
import { PageImages } from '../../editor/page-images';
import {
    compareText,
    type CorpusDocument,
    type CorpusResult,
    CorpusRunner,
    describeResult,
    firstDifferentLine,
} from '../../src/editor/corpus';
import { EDITOR_CORPUS } from '../../src/editor/generated/editor-corpus';
import { createEditorSession } from '../../src/editor/session';
import type { EditorText } from '../../src/sync/page-drafts';

import { richRoundTrip, type WebAnswer, webFailureKind, webRoundTrip } from './web-path';

// The Markdown round trip against the web. Every corpus document goes through the web's
// editor (web-path.ts: RichEditor's own path) and through the app's: the
// WebView's session on a real editor, driven by the device route's runner.
// Both must give the same bytes, the same `inspectMarkdown` verdict, no
// change on opening, and the same text after an edit and its undo.
//
// The web's answers are Node's goldens, written into
// src/editor/generated/editor-corpus.ts for the device route
// (screens/editor-corpus.tsx). After a change to the corpus, the web's
// editor, Tiptap or tentap, write them again:
//
//   pnpm --filter @socio/mobile exec vitest run tests/editor/roundtrip.test.ts -u
//
// The live corpus (SOCIO_PAGES_CORPUS, a folder the export script fills from
// the smoke account; never in CI) runs the same checks; its failures name a
// hash of the path and a line number, never the text. The web's answers are
// worked out page by page: a page whose web path throws is recorded (its hash
// and a sanitized kind), the rest go on to device-corpus.json, and the test
// fails at the end listing those pages.
//
// A page `inspectMarkdown` refuses (images, HTML, extended Markdown) opens in
// Markdown source on the web and in the app: its golden is the stored text,
// and the app is held to the same verdict, source mode and no change, not to
// a rich round trip, which the rich editor can't make (a paragraph holding
// only an image throws in it; a linked one loses the picture).

const app = join(import.meta.dirname, '../..');
const CORPUS = join(app, 'tests/fixtures/pages-corpus');
const GENERATED = join(app, 'src/editor/generated/editor-corpus.ts');

const corpusFiles = (folder: string) =>
    readdirSync(folder, { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.md'))
        .sort();

/** The web's answers for one stored page, as the device compares them. */
function golden(name: string, markdown: string, web: (stored: string) => WebAnswer = webRoundTrip): CorpusDocument {
    const answer = web(markdown);
    return {
        name,
        markdown,
        golden: answer.markdown,
        supported: answer.supported,
        reason: answer.reason,
        edited: answer.supported ? answer.edited : null,
    };
}

/** A live page's name: a hash of its path, so nothing about the page is printed or sent to a device. */
const liveName = (path: string) => `live-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

/**
 * The WebView's session on a real editor under jsdom, every message through
 * JSON, driven by the device route's runner. tentap's CoreBridge is played
 * here as its handlers run (Focus, InsertContent).
 */
function runner() {
    const images = new PageImages();
    const editor = new Editor({
        extensions: [...bridgeExtensions(), ...editorExtensions(images)],
        editorProps: editorProps(() => {}),
        injectCSS: false,
    });
    editors.push(editor);
    let now = 1_000;
    let timers: { at: number; run: () => void; id: number }[] = [];
    let ids = 0;
    const setTimer = (run: () => void, ms: number) => {
        ids += 1;
        timers.push({ at: now + ms, run, id: ids });
        return ids;
    };
    const clearTimer = (id: unknown) => {
        timers = timers.filter((timer) => timer.id !== id);
    };
    const advance = (ms: number) => {
        now += ms;
        const due = timers.filter((timer) => timer.at <= now);
        timers = timers.filter((timer) => timer.at > now);
        due.forEach((timer) => timer.run());
    };
    const run = new CorpusRunner({ sleep: async (ms) => advance(ms), setTimer, clearTimer });
    run.connect({
        send: (message) => receiveForEditor(editor, JSON.parse(JSON.stringify(message))),
        focusEnd: () => editor.commands.focus('end'),
        insert: (text) =>
            editor.chain().focus().insertContent(text, { parseOptions: editor.options.parseOptions }).run(),
    });
    attachPageSession(editor, (message) => run.receive(JSON.parse(JSON.stringify(message))), images, {
        isComposing: () => false,
        now: () => now,
        setTimer,
        clearTimer,
    });
    return run;
}

/**
 * The page editor's native session (src/editor/session.ts) on the WebView's session under jsdom,
 * opening `markdown` as a page's draft: what the person sees (rich or source) and every change it
 * hands the draft.
 */
function openInApp(markdown: string) {
    const images = new PageImages();
    const editor = new Editor({
        extensions: [...bridgeExtensions(), ...editorExtensions(images)],
        editorProps: editorProps(() => {}),
        injectCSS: false,
    });
    editors.push(editor);
    const changes: EditorText[] = [];
    const draft = { spaceId: 's1', revision: 1, title: 'Page', content: markdown };
    // Timers that never fire: opening must settle without them.
    const setTimer = () => 0;
    const clearTimer = () => {};
    const session = createEditorSession({
        draft: {
            read: () => draft,
            error: () => undefined,
            change: (text) => changes.push(text),
            flush: async () => {},
            close: async () => {},
            onReplace: () => () => {},
        },
        appearance: { fontScale: 1, tokens: {} },
        setTimer,
        clearTimer,
    });
    attachPageSession(editor, (message) => session.receive(JSON.parse(JSON.stringify(message))), images, {
        isComposing: () => false,
        now: () => 1_000,
        setTimer,
        clearTimer,
    });
    session.connect((message) => receiveForEditor(editor, JSON.parse(JSON.stringify(message))));
    session.ready();
    return { view: session.view(), changes };
}

/** The generated module, formatted as the root's oxfmt leaves it. */
function generatedModule(documents: readonly CorpusDocument[]) {
    const text = `// Generated by apps/mobile/tests/editor/roundtrip.test.ts from apps/mobile/tests/fixtures/pages-corpus/.
// Don't edit: run \`pnpm --filter @socio/mobile exec vitest run tests/editor/roundtrip.test.ts -u\`
// after a change there, to the web's page editor, or to Tiptap or tentap, and commit the result.
// oxlint-disable

import type { CorpusDocument } from '../corpus';

/**
 * The synthetic corpus with the web's answers for each document (Node's goldens: the web's
 * editor under jsdom), for the development and preview \`EditorCorpus\` route.
 */
export const EDITOR_CORPUS: readonly CorpusDocument[] = ${JSON.stringify(documents)};
`;
    const formatted = spawnSync(join(app, '../../node_modules/.bin/oxfmt'), [`--stdin-filepath=${GENERATED}`], {
        input: text,
        encoding: 'utf8',
    });
    if (formatted.status !== 0) {
        throw new Error(`oxfmt failed: ${formatted.stderr}`);
    }
    return formatted.stdout;
}

describe('the Markdown round trip against the web', () => {
    const files = corpusFiles(CORPUS);
    const documents = files.map((file) => golden(file, readFileSync(join(CORPUS, file), 'utf8')));

    it('has a corpus with every kind of document', () => {
        expect(files.length).toBeGreaterThanOrEqual(20);
        const all = documents.map((document) => document.markdown).join('\n');
        for (const needle of [
            '\r\n',
            '  \n',
            '```embed',
            '```dataset-view',
            '```image',
            '~~~',
            '    indented',
            '<p>',
            '\n![',
            '\n[![',
        ]) {
            expect(all, needle).toContain(needle);
        }
        // Source-mode documents, which the rich editor can't keep.
        expect(documents.filter((document) => !document.supported).length).toBeGreaterThanOrEqual(5);
        expect(documents.filter((document) => document.supported).length).toBeGreaterThanOrEqual(15);
    });

    it('the web opens each document the same both ways, with no update, and its undo gives the golden back', () => {
        for (const file of files) {
            const web = webRoundTrip(readFileSync(join(CORPUS, file), 'utf8'));
            expect(web.reloaded, file).toBe(web.markdown);
            expect(web.undone, file).toBe(web.markdown);
            expect(web.openUpdates, file).toBe(0);
        }
    });

    it('a refused document opens in source on both sides: the web keeps its text, the app shows it as source and changes nothing', () => {
        const refused = documents.filter((document) => !document.supported);
        for (const document of refused) {
            expect(document, document.name).toMatchObject({ golden: document.markdown, edited: null });
            const app = openInApp(document.markdown);
            expect(app.view, document.name).toMatchObject({
                mode: 'source',
                sourceReason: document.reason,
                text: { content: document.markdown },
            });
            expect(app.changes, document.name).toEqual([]);
        }
        // And a page the web opens rich opens rich in the app too.
        expect(openInApp('# One\n\nSome text.\n').view.mode).toBe('rich');
    });

    it('an image-only paragraph must not reach the rich editor: a bare image throws, a linked one loses its picture', () => {
        const alone = documents.find((document) => document.name === 'source-image-alone.md')!;
        const linked = documents.find((document) => document.name === 'source-image-linked.md')!;
        for (const document of [alone, linked]) {
            expect(document.supported, document.name).toBe(false);
            expect(document.reason, document.name).toMatch(/images/);
        }
        let thrown: unknown;
        try {
            richRoundTrip(alone.markdown);
        } catch (error) {
            thrown = error;
        }
        expect(webFailureKind(thrown)).toBe('invalid-content');
        const rich = richRoundTrip(linked.markdown);
        expect(linked.markdown).toContain('.png');
        expect(rich.markdown).not.toContain('.png');
    });

    it("writes the web's answers for the device route", async () => {
        await expect(generatedModule(documents)).toMatchFileSnapshot(GENERATED);
        expect(EDITOR_CORPUS.map((document) => document.name)).toEqual(files);
    });

    it('the app’s editor gives the web’s bytes, verdict, edit and undo for every document', async () => {
        const results = await runner().run(documents);
        const failed = results.filter((result) => !result.ok).map(describeResult);
        expect(failed).toEqual([]);
        expect(results).toHaveLength(files.length);
    });

    it('the runner names where a document differs, and a live document without its text', async () => {
        const [first] = documents.filter((document) => document.supported && document.golden.includes('\n'));
        const wrong = { ...first!, golden: first!.golden.replace(/\n[^\n]*$/, '\nnot the web') };
        const [result] = await runner().run([wrong]);
        expect(result).toMatchObject({ ok: false, step: 'load', expected: 'not the web' });
        expect(result!.line).toBe(firstDifferentLine(wrong.golden, first!.golden));
        const [live] = await runner().run([{ ...wrong, name: liveName('Space/Page.md') }], true);
        expect(live).toEqual({ ok: false, name: liveName('Space/Page.md'), step: 'load', line: result!.line });
        expect(describeResult(live!)).not.toContain('not the web');
    });

    it('a document whose driving throws is that document’s failure, and the rest still run', async () => {
        const run = new CorpusRunner({
            sleep: async () => {},
            setTimer: () => 0,
            clearTimer: () => {},
        });
        await expect(run.run(documents.slice(0, 1))).rejects.toThrow(/no editor/);
        const [good] = documents.filter((document) => !document.supported);
        run.connect({
            send: (message) => {
                if (message.type === 'socio-load' && message.payload.markdown.includes('zebra')) {
                    throw new RangeError('Called contentMatchAt on a node with invalid content: zebra');
                }
                if (message.type === 'socio-load') {
                    const { supported, reason } = good!;
                    run.receive({
                        type: 'socio-loaded',
                        payload: { markdown: message.payload.markdown, version: 1, supported, reason },
                    });
                }
            },
            focusEnd: () => {},
            insert: () => {},
        });
        const zebra = { ...good!, name: liveName('Space/Zebra.md'), markdown: 'the zebra page' };
        const results = await run.run([zebra, good!], true);
        expect(results).toEqual([
            { name: zebra.name, ok: false, step: 'threw' },
            { name: good!.name, ok: true },
        ]);
        expect(results.map(describeResult).join('\n')).not.toContain('zebra');
    });

    it('finds the first different line, a lone carriage return included', () => {
        expect(firstDifferentLine('a\nb', 'a\nb')).toBeNull();
        expect(firstDifferentLine('a\nb', 'a\nc')).toBe(2);
        expect(firstDifferentLine('a\nb', 'a\nb\nc')).toBe(3);
        expect(firstDifferentLine('a\r\nb', 'a\nb')).toBe(1);
        expect(compareText('x', 'edit', 'a', 'a', true)).toBeNull();
        expect(compareText('x', 'edit', 'a', 'b', true)).toEqual({ name: 'x', ok: false, step: 'edit', line: 1 });
    });
});

const LIVE = process.env.SOCIO_PAGES_CORPUS;
const DEVICE_FILE = 'device-corpus.json';

/** A live page the web path couldn't process: its hashed name and why, never its text. */
interface Unprocessed {
    readonly name: string;
    readonly kind: string;
}

interface LiveCorpus {
    /** Every exported page. */
    readonly pages: number;
    /** The pages the web path processed, with its answers: what device-corpus.json holds. */
    readonly documents: CorpusDocument[];
    /** The pages it couldn't. */
    readonly unprocessed: Unprocessed[];
}

/**
 * The live corpus's documents (`<spaceId>/<pageId>.md`, as the export writes them) with
 * the web's answers, page by page: a page whose web path throws is recorded and the rest
 * go on. Those that worked are written to device-corpus.json for the device route (the
 * hashed names, the pages and the answers, readable only by this account), so the device
 * half can run. The old payload goes first; a folder with no pages writes none and
 * throws, so an asked-for live run can't pass on the synthetic documents alone, and
 * neither does a run where no page worked.
 */
function liveDocuments(folder: string, web: (stored: string) => WebAnswer = webRoundTrip): LiveCorpus {
    const device = join(folder, DEVICE_FILE);
    rmSync(device, { force: true });
    const files = corpusFiles(folder).filter((file) => file.split(sep).length === 2);
    if (files.length === 0) {
        throw new Error('SOCIO_PAGES_CORPUS holds no exported pages: export them first (pages-corpus.mts export).');
    }
    const documents: CorpusDocument[] = [];
    const unprocessed: Unprocessed[] = [];
    for (const file of files) {
        const name = liveName(file);
        try {
            documents.push(golden(name, readFileSync(join(folder, file), 'utf8'), web));
        } catch (error) {
            unprocessed.push({ name, kind: webFailureKind(error) });
        }
    }
    if (documents.length > 0) {
        writeFileSync(device, JSON.stringify(documents), { mode: 0o600 });
        chmodSync(device, 0o600);
    }
    return { pages: files.length, documents, unprocessed };
}

/** A page the web path couldn't process, as the live test lists it. */
const describeUnprocessed = ({ name, kind }: Unprocessed) => `${name}: the web path threw (${kind})`;

/** The live run's summary: how many pages the web path couldn't process, then how the rest compared. */
function liveSummary(live: LiveCorpus, results: readonly CorpusResult[]) {
    const differ = results.filter((result) => !result.ok).length;
    const compared =
        results.length === 0
            ? 'none compared'
            : differ === 0
              ? `${results.length} compared, all equal`
              : `${results.length} compared, ${differ} differ`;
    const skipped = live.unprocessed.length === 0 ? '' : `, ${live.unprocessed.length} the web path couldn’t process`;
    return `live corpus: ${live.pages} pages${skipped}; ${compared}`;
}

describe('the live corpus’s payload', () => {
    let folder: string;
    beforeEach(() => {
        folder = mkdtempSync(join(tmpdir(), 'live-corpus-'));
    });
    afterEach(() => rmSync(folder, { recursive: true, force: true }));

    it('refuses an empty live corpus, writes no payload and deletes an old one', () => {
        writeFileSync(join(folder, DEVICE_FILE), '[{"stale":true}]');
        mkdirSync(join(folder, 'space-1'));
        expect(() => liveDocuments(folder)).toThrow(/no exported pages/);
        expect(existsSync(join(folder, DEVICE_FILE))).toBe(false);
    });

    it('writes the exported pages, by hashed name, and nothing else', () => {
        mkdirSync(join(folder, 'space-1'));
        writeFileSync(join(folder, 'space-1', 'page-1.md'), '# One\n');
        writeFileSync(join(folder, 'stray.md'), '# Not a page\n');
        const { documents, unprocessed, pages } = liveDocuments(folder);
        expect(pages).toBe(1);
        expect(unprocessed).toEqual([]);
        expect(documents.map((document) => document.name)).toEqual([liveName(join('space-1', 'page-1.md'))]);
        const payload = JSON.parse(readFileSync(join(folder, DEVICE_FILE), 'utf8')) as CorpusDocument[];
        expect(payload).toEqual(documents);
    });

    it('opens a page the web refuses in source mode on both sides: an image-only paragraph is no web-path failure', async () => {
        // A paragraph that is only an image, last: the rich editor's parse would leave bare text
        // under the doc and throw in the trailing-node plugin, but the web never runs it here.
        const lone = 'Intro of the zebra page\n\n![Zebra diagram](https://example.invalid/zebra.png)\n';
        const web = webRoundTrip(lone);
        expect(web).toMatchObject({ markdown: lone, supported: false, openUpdates: 0 });
        expect(web.reason).toMatch(/images/);

        mkdirSync(join(folder, 'space-1'));
        writeFileSync(join(folder, 'space-1', 'a-good.md'), '# One\n\nSome text.\n');
        writeFileSync(join(folder, 'space-1', 'b-image.md'), lone);
        const live = liveDocuments(folder);
        expect(live.unprocessed).toEqual([]);
        const image = live.documents.find((document) => document.name === liveName(join('space-1', 'b-image.md')));
        expect(image).toMatchObject({ golden: lone, supported: false, edited: null });

        // The app reports it unsupported too, so the device's run compares it as equal.
        const results = await runner().run(live.documents, true);
        expect(results.map(describeResult)).toEqual(live.documents.map((document) => `${document.name}: equal`));
        expect(liveSummary(live, results)).toBe('live corpus: 2 pages; 2 compared, all equal');
    });

    it('records a page the web path still throws on and goes on: the rest reach the payload, the page’s text nowhere', () => {
        mkdirSync(join(folder, 'space-1'));
        writeFileSync(join(folder, 'space-1', 'a-good.md'), '# One\n\nSome text.\n');
        writeFileSync(join(folder, 'space-1', 'b-zebra.md'), '# The zebra page\n');
        writeFileSync(join(folder, 'space-1', 'c-good.md'), '- a list\n');
        // ProseMirror's own words for a doc its schema refuses, as the live run first met them.
        const web = (stored: string): WebAnswer => {
            if (stored.includes('zebra')) {
                throw new RangeError('Called contentMatchAt on a node with invalid content');
            }
            return webRoundTrip(stored);
        };

        const live = liveDocuments(folder, web);
        expect(live.pages).toBe(3);
        expect(live.unprocessed).toEqual([{ name: liveName(join('space-1', 'b-zebra.md')), kind: 'invalid-content' }]);
        expect(live.documents.map((document) => document.name)).toEqual([
            liveName(join('space-1', 'a-good.md')),
            liveName(join('space-1', 'c-good.md')),
        ]);
        const payload = readFileSync(join(folder, DEVICE_FILE), 'utf8');
        expect(JSON.parse(payload)).toEqual(live.documents);
        const reported = [...live.unprocessed.map(describeUnprocessed), liveSummary(live, [])].join('\n');
        for (const text of [payload, reported]) {
            expect(text).not.toContain('zebra');
        }
        expect(liveSummary(live, [])).toBe('live corpus: 3 pages, 1 the web path couldn’t process; none compared');
    });

    it('words an injected failure by its plain name, never its message', () => {
        mkdirSync(join(folder, 'space-1'));
        writeFileSync(join(folder, 'space-1', 'p1.md'), '# One\n');
        writeFileSync(join(folder, 'space-1', 'p2.md'), '# Two\n');
        writeFileSync(join(folder, 'space-1', 'p3.md'), '# Three\n');
        const odd = new Error('the page says Three');
        odd.name = 'Page: Three';
        const web = (stored: string): WebAnswer => {
            if (stored.includes('Two')) {
                throw new RangeError(`can't place "${stored}"`);
            }
            if (stored.includes('Three')) {
                throw odd;
            }
            return webRoundTrip(stored);
        };
        const live = liveDocuments(folder, web);
        expect(live.unprocessed).toEqual([
            { name: liveName(join('space-1', 'p2.md')), kind: 'RangeError' },
            { name: liveName(join('space-1', 'p3.md')), kind: 'unknown' },
        ]);
        expect(live.documents.map((document) => document.name)).toEqual([liveName(join('space-1', 'p1.md'))]);
        expect(JSON.stringify(live.unprocessed)).not.toMatch(/Two|Three/);
        expect(liveSummary(live, [{ name: live.documents[0]!.name, ok: true }])).toBe(
            'live corpus: 3 pages, 2 the web path couldn’t process; 1 compared, all equal',
        );
    });

    it('writes no payload when the web path processed no page', () => {
        writeFileSync(join(folder, DEVICE_FILE), '[{"stale":true}]');
        mkdirSync(join(folder, 'space-1'));
        writeFileSync(join(folder, 'space-1', 'p1.md'), '# One\n');
        const live = liveDocuments(folder, () => {
            throw new TypeError('no');
        });
        expect(live).toEqual({
            pages: 1,
            documents: [],
            unprocessed: [{ name: expect.any(String), kind: 'TypeError' }],
        });
        expect(existsSync(join(folder, DEVICE_FILE))).toBe(false);
    });
});

describe.runIf(LIVE)('the live corpus against the web', () => {
    it('gives the web’s bytes, verdict, edit and undo for every exported page', async () => {
        const live = liveDocuments(LIVE!);
        const results = live.documents.length > 0 ? await runner().run(live.documents, true) : [];
        const summary = liveSummary(live, results);
        console.log(summary);
        // Only hashes, kinds and line numbers: a live failure never prints the page's text.
        const failed = [
            ...live.unprocessed.map(describeUnprocessed),
            ...results.filter((result) => !result.ok).map(describeResult),
        ];
        expect(failed, summary).toEqual([]);
        expect(results).toHaveLength(live.pages);
    });
});
