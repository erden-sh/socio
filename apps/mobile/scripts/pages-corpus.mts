// The live corpus for the page editor's round trip: the pages one smoke
// account can read,
// exported to a folder outside the checkout, compared with the web under
// Node, copied into a development build for its `EditorCorpus` route, and
// deleted afterwards. Never committed, never in CI.
//
// The sequence, always to its last step (the host's copy goes only with `clean`):
//   SOCIO_PAGES_CORPUS=<folder outside the checkout>
//   1. node apps/mobile/scripts/pages-corpus.mts export --base <origin> --email <smoke account> --password-file <file>
//   2. pnpm --filter @socio/mobile exec vitest run tests/editor/roundtrip.test.ts   (writes device-corpus.json;
//      a page the web path can't process fails the test by its hash, and the rest still go in)
//   3. node apps/mobile/scripts/pages-corpus.mts push android [--serial emulator-5554]
//      node apps/mobile/scripts/pages-corpus.mts push ios                            (on the Mac, the booted simulator)
//   4. open socio-dev://editor-corpus on the device and read its [editor-corpus] line
//   5. node apps/mobile/scripts/pages-corpus.mts clean [android|ios]                 (the host's folder, and the device's copy)
// Run step 5 whatever steps 2 to 4 did, failures included: until then the
// pages stay on the host. `push` ends by saying so.
//
// Export skips (and counts) a page or Space it can no longer read (403 or
// 404). A failure throws and the script exits with code 1 once it has
// unwound: the export signs out in its `finally`, never skipped by an exit.
//
// Privacy: requests carry the smoke account's sign-in and a generic
// User-Agent, nothing else of anyone's. Files are 0600 in a 0700 folder.
// Nothing prints a page's title, path or text: counts only. The route
// deletes its copy as it reads it; `clean` deletes it again in case the
// route never ran. The folder's checks and `clean`'s deletes are
// corpus-folder.mts's: never the checkout, above it, home or `/`, and only a
// folder this script marked, file by file, never recursively. Each export
// replaces the last one, device payload included (corpus-export.mts).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { VARIANTS, type VariantName } from '../variant.ts';

import { CorpusExportError, exportPages } from './corpus-export.mts';
import { cleanCorpusFolder, CorpusFolderError, corpusFolder as checkedFolder, DEVICE_FILE } from './corpus-folder.mts';

/** On the device: src/editor/corpus.ts's LIVE_CORPUS_FILE. */
const LIVE_CORPUS_FILE = 'editor-live-corpus.json';
const ADB = join(process.env.HOME ?? '', 'Android/Sdk/platform-tools/adb');
const repo = resolve(import.meta.dirname, '../../..');

/** A failure the script words itself: printed, with exit code 1, once everything has unwound. */
class ScriptError extends Error {}

function fail(message: string): never {
    throw new ScriptError(message);
}

function option(args: string[], name: string, fallback?: string) {
    const at = args.indexOf(name);
    const value = at === -1 ? fallback : args[at + 1];
    if (value === undefined) {
        fail(`Missing ${name}.`);
    }
    return value;
}

/** The corpus folder: SOCIO_PAGES_CORPUS, outside the checkout so nothing of it can be committed. */
function corpusFolder() {
    return checkedFolder(process.env.SOCIO_PAGES_CORPUS, repo, homedir());
}

async function exportCorpus(args: string[]) {
    const base = option(args, '--base');
    const email = option(args, '--email');
    const password = readFileSync(option(args, '--password-file'), 'utf8').trim();
    const { pages, skipped } = await exportPages({ base, email, password, folder: corpusFolder() });
    console.log(
        `Exported ${pages} pages${skipped > 0 ? `; skipped ${skipped} pages or Spaces the account can no longer read (403 or 404)` : ''}.`,
    );
}

function devicePackage(args: string[]) {
    const variant = option(args, '--variant', 'development') as VariantName;
    if (!Object.hasOwn(VARIANTS, variant)) {
        fail(`Unknown variant ${variant}.`);
    }
    return VARIANTS[variant].id;
}

function push(platform: string | undefined, args: string[]) {
    const source = join(corpusFolder(), DEVICE_FILE);
    if (!existsSync(source)) {
        fail(`No ${DEVICE_FILE}: run the round-trip test with SOCIO_PAGES_CORPUS first.`);
    }
    const id = devicePackage(args);
    if (platform === 'android') {
        const serial = option(args, '--serial', 'emulator-5554');
        // A debuggable build's files/ is expo-file-system's Paths.document.
        execFileSync(ADB, ['-s', serial, 'shell', 'run-as', id, 'sh', '-c', `'cat > files/${LIVE_CORPUS_FILE}'`], {
            input: readFileSync(source),
        });
        execFileSync(ADB, ['-s', serial, 'shell', 'run-as', id, 'chmod', '600', `files/${LIVE_CORPUS_FILE}`]);
    } else if (platform === 'ios') {
        const data = execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', id, 'data'], {
            encoding: 'utf8',
        }).trim();
        const target = join(data, 'Documents', LIVE_CORPUS_FILE);
        writeFileSync(target, readFileSync(source), { mode: 0o600 });
    } else {
        fail('Usage: push android|ios');
    }
    console.log(`Copied the live corpus into ${platform}'s ${id}.`);
    console.log(
        `Next: open socio-dev://editor-corpus, then run \`pages-corpus.mts clean ${platform}\` whatever it shows: the pages stay on this machine until then.`,
    );
}

function clean(platform: string | undefined, args: string[]) {
    const cleaned = cleanCorpusFolder(corpusFolder());
    const id = devicePackage(args);
    if (platform === 'android') {
        const serial = option(args, '--serial', 'emulator-5554');
        execFileSync(ADB, ['-s', serial, 'shell', 'run-as', id, 'rm', '-f', `files/${LIVE_CORPUS_FILE}`]);
    } else if (platform === 'ios') {
        const data = execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', id, 'data'], {
            encoding: 'utf8',
        }).trim();
        rmSync(join(data, 'Documents', LIVE_CORPUS_FILE), { force: true });
    }
    if (!cleaned.missing && cleaned.left > 0) {
        fail(
            `Deleted the corpus's files${platform ? ` and ${platform}'s copy` : ''}, but the folder holds ${cleaned.left} other items: kept, with its mark. Look at them yourself.`,
        );
    }
    console.log(`Deleted the corpus folder${platform ? ` and ${platform}'s copy` : ''}.`);
}

async function main() {
    const [command, platform, ...rest] = process.argv.slice(2);
    if (command === 'export') {
        await exportCorpus(process.argv.slice(3));
    } else if (command === 'push') {
        push(platform, rest);
    } else if (command === 'clean') {
        clean(
            platform?.startsWith('--') ? undefined : platform,
            platform?.startsWith('--') ? [platform, ...rest] : rest,
        );
    } else {
        fail('Usage: node apps/mobile/scripts/pages-corpus.mts export|push|clean (see the top of this file)');
    }
}

try {
    await main();
} catch (error) {
    if (!(error instanceof ScriptError || error instanceof CorpusFolderError || error instanceof CorpusExportError)) {
        throw error;
    }
    // Never process.exit: the export's `finally` (its sign-out) has already run by now.
    console.error(error.message);
    process.exitCode = 1;
}
