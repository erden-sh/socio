import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// A dataset view's CSV export (CB-469, CB-451) handed to the system's
// share sheet: written into the cache's `exports/` folder under the name the
// server gave, then expo-sharing's sheet (UIActivityViewController on iOS, a
// FileProvider URI to ACTION_SEND's chooser on Android). The folder is emptied
// before each export and a few minutes after one, so no workspace's rows stay
// outside its folder for long; a receiving app that copies
// later than that gets nothing, which is the trade.

const EXPORTS = 'exports';
const KEEP_MS = 3 * 60_000;

function emptyExports(): void {
    try {
        const folder = new Directory(Paths.cache, EXPORTS);
        if (folder.exists) {
            folder.delete();
        }
    } catch (error) {
        console.warn('[export] the exports folder was not emptied', error);
    }
}

export type ShareOutcome = 'shared' | 'unavailable';

/** Writes `text` as `name` and opens the share sheet; resolves once the sheet is closed. */
export async function shareCsv(name: string, text: string, title: string): Promise<ShareOutcome> {
    emptyExports();
    const folder = new Directory(Paths.cache, EXPORTS);
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(folder, name);
    file.create({ overwrite: true });
    file.write(text);
    try {
        if (!(await Sharing.isAvailableAsync())) {
            return 'unavailable';
        }
        await Sharing.shareAsync(file.uri, {
            mimeType: 'text/csv',
            UTI: 'public.comma-separated-values-text',
            dialogTitle: title,
        });
        return 'shared';
    } finally {
        setTimeout(emptyExports, KEEP_MS);
    }
}
