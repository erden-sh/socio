import type { EditorCorpusRun as EditorCorpusRunType } from './editor-corpus-run';

// The `EditorCorpus` route, development and preview builds only: the
// Markdown round trip against the web in the real WebView
// (editor-corpus-run.tsx, required only here, so tentap, the editor's document
// and the corpus never load at launch).

let runModule: typeof import('./editor-corpus-run') | undefined;

function editorCorpusRun(): typeof EditorCorpusRunType {
    // oxlint-disable-next-line typescript/no-require-imports -- a lazy require keeps tentap, the document and the corpus out of launch
    runModule ??= require('./editor-corpus-run') as typeof import('./editor-corpus-run');
    return runModule.EditorCorpusRun;
}

export function EditorCorpusScreen() {
    const EditorCorpusRun = editorCorpusRun();
    return <EditorCorpusRun />;
}
