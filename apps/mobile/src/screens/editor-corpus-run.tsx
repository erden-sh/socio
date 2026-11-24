import { BridgeExtension, CoreBridge, RichText, useBridgeState, useEditorBridge } from '@10play/tentap-editor';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { CorpusRunner, type CorpusResult, describeResult } from '../editor/corpus';
import { EDITOR_CORPUS } from '../editor/generated/editor-corpus';
import { EDITOR_HTML } from '../editor/generated/editor-html';
import { type RunStopped, runCorpusSession, runSummary } from '../editor/live-corpus';
import { EDITOR_LOCKDOWN, editorRequest } from '../editor/lockdown';
import { takeLiveCorpus } from '../platform/editor-corpus';
import { Banner, Text } from '../ui';

// The Markdown round trip in the real WebView, for development and
// preview builds only (the route table leaves it out of production): the
// page editor's own document and lockdown, every corpus document loaded
// through the bridge, read back, edited at its end through tentap's
// CoreBridge (as typing would) and undone, each answer compared with Node's
// golden, the web's (src/editor/corpus.ts). Then the live corpus, when the
// export script copied one in: read once and deleted (platform/editor-corpus.ts),
// its failures named only by a hash of the path and a line number. A live
// corpus that can't be read, isn't valid or won't delete fails the run
// (`liveError`), in src/editor/live-corpus.ts's words only, and so does an
// unexpected error, with the documents it never compared (runCorpusSession).
//
// Required only by screens/editor-corpus.tsx, inside a function, so tentap,
// the document and the corpus never load at launch. Opened with
// `socio-dev://editor-corpus`. It runs as it opens and logs one
// `[editor-corpus]` line with the summary and the failures for the device check.

type Send = (message: unknown) => void;

interface Run {
    readonly results: readonly CorpusResult[];
    readonly total: number;
    readonly done: boolean;
    readonly live: number | null;
    /** Why the live corpus failed, in live-corpus.ts's words; null when it was taken or there was none. */
    readonly liveProblem: string | null;
    /** Why the run stopped early and what it never compared (live-corpus.ts's words); null when it ran to the end. */
    readonly stopped: RunStopped | null;
}

export function EditorCorpusRun() {
    // The runner hears the WebView from the first message; it gets the editor once the WebView is ready.
    const [{ runner, bridge }] = useState(() => {
        const made = new CorpusRunner();
        return {
            runner: made,
            bridge: new BridgeExtension<object, { socioSend: Send }, unknown>({
                forceName: 'socioPage',
                onEditorMessage: (message) => {
                    made.receive(message);
                    return false;
                },
                extendEditorInstance: (send) => ({ socioSend: send as Send }),
            }),
        };
    });
    const editor = useEditorBridge({ bridgeExtensions: [CoreBridge, bridge], avoidIosKeyboard: false });
    const { isReady } = useBridgeState(editor);
    const [run, setRun] = useState<Run>({
        results: [],
        total: EDITOR_CORPUS.length,
        done: false,
        live: null,
        liveProblem: null,
        stopped: null,
    });

    useEffect(() => {
        if (!isReady || runner.connected) {
            return;
        }
        const send = (editor as unknown as { socioSend: Send }).socioSend;
        runner.connect({
            send,
            focusEnd: () => editor.focus('end'),
            insert: (text) => editor.insertContent(text),
        });
        void runCorpusSession(EDITOR_CORPUS, {
            take: takeLiveCorpus,
            run: (documents, live, onResult) => runner.run(documents, live, onResult),
            log: (line) => console.log('[editor-corpus]', line),
            onLive: (live, liveProblem) =>
                setRun((was) => ({ ...was, total: was.total + (live ?? 0), live, liveProblem })),
            onResult: (result) => setRun((was) => ({ ...was, results: [...was.results, result] })),
        }).then((outcome) => {
            // The edits focused the editor: blur it once the run is over.
            editor.blur();
            setRun((was) => ({ ...was, done: true, stopped: outcome.stopped }));
        });
    }, [isReady, editor, runner]);

    const failures = run.results.filter((result) => !result.ok);
    return (
        <View className="flex-1 gap-3 bg-screen p-4" testID="editor-corpus">
            <View className="gap-1">
                <Text weight="medium" testID="editor-corpus-summary">
                    {run.done
                        ? runSummary(run.results, run.liveProblem, run.stopped)
                        : `Comparing ${run.results.length} of ${run.total} documents with the web…`}
                </Text>
                <Text variant="footnote" tone="muted">
                    {run.liveProblem !== null
                        ? `${EDITOR_CORPUS.length} synthetic documents; the live corpus failed.`
                        : run.live === null
                          ? `${EDITOR_CORPUS.length} synthetic documents, no live corpus copied in.`
                          : `${EDITOR_CORPUS.length} synthetic documents and ${run.live} live pages (deleted from the phone).`}
                </Text>
            </View>
            {run.liveProblem === null ? null : <Banner tone="error">{run.liveProblem}</Banner>}
            {run.stopped === null ? null : <Banner tone="error">{run.stopped.problem}</Banner>}
            {failures.length === 0 ? null : (
                <ScrollView className="max-h-60" testID="editor-corpus-failures">
                    {failures.map((result) => (
                        <Text key={result.name} variant="footnote" selectable>
                            {describeResult(result)}
                        </Text>
                    ))}
                </ScrollView>
            )}
            <View className="flex-1 rounded-xl border border-border">
                <RichText
                    editor={editor}
                    source={{ html: EDITOR_HTML }}
                    exclusivelyUseCustomOnMessage={false}
                    {...EDITOR_LOCKDOWN}
                    style={{ backgroundColor: 'transparent' }}
                    onShouldStartLoadWithRequest={(request) => editorRequest(request).kind === 'allow'}
                />
            </View>
        </View>
    );
}
