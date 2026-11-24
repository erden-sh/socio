import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    claimCorpusFolder,
    cleanCorpusFolder,
    CorpusFolderError,
    corpusFolder,
    DEVICE_FILE,
    MARKER,
} from '../../scripts/corpus-folder.mts';

// The live corpus's folder (scripts/corpus-folder.mts): never
// the checkout, inside it or above it, home or `/`, by real path; `clean`
// deletes only what the corpus wrote, and only in a folder the script marked.
// Every case runs in a temporary tree: a fake home holding a fake checkout.

let root: string;
let home: string;
let checkout: string;

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'corpus-folder-')));
    home = join(root, 'home');
    checkout = join(home, 'work', 'socio');
    mkdirSync(join(checkout, 'apps', 'mobile'), { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

const refused = (value: string | undefined) => () => corpusFolder(value, checkout, home);

describe('the corpus folder', () => {
    it('refuses `..` from inside the checkout', () => {
        const cwd = process.cwd();
        process.chdir(join(checkout, 'apps'));
        try {
            expect(refused('..')).toThrow(CorpusFolderError);
            expect(refused('../..')).toThrow(CorpusFolderError);
        } finally {
            process.chdir(cwd);
        }
    });

    it('refuses the checkout root and any folder inside it', () => {
        expect(refused(checkout)).toThrow(/inside the checkout/);
        expect(refused(join(checkout, 'apps', 'mobile'))).toThrow(/inside the checkout/);
        expect(refused(join(checkout, 'not-made-yet', 'corpus'))).toThrow(/inside the checkout/);
    });

    it('refuses an ancestor of the checkout', () => {
        expect(refused(join(home, 'work'))).toThrow(/holds the checkout/);
    });

    it('refuses the home folder and the filesystem root', () => {
        expect(refused(home)).toThrow(/home folder/);
        expect(refused('/')).toThrow(/filesystem root/);
    });

    it('refuses a symlink that leads to the checkout or above it', () => {
        symlinkSync(checkout, join(root, 'to-checkout'));
        symlinkSync(join(home, 'work'), join(root, 'to-work'));
        expect(refused(join(root, 'to-checkout'))).toThrow(/inside the checkout/);
        expect(refused(join(root, 'to-checkout', 'corpus'))).toThrow(/inside the checkout/);
        expect(refused(join(root, 'to-work'))).toThrow(/holds the checkout/);
    });

    it('refuses no setting', () => {
        expect(refused(undefined)).toThrow(/Set SOCIO_PAGES_CORPUS/);
        expect(refused('')).toThrow(/Set SOCIO_PAGES_CORPUS/);
    });

    it('takes a folder of its own outside the checkout, by real path', () => {
        expect(corpusFolder(join(root, 'corpus'), checkout, home)).toBe(join(root, 'corpus'));
        expect(corpusFolder(join(home, 'corpus'), checkout, home)).toBe(join(home, 'corpus'));
    });
});

/** A corpus as export and the round-trip test leave it. */
function fillCorpus(folder: string) {
    claimCorpusFolder(folder);
    mkdirSync(join(folder, 'space-1'));
    writeFileSync(join(folder, 'space-1', 'page-1.md'), '# One');
    writeFileSync(join(folder, 'space-1', 'page-2.md'), '# Two');
    mkdirSync(join(folder, 'space-2'));
    writeFileSync(join(folder, 'space-2', 'page-3.md'), '# Three');
    writeFileSync(join(folder, DEVICE_FILE), '[]');
}

describe('claiming the corpus folder', () => {
    it('makes and marks a new folder, and takes it again', () => {
        const folder = join(root, 'corpus');
        claimCorpusFolder(folder);
        expect(readdirSync(folder)).toEqual([MARKER]);
        claimCorpusFolder(folder);
        expect(readdirSync(folder)).toEqual([MARKER]);
    });

    it('refuses a folder with files and no mark', () => {
        const folder = join(root, 'documents');
        mkdirSync(folder);
        writeFileSync(join(folder, 'taxes.pdf'), 'x');
        expect(() => claimCorpusFolder(folder)).toThrow(CorpusFolderError);
        expect(existsSync(join(folder, MARKER))).toBe(false);
    });
});

describe('cleaning the corpus folder', () => {
    it('refuses a folder without the mark and deletes nothing', () => {
        const folder = join(root, 'unmarked');
        mkdirSync(join(folder, 'space-1'), { recursive: true });
        writeFileSync(join(folder, 'space-1', 'page-1.md'), '# One');
        writeFileSync(join(folder, DEVICE_FILE), '[]');
        expect(() => cleanCorpusFolder(folder)).toThrow(/no \.socio-pages-corpus/);
        expect(existsSync(join(folder, 'space-1', 'page-1.md'))).toBe(true);
        expect(existsSync(join(folder, DEVICE_FILE))).toBe(true);
    });

    it('deletes a marked folder: the pages, the device file, the mark, then the folder', () => {
        const folder = join(root, 'corpus');
        fillCorpus(folder);
        expect(cleanCorpusFolder(folder)).toEqual({ missing: false, left: 0 });
        expect(existsSync(folder)).toBe(false);
    });

    it('keeps what the corpus didn’t write, and the mark with it', () => {
        const folder = join(root, 'corpus');
        fillCorpus(folder);
        writeFileSync(join(folder, 'notes.txt'), 'mine');
        writeFileSync(join(folder, 'space-1', 'photo.jpg'), 'mine');
        const outside = join(root, 'outside');
        mkdirSync(outside);
        writeFileSync(join(outside, 'page.md'), 'mine');
        symlinkSync(outside, join(folder, 'linked'));
        expect(cleanCorpusFolder(folder)).toEqual({ missing: false, left: 3 });
        expect([...readdirSync(folder)].sort()).toEqual([MARKER, 'linked', 'notes.txt', 'space-1']);
        expect(readdirSync(join(folder, 'space-1'))).toEqual(['photo.jpg']);
        expect(existsSync(join(outside, 'page.md'))).toBe(true);
    });

    it('answers missing for a folder that isn’t there', () => {
        expect(cleanCorpusFolder(join(root, 'gone'))).toEqual({ missing: true });
    });

    it('is never handed the checkout: its folder check comes first', () => {
        writeFileSync(join(checkout, MARKER), '');
        expect(refused(relative(process.cwd(), checkout))).toThrow(CorpusFolderError);
        expect(existsSync(join(checkout, 'apps', 'mobile'))).toBe(true);
    });
});
