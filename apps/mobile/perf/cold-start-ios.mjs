#!/usr/bin/env node
// Cold start on an iPhone, offline: from
// the process's start to the chat list's (or Home's) first frame with data,
// from the cache alone.
//
//   node apps/mobile/perf/cold-start-ios.mjs --device <devicectl id> --airplane-on
//       [--ssh <user@mac>] [--variant preview] [--bundle-id <id>] [--runs 10]
//       [--bench <url>] [--server-log <file> ...] [--out <file.json>]
//
// Before it:
// 1. A release build of a test variant, built on the Mac from a prebuild made with
//    APP_VARIANT and Expo's three switches (EXPO_NO_TELEMETRY, EXPO_OFFLINE,
//    DO_NOT_TRACK: `ios/.xcode.env` keeps them for Xcode's `expo export:embed`),
//    installed with `xcrun devicectl device install app`.
// 2. Signed in to the https bench endpoint, and the cache filled: the app open
//    online until the chat list shows, then a launch that writes its marks.
// 3. The bench and its tunnel stopped, and airplane mode turned on by hand on the
//    phone (`--airplane-on` says so: nothing can turn it on from here).
//
// Then it reads how many records the marks file (`Documents/perf/cold-start.jsonl`)
// holds, makes one discarded launch and `--runs` more through
// `devicectl device process launch --terminate-existing` (each kills the last),
// pulls the file again and summarizes the new records. With `--ssh`, every
// xcrun runs on the Mac over SSH (BatchMode), so it can run from a Linux host.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { formatSummary, parseRecords, summarize } from './cold-start-stats.mjs';

/** Each variant's bundle id (variant.ts), unless a Personal Team build changed it. */
export const BUNDLE_IDS = {
    development: 'com.ingenioventures.socio.dev',
    preview: 'com.ingenioventures.socio.preview',
    production: 'com.ingenioventures.socio',
};

/** Where the app appends its marks, under its data container (src/platform/cold-start.ts). */
export const MARKS_FILE = 'Documents/perf/cold-start.jsonl';

const USAGE = `Usage: node apps/mobile/perf/cold-start-ios.mjs --device <id> --airplane-on [options]

  --airplane-on          airplane mode is on, by hand, and the bench is stopped
  --ssh <user@host>      run xcrun on this Mac over SSH
  --variant <name>       development, preview (default) or production
  --bundle-id <id>       the app's bundle id, when a Personal Team build changed it
  --runs <n>             timed launches after the discarded one (default 10, at least 10)
  --settle-seconds <n>   seconds each launch is left running (default 6)
  --bench <url>          the bench's address, which must not answer
  --server-log <file>    a server or egress log that must not grow during the runs (repeatable)
  --out <file>           write the records and the summary as JSON`;

/** @param {string[]} argv */
export function parseIosArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            device: { type: 'string' },
            'airplane-on': { type: 'boolean', default: false },
            ssh: { type: 'string' },
            variant: { type: 'string', default: 'preview' },
            'bundle-id': { type: 'string' },
            runs: { type: 'string', default: '10' },
            'settle-seconds': { type: 'string', default: '6' },
            bench: { type: 'string' },
            'server-log': { type: 'string', multiple: true, default: [] },
            out: { type: 'string' },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        return { help: true };
    }
    if (!values.device) {
        throw new Error('--device is required (xcrun devicectl list devices).');
    }
    if (!values['airplane-on']) {
        throw new Error('Turn airplane mode on by hand on the phone, then pass --airplane-on.');
    }
    if (!(values.variant in BUNDLE_IDS)) {
        throw new Error(`--variant is development, preview or production, not "${values.variant}".`);
    }
    const runs = Number(values.runs);
    if (!Number.isInteger(runs) || runs < 10) {
        throw new Error('--runs takes 10 or more.');
    }
    const settleSeconds = Number(values['settle-seconds']);
    if (!Number.isFinite(settleSeconds) || settleSeconds < 1) {
        throw new Error('--settle-seconds takes 1 or more.');
    }
    return {
        device: values.device,
        ssh: values.ssh ?? null,
        bundleId: values['bundle-id'] ?? BUNDLE_IDS[values.variant],
        runs,
        settleSeconds,
        bench: values.bench ?? null,
        serverLogs: values['server-log'],
        out: values.out ?? null,
    };
}

/** A shell word, quoted for the remote shell. @param {string} word */
const quote = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * Runs `xcrun args`, locally or on `ssh`'s Mac.
 * @param {string | null} ssh @param {string[]} args
 */
function xcrun(ssh, args) {
    const result = ssh
        ? spawnSync('ssh', ['-o', 'BatchMode=yes', ssh, ['xcrun', ...args].map(quote).join(' ')], { encoding: 'utf8' })
        : spawnSync('xcrun', args, { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`xcrun ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

/** @param {string | null} ssh @param {string} command */
function shell(ssh, command) {
    const result = ssh
        ? spawnSync('ssh', ['-o', 'BatchMode=yes', ssh, command], { encoding: 'utf8' })
        : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string[]} files */
const sizes = (files) => files.map((file) => (existsSync(file) ? statSync(file).size : 0));

async function main() {
    const options = parseIosArgs(process.argv.slice(2));
    if ('help' in options) {
        console.log(USAGE);
        return;
    }
    const { ssh, device, bundleId } = options;
    if (options.bench) {
        // A tunnel's edge still answers for a stopped server (Cloudflare's 530), so only a 2xx counts.
        const answered = await fetch(options.bench, { signal: AbortSignal.timeout(5000) }).then(
            (response) => response.ok,
            () => false,
        );
        if (answered) {
            throw new Error(`${options.bench} still answers: stop the bench (and its tunnel) first.`);
        }
    }
    const pulled = shell(ssh, 'mktemp -t socio-cold-start').trim();
    const pull = () => {
        xcrun(ssh, [
            'devicectl',
            'device',
            'copy',
            'from',
            '--device',
            device,
            '--domain-type',
            'appDataContainer',
            '--domain-identifier',
            bundleId,
            '--source',
            MARKS_FILE,
            '--destination',
            pulled,
        ]);
        return parseRecords(shell(ssh, `cat ${quote(pulled)}`));
    };
    const before = pull().length;
    const logSizes = sizes(options.serverLogs);
    for (let run = 0; run <= options.runs; run += 1) {
        xcrun(ssh, ['devicectl', 'device', 'process', 'launch', '--device', device, '--terminate-existing', bundleId]);
        console.log(run === 0 ? 'discarded launch' : `run ${run}`);
        await sleep(options.settleSeconds * 1000);
    }
    const records = pull().slice(before);
    shell(ssh, `rm -f ${quote(pulled)}`);
    const grown = options.serverLogs.filter((file, index) => sizes([file])[0] !== logSizes[index]);
    const summary = summarize(records, { discard: 1, platform: 'ios' });
    console.log(`\n${formatSummary(summary)}`);
    console.log(`first frames (ms): ${summary.firstFrames.join(', ')}`);
    if (options.serverLogs.length > 0) {
        console.log(
            grown.length === 0
                ? `No request reached the server: ${options.serverLogs.length} log(s) unchanged during the runs.`
                : `These logs grew during the runs: ${grown.join(', ')}`,
        );
    }
    if (options.out) {
        writeFileSync(options.out, `${JSON.stringify({ summary, records, grown }, null, 2)}\n`);
    }
    if (records.length < options.runs + 1) {
        process.exitCode = 1;
        console.error(`Only ${records.length} of ${options.runs + 1} launches wrote their marks.`);
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
