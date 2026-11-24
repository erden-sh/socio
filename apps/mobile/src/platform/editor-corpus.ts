import { File, Paths } from 'expo-file-system';

import { LIVE_CORPUS_FILE } from '../editor/corpus';
import { type LiveCorpus, takeLiveCorpusFrom } from '../editor/live-corpus';

// The live corpus for the `EditorCorpus` route, development and preview
// builds only: the pages the export script copied into the app's documents
// folder. Read once and deleted at once, so no copy of the company's pages
// stays on the device after the run, whatever the run then does. src/editor/live-corpus.ts
// decides: only a missing file is none, every other failure fails the run.

/** The live corpus, deleted as it is read. */
export function takeLiveCorpus(): Promise<LiveCorpus> {
    return takeLiveCorpusFrom(new File(Paths.document, LIVE_CORPUS_FILE));
}
