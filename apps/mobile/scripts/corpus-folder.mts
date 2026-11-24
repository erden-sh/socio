// The live corpus's folder (scripts/pages-corpus.mts), kept apart so the
// checks run under Node in tests/editor/corpus-folder.test.ts:
// - the folder is never the checkout, inside it or above it, the home folder or
//   a filesystem root, compared by real path (symlinks resolved), so `..` or a
//   link to the checkout can't pass;
// - the script marks it (MARKER) when it makes the folder or first uses an empty
//   one, and won't take a folder with other things in it and no mark;
// - `clean` deletes only what the corpus puts there (`<spaceId>/<pageId>.md`,
//   device-corpus.json), then the mark, then the folder once it's empty, and
//   refuses a folder with no mark. Nothing is ever deleted recursively.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/** The mark the script leaves in a folder it made or took; `clean` deletes nothing without it. */
export const MARKER = '.socio-pages-corpus';
/** What the round-trip test writes for the device. */
export const DEVICE_FILE = 'device-corpus.json';

export class CorpusFolderError extends Error {}

/** The path with symlinks resolved, for a folder that may not exist yet: its nearest existing ancestor's real path, then the rest. */
function realPath(path: string): string {
    const absolute = resolve(path);
    if (existsSync(absolute)) {
        return realpathSync(absolute);
    }
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
}

/** Whether `child` is `parent` or inside it. */
function within(parent: string, child: string) {
    const path = relative(parent, child);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** SOCIO_PAGES_CORPUS's folder, by real path, or a CorpusFolderError for a folder the script must not use. */
export function corpusFolder(value: string | undefined, checkout: string, home: string): string {
    if (!value) {
        throw new CorpusFolderError('Set SOCIO_PAGES_CORPUS to a folder outside the checkout.');
    }
    const path = realPath(value);
    const repo = realPath(checkout);
    const homeFolder = realPath(home);
    if (path === parse(path).root) {
        throw new CorpusFolderError('SOCIO_PAGES_CORPUS is a filesystem root: give the corpus a folder of its own.');
    }
    if (path === homeFolder) {
        throw new CorpusFolderError('SOCIO_PAGES_CORPUS is the home folder: give the corpus a folder of its own.');
    }
    if (within(repo, path)) {
        throw new CorpusFolderError(
            'SOCIO_PAGES_CORPUS is inside the checkout: put it outside, so nothing of it can be committed.',
        );
    }
    if (within(path, repo) || within(path, homeFolder)) {
        throw new CorpusFolderError(
            'SOCIO_PAGES_CORPUS holds the checkout or the home folder: give the corpus a folder of its own.',
        );
    }
    return path;
}

/** Makes the folder (0700) and marks it, or checks the mark of one that has things in it. */
export function claimCorpusFolder(folder: string) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const marker = join(folder, MARKER);
    if (existsSync(marker)) {
        return;
    }
    if (readdirSync(folder).length > 0) {
        throw new CorpusFolderError(
            `SOCIO_PAGES_CORPUS already has files and no ${MARKER}: give the corpus an empty or new folder.`,
        );
    }
    writeFileSync(marker, 'The live page corpus of apps/mobile/scripts/pages-corpus.mts. `clean` deletes it.\n', {
        mode: 0o600,
    });
}

/**
 * Deletes what the corpus writes in a marked folder (`device-corpus.json`, then each
 * `<spaceId>/<pageId>.md` and the space folders left empty), keeping the mark and
 * anything else. `clean` runs it, and `export` before it writes, so a page deleted or
 * no longer readable since the last export, and the old device payload, never stay.
 */
export function clearCorpusFiles(folder: string) {
    if (!existsSync(join(folder, MARKER))) {
        throw new CorpusFolderError(
            `SOCIO_PAGES_CORPUS has no ${MARKER}: the script deletes only in a folder it made.`,
        );
    }
    rmSync(join(folder, DEVICE_FILE), { force: true });
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        // Dirent doesn't follow symlinks: a linked folder is left alone.
        if (!entry.isDirectory()) {
            continue;
        }
        const space = join(folder, entry.name);
        for (const page of readdirSync(space, { withFileTypes: true })) {
            if (page.isFile() && page.name.endsWith('.md')) {
                rmSync(join(space, page.name));
            }
        }
        if (readdirSync(space).length === 0) {
            rmdirSync(space);
        }
    }
}

/** What `clean` did: `missing` when there was no folder, else how many things it left (not the corpus's, so kept). */
export type CleanResult = { readonly missing: true } | { readonly missing: false; readonly left: number };

/** Deletes the corpus's files, then the mark and the folder once nothing else is in it; refuses a folder with no mark. */
export function cleanCorpusFolder(folder: string): CleanResult {
    if (!existsSync(folder)) {
        return { missing: true };
    }
    if (!existsSync(join(folder, MARKER))) {
        throw new CorpusFolderError(
            `SOCIO_PAGES_CORPUS has no ${MARKER}: clean deletes only a folder the script made.`,
        );
    }
    clearCorpusFiles(folder);
    const left = readdirSync(folder).filter((name) => name !== MARKER).length;
    if (left === 0) {
        rmSync(join(folder, MARKER));
        if (lstatSync(folder).isDirectory()) {
            rmdirSync(folder);
        }
    }
    return { missing: false, left };
}
