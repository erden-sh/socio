import { z } from 'zod';

import { parseToNative, type ToNativeMessage, type ToWebMessage } from './bridge';

// The Markdown round trip against the web: each corpus document is
// loaded into the real editor through the bridge, read back, edited, and the
// edit undone, and each answer is compared with Node's golden, the web's own
// output for that document (tests/editor/roundtrip.test.ts writes them into
// generated/editor-corpus.ts). The development and preview `EditorCorpus`
// route runs it in the real WebView (screens/editor-corpus.tsx); the tests
// run it on the WebView's session under jsdom. No React Native here.
//
// A document the web's `inspectMarkdown` refuses opens in Markdown source on
// the web, never in the rich editor: its golden is the stored text, and the
// app is held to the same verdict (and to no change on opening), not to the
// bytes its WebView reads back, which no screen shows (source mode edits the
// draft's text).
//
// The live corpus (pages exported from the smoke account) comes with its
// paths already hashed, and a failure in it names only that hash and a line
// number, never the page's text.

/** What the edit types at the end of each document, through tentap's CoreBridge as a keyboard would. */
export const CORPUS_EDIT_TEXT = 'Typed on the phone.';

/** How long the runner waits for any one answer from the WebView. */
export const CORPUS_WAIT_MS = 5000;

/** How long after a load the runner listens for a `change` that must not come (one throttle window and some). */
export const CORPUS_QUIET_MS = 500;

/** One document and the web's answers for it (Node's golden). */
export interface CorpusDocument {
    /** The file's name under the corpus folder, or for the live corpus the hash of its path. */
    readonly name: string;
    /** The stored page, as the server keeps it. */
    readonly markdown: string;
    /** The web's `getMarkdown()` after opening it; the stored text when the web opens it in source mode. */
    readonly golden: string;
    /** The web's `inspectMarkdown` verdict: false opens Markdown source instead. */
    readonly supported: boolean;
    readonly reason: string | null;
    /** The web's Markdown after CORPUS_EDIT_TEXT is typed at the end; null when the rich editor can't keep the page. */
    readonly edited: string | null;
}

/**
 * The live corpus on a device: the round-trip test writes it (hashed names,
 * the pages and the web's answers) and the export script copies it into the
 * app's documents folder under this name. The route reads it once and
 * deletes it before it runs (README, "The Markdown round trip").
 */
export const LIVE_CORPUS_FILE = 'editor-live-corpus.json';

/** A corpus file's check: what the route takes from the documents folder. */
export const corpusDocumentsSchema = z.array(
    z.strictObject({
        name: z.string().max(200),
        markdown: z.string(),
        golden: z.string(),
        supported: z.boolean(),
        reason: z.string().nullable(),
        edited: z.string().nullable(),
    }),
);

/** Where a document went wrong: `threw` when driving the editor threw on it (no message, which may quote the page). */
export type CorpusStep = 'load' | 'verdict' | 'opened' | 'edit' | 'undo' | 'timeout' | 'threw';

export interface CorpusResult {
    readonly name: string;
    readonly ok: boolean;
    readonly step?: CorpusStep;
    /** The first line (from 1) where the editor's text differs from the golden. */
    readonly line?: number;
    /** That line in the golden and in the editor's text: synthetic documents only, never the live corpus's. */
    readonly expected?: string;
    readonly actual?: string;
}

/** The first line (from 1) where two texts differ, or null when they are equal. */
export function firstDifferentLine(expected: string, actual: string): number | null {
    if (expected === actual) {
        return null;
    }
    const a = expected.split('\n');
    const b = actual.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (a[i] !== b[i]) {
            return i + 1;
        }
    }
    // Same lines, different bytes: only possible through a `\r`, kept on its line.
    return 1;
}

/** A result for text that should equal the golden. `live` leaves the text out. */
export function compareText(name: string, step: CorpusStep, expected: string, actual: string, live: boolean) {
    const line = firstDifferentLine(expected, actual);
    if (line === null) {
        return null;
    }
    const failure: CorpusResult = { name, ok: false, step, line };
    if (live) {
        return failure;
    }
    return {
        ...failure,
        expected: expected.split('\n')[line - 1] ?? '(no line)',
        actual: actual.split('\n')[line - 1] ?? '(no line)',
    };
}

/** One line for a failure: the name and the line, and for a synthetic document both versions of it. */
export function describeResult(result: CorpusResult): string {
    if (result.ok) {
        return `${result.name}: equal`;
    }
    const where = result.line === undefined ? '' : ` at line ${result.line}`;
    const lines =
        result.expected === undefined
            ? ''
            : `\n  web:   ${JSON.stringify(result.expected)}\n  phone: ${JSON.stringify(result.actual)}`;
    return `${result.name}: ${result.step}${where}${lines}`;
}

/** What the runner drives: the page bridge, and tentap's CoreBridge for the edit. */
export interface CorpusEditor {
    send(message: ToWebMessage): void;
    /** CoreBridge's Focus with 'end': the caret at the document's end. */
    focusEnd(): void;
    /** CoreBridge's InsertContent: typed at the caret, an edit of the person's. */
    insert(text: string): void;
}

export interface CorpusTimers {
    /** Waits `ms`; a test advances its own clock instead. */
    sleep(ms: number): Promise<void>;
    setTimer(run: () => void, ms: number): unknown;
    clearTimer(id: unknown): void;
}

const realTimers: CorpusTimers = {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

class Timeout extends Error {}

const NO_EDITOR = 'The corpus runner has no editor yet.';

type Waiter = { match: (message: ToNativeMessage) => boolean; done: (message: ToNativeMessage) => void };

/**
 * Runs documents through the editor one at a time. Hand it every message
 * the WebView sends (`receive`) and the editor (`connect`); `run` answers one
 * result per document.
 */
export class CorpusRunner {
    private inbox: ToNativeMessage[] = [];
    private waiter: Waiter | null = null;
    private target: CorpusEditor | null = null;

    constructor(private readonly timers: CorpusTimers = realTimers) {}

    /** Whether `connect` has given it an editor: the route connects once, when the WebView is first ready. */
    get connected() {
        return this.target !== null;
    }

    /** The editor to drive, once its WebView is ready. */
    connect(editor: CorpusEditor) {
        this.target = editor;
    }

    private get editor(): CorpusEditor {
        if (this.target === null) {
            throw new Error(NO_EDITOR);
        }
        return this.target;
    }

    /** A message from the WebView: ours are checked as the editor's screen checks them. */
    receive(value: unknown) {
        const parsed = parseToNative(value);
        if (parsed.kind !== 'ok') {
            return;
        }
        const waiter = this.waiter;
        if (waiter?.match(parsed.message)) {
            this.waiter = null;
            waiter.done(parsed.message);
            return;
        }
        this.inbox.push(parsed.message);
    }

    /**
     * One result per document, in order. A document the editor doesn't answer in time, or whose
     * driving throws (the rich editor on content it can't hold), is that document's failure and
     * the rest still run; only a runner with no editor throws.
     */
    async run(documents: readonly CorpusDocument[], live = false, onResult?: (result: CorpusResult) => void) {
        const results: CorpusResult[] = [];
        // Before any document, so a missing editor stays the run's error, not one per document.
        if (!this.connected) {
            throw new Error(NO_EDITOR);
        }
        for (const document of documents) {
            let result: CorpusResult;
            try {
                result = await this.one(document, live);
            } catch (error) {
                this.waiter = null;
                result = { name: document.name, ok: false, step: error instanceof Timeout ? 'timeout' : 'threw' };
            }
            results.push(result);
            onResult?.(result);
        }
        return results;
    }

    private async one(document: CorpusDocument, live: boolean): Promise<CorpusResult> {
        const { name } = document;
        this.inbox = [];
        this.editor.send({ type: 'socio-load', payload: { markdown: document.markdown } });
        const loaded = await this.next('socio-loaded');
        // Source mode on the web: only the verdict is the web's answer (below), never the WebView's read-back.
        const readBack = document.supported
            ? compareText(name, 'load', document.golden, loaded.payload.markdown, live)
            : null;
        if (readBack) {
            return readBack;
        }
        if (loaded.payload.supported !== document.supported || loaded.payload.reason !== document.reason) {
            return { name, ok: false, step: 'verdict' };
        }
        // Opening is never an edit: no `change`, even after the throttle's window.
        await this.timers.sleep(CORPUS_QUIET_MS);
        if (this.inbox.some((message) => message.type === 'socio-change')) {
            return { name, ok: false, step: 'opened' };
        }
        if (document.edited === null) {
            return { name, ok: true };
        }
        this.editor.focusEnd();
        this.editor.insert(CORPUS_EDIT_TEXT);
        this.editor.send({ type: 'socio-flush' });
        const edited = await this.next('socio-change');
        const edit = compareText(name, 'edit', document.edited, edited.payload.markdown, live);
        if (edit) {
            return edit;
        }
        this.editor.send({ type: 'socio-command', payload: { name: 'undo' } });
        this.editor.send({ type: 'socio-flush' });
        const undone = await this.next('socio-change');
        return compareText(name, 'undo', document.golden, undone.payload.markdown, live) ?? { name, ok: true };
    }

    /** The next message of `type`: one already in the inbox, else the first to come within CORPUS_WAIT_MS. */
    private next<T extends ToNativeMessage['type']>(type: T): Promise<Extract<ToNativeMessage, { type: T }>> {
        const match = (message: ToNativeMessage): message is Extract<ToNativeMessage, { type: T }> =>
            message.type === type;
        const at = this.inbox.findIndex(match);
        if (at !== -1) {
            const [message] = this.inbox.splice(at, 1);
            return Promise.resolve(message as Extract<ToNativeMessage, { type: T }>);
        }
        return new Promise((resolve, reject) => {
            const timer = this.timers.setTimer(() => {
                this.waiter = null;
                reject(new Timeout(type));
            }, CORPUS_WAIT_MS);
            this.waiter = {
                match,
                done: (message) => {
                    this.timers.clearTimer(timer);
                    resolve(message as Extract<ToNativeMessage, { type: T }>);
                },
            };
        });
    }
}

/** The summary line the route shows and logs. */
export function corpusSummary(results: readonly CorpusResult[]) {
    const equal = results.filter((result) => result.ok).length;
    return equal === results.length
        ? `All ${results.length} documents match the web.`
        : `${results.length - equal} of ${results.length} documents differ from the web.`;
}
