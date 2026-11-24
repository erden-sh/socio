import { type CorpusDocument, corpusDocumentsSchema, corpusSummary, type CorpusResult } from './corpus';

// Taking the live corpus off the device, with the file handed in so it runs
// under Node (tests/editor/live-corpus.test.ts); platform/editor-corpus.ts
// binds expo-file-system. Only a missing file is "no live corpus". Any other
// failure (the file can't be read, isn't a corpus, or won't delete) is a
// problem that fails the run, in words of our own: never the error's
// message, the file's contents or a page's name.

/** What the route needs of expo-file-system's File. */
export interface LiveCorpusFile {
    readonly exists: boolean;
    text(): Promise<string>;
    delete(): void;
}

/** The live corpus as the route found it. */
export type LiveCorpus =
    | { readonly kind: 'none' }
    | { readonly kind: 'taken'; readonly documents: readonly CorpusDocument[] }
    | { readonly kind: 'failed'; readonly problem: string };

export const LIVE_CORPUS_PROBLEMS = {
    check: 'Couldn’t tell whether a live corpus was copied in.',
    read: 'The live corpus couldn’t be read; it was deleted.',
    invalid: 'The live corpus isn’t a valid corpus file; it was deleted.',
    deleted:
        'The live corpus couldn’t be deleted from the phone: delete it with `pages-corpus.mts clean` or uninstall the build.',
} as const;

function exists(file: LiveCorpusFile): boolean | null {
    try {
        return file.exists;
    } catch {
        return null;
    }
}

/** Reads the live corpus once and deletes it, whatever the read did; never throws. */
export async function takeLiveCorpusFrom(file: LiveCorpusFile): Promise<LiveCorpus> {
    const there = exists(file);
    if (there === false) {
        return { kind: 'none' };
    }
    if (there === null) {
        return { kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.check };
    }
    let read: LiveCorpus;
    try {
        const text = await file.text();
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = undefined;
        }
        const documents = parsed === undefined ? null : corpusDocumentsSchema.safeParse(parsed);
        read = documents?.success
            ? { kind: 'taken', documents: documents.data }
            : { kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.invalid };
    } catch {
        read = { kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.read };
    }
    try {
        file.delete();
    } catch {
        // Checked below: a delete that threw may still have deleted it.
    }
    if (exists(file) !== false) {
        // Private pages may still be on the phone: that fails the run, whatever the read did.
        return { kind: 'failed', problem: LIVE_CORPUS_PROBLEMS.deleted };
    }
    return read;
}

/** Why the run stopped early, and how many documents it never compared. */
export interface RunStopped {
    readonly problem: string;
    readonly unfinished: number;
}

/**
 * The run's summary line: a live corpus that failed, or a run that stopped on
 * an unexpected error, fails the run, however the documents it did compare went.
 */
export function runSummary(
    results: readonly CorpusResult[],
    liveProblem: string | null,
    stopped: RunStopped | null = null,
) {
    const compared = corpusSummary(results);
    const problems = [
        ...(liveProblem === null ? [] : [liveProblem]),
        ...(stopped === null
            ? []
            : [
                  stopped.problem,
                  `${stopped.unfinished} of ${results.length + stopped.unfinished} documents didn’t finish.`,
              ]),
    ];
    if (problems.length === 0) {
        return compared;
    }
    return stopped === null
        ? `The run failed: ${problems.join(' ')} ${compared}`
        : `The run failed: ${problems.join(' ')} Of those that finished: ${compared}`;
}

/**
 * An unexpected error in our own words: its message may hold a page's text
 * (a live document's), so only a plain error name goes with it.
 */
export function unexpectedProblem(error: unknown) {
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
    return `The run stopped on an unexpected error (${name}).`;
}

/** What the route's run needs: the live corpus, the runner and the log, handed in so it runs under Node. */
export interface CorpusSessionDeps {
    take(): Promise<LiveCorpus>;
    run(
        documents: readonly CorpusDocument[],
        live: boolean,
        onResult: (result: CorpusResult) => void,
    ): Promise<readonly CorpusResult[]>;
    log(line: string): void;
    /** The live corpus was taken (its size) or failed: the route grows its total. */
    onLive?(live: number | null, liveProblem: string | null): void;
    onResult?(result: CorpusResult): void;
}

/** How the run ended: always one, and always one `[editor-corpus]` line logged. */
export interface CorpusOutcome {
    readonly results: readonly CorpusResult[];
    readonly live: number | null;
    readonly liveProblem: string | null;
    readonly stopped: RunStopped | null;
    readonly summary: string;
}

/**
 * The route's whole run: the live corpus, the synthetic documents,
 * then the live ones. Never throws: an unexpected error ends the run with
 * `stopped` (its words, and the documents not compared) and a sanitized
 * failure line, never "All N documents match the web".
 */
export async function runCorpusSession(
    synthetic: readonly CorpusDocument[],
    deps: CorpusSessionDeps,
): Promise<CorpusOutcome> {
    const results: CorpusResult[] = [];
    let total = synthetic.length;
    let live: number | null = null;
    let liveProblem: string | null = null;
    let stopped: RunStopped | null = null;
    const add = (result: CorpusResult) => {
        results.push(result);
        deps.onResult?.(result);
    };
    try {
        const taken = await deps.take();
        const documents = taken.kind === 'taken' ? taken.documents : null;
        live = documents?.length ?? null;
        liveProblem = taken.kind === 'failed' ? taken.problem : null;
        total += documents?.length ?? 0;
        deps.onLive?.(live, liveProblem);
        await deps.run(synthetic, false, add);
        if (documents !== null) {
            await deps.run(documents, true, add);
        }
    } catch (error) {
        stopped = { problem: unexpectedProblem(error), unfinished: Math.max(0, total - results.length) };
    }
    const summary = runSummary(results, liveProblem, stopped);
    deps.log(
        JSON.stringify({
            summary,
            synthetic: Math.min(results.length, synthetic.length),
            live: Math.max(0, results.length - synthetic.length),
            ...(liveProblem === null ? {} : { liveError: true, liveProblem }),
            ...(stopped === null ? {} : { error: true, problem: stopped.problem, unfinished: stopped.unfinished }),
            failures: results.filter((result) => !result.ok),
        }),
    );
    return { results, live, liveProblem, stopped, summary };
}
