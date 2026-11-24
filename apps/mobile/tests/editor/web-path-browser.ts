// The web's page editor path (web-path.ts) in a browser page, built by
// scripts/roundtrip-browsers.mts and run in Playwright's Chromium and WebKit:
// every synthetic document (and the live ones handed in) against Node's
// goldens, compared as the device route compares. A document whose rich
// editor throws is one failure (its name and a sanitized kind, never the
// message), and the run goes on.
import { compareText, type CorpusDocument, type CorpusResult, describeResult } from '../../src/editor/corpus';
import { EDITOR_CORPUS } from '../../src/editor/generated/editor-corpus';

import { webFailureKind, webRoundTrip } from './web-path';

function check(document: CorpusDocument, live: boolean): CorpusResult | string {
    const { name } = document;
    const element = window.document.body.appendChild(window.document.createElement('div'));
    let answer: ReturnType<typeof webRoundTrip>;
    try {
        answer = webRoundTrip(document.markdown, element);
    } catch (error) {
        return `${name}: the web path threw (${webFailureKind(error)})`;
    } finally {
        element.remove();
    }
    return (
        compareText(name, 'load', document.golden, answer.markdown, live) ??
        (answer.supported !== document.supported || answer.reason !== document.reason
            ? { name, ok: false, step: 'verdict' }
            : answer.openUpdates !== 0
              ? { name, ok: false, step: 'opened' }
              : document.edited === null
                ? null
                : compareText(name, 'edit', document.edited, answer.edited, live)) ??
        compareText(name, 'undo', document.golden, answer.undone, live) ?? { name, ok: true }
    );
}

/** Runs the corpus; answers the counts and one line per failure (a live one without its text). */
function runCorpus(live: readonly CorpusDocument[]) {
    const results = [
        ...EDITOR_CORPUS.map((document) => check(document, false)),
        ...live.map((document) => check(document, true)),
    ];
    return {
        synthetic: EDITOR_CORPUS.length,
        live: live.length,
        equal: results.filter((result) => typeof result !== 'string' && result.ok).length,
        failures: results.flatMap((result) =>
            typeof result === 'string' ? [result] : result.ok ? [] : [describeResult(result)],
        ),
    };
}

(window as unknown as { runCorpus: typeof runCorpus }).runCorpus = runCorpus;
