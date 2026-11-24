#!/usr/bin/env node
// Cold start on an Android phone, offline:
// from the process's start to the chat list's (or Home's) first frame with
// data, from the cache alone.
//
//   node apps/mobile/perf/cold-start-android.mjs --device <serial> [--variant preview]
//       [--apk <file>] [--build] [--fill-seconds 30 | --no-fill] [--runs 10]
//       [--bench <url>] [--server-log <file> ...] [--keep-airplane] [--out <file.json>]
//
// 1. Installs the release build that reaches the bench (`--apk`; `--build` makes it first
//    with Gradle in apps/mobile/android, with Expo's three switches and APP_VARIANT): the
//    development variant through `adb reverse`, or any test variant through an https
//    bench endpoint. Signing in is done before, by hand or with a flow.
// 2. Fills the cache: launches the app online and leaves it `--fill-seconds` to sync.
// 3. Removes every `adb reverse` rule on the phone. The servers must be stopped by now:
//    with `--bench`, it checks the bench answers nothing from this machine.
// 4. Turns airplane mode on (`cmd connectivity airplane-mode enable`).
// 5. One discarded launch, then `--runs` force-stop and launch cycles. Each reads the
//    app's `[cold-start]` log line, the system's "Fully drawn" line (reportFullyDrawn)
//    and `am start -W`'s TotalTime from logcat, and counts the app's `[sync]` warnings:
//    offline, every request fails. Each `--server-log` must not grow meanwhile.
// 6. Turns airplane mode off again (unless `--keep-airplane`) and prints the summary.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { EXPO_ENV, formatSummary, median, parseRecords, summarize } from './cold-start-stats.mjs';

/** Each variant's application id (variant.ts). */
export const APP_IDS = {
    development: 'com.ingenioventures.socio.dev',
    preview: 'com.ingenioventures.socio.preview',
    production: 'com.ingenioventures.socio',
};

const USAGE = `Usage: node apps/mobile/perf/cold-start-android.mjs --device <serial> [options]

  --variant <name>       development, preview (default) or production
  --apk <file>           install this release build first
  --build                build the release first (apps/mobile/android, ./gradlew assembleRelease)
  --fill-seconds <n>     seconds online to fill the cache (default 30)
  --no-fill              skip the fill: the cache is filled already
  --runs <n>             timed launches after the discarded one (default 10, at least 10)
  --bench <url>          the bench's address, which must not answer during the runs
  --server-log <file>    a server or egress log that must not grow during the runs (repeatable)
  --keep-airplane        leave airplane mode on at the end
  --out <file>           write the records and the summary as JSON`;

/** @param {string[]} argv */
export function parseAndroidArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            device: { type: 'string' },
            variant: { type: 'string', default: 'preview' },
            apk: { type: 'string' },
            build: { type: 'boolean', default: false },
            'fill-seconds': { type: 'string', default: '30' },
            'no-fill': { type: 'boolean', default: false },
            runs: { type: 'string', default: '10' },
            bench: { type: 'string' },
            'server-log': { type: 'string', multiple: true, default: [] },
            'keep-airplane': { type: 'boolean', default: false },
            out: { type: 'string' },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        return { help: true };
    }
    if (!values.device) {
        throw new Error('--device is required: the phone stays the one you mean.');
    }
    if (!(values.variant in APP_IDS)) {
        throw new Error(`--variant is development, preview or production, not "${values.variant}".`);
    }
    const runs = Number(values.runs);
    if (!Number.isInteger(runs) || runs < 10) {
        throw new Error('--runs takes 10 or more.');
    }
    const fillSeconds = Number(values['fill-seconds']);
    if (!Number.isFinite(fillSeconds) || fillSeconds < 0) {
        throw new Error('--fill-seconds takes a number of seconds.');
    }
    return {
        device: values.device,
        variant: values.variant,
        appId: APP_IDS[values.variant],
        apk: values.apk ?? null,
        build: values.build,
        fillSeconds: values['no-fill'] ? 0 : fillSeconds,
        runs,
        bench: values.bench ?? null,
        serverLogs: values['server-log'],
        keepAirplane: values['keep-airplane'],
        out: values.out ?? null,
    };
}

/**
 * The "Fully drawn" line's time in ms, from ActivityTaskManager's `+1s234ms`.
 * @param {string} text
 */
export function fullyDrawnMs(text) {
    const match = /Fully drawn [^:]+: \+(?:(\d+)s)?(\d+)ms/.exec(text);
    return match ? Number(match[1] ?? 0) * 1000 + Number(match[2]) : null;
}

/** @param {string} text */
export function totalTimeMs(text) {
    const match = /TotalTime: (\d+)/.exec(text);
    return match ? Number(match[1]) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} serial @param {string[]} args */
function adb(serial, args, { check = true } = {}) {
    const result = spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8' });
    if (check && result.status !== 0) {
        throw new Error(`adb ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

/** @param {string[]} files */
function sizes(files) {
    return files.map((file) => (existsSync(file) ? statSync(file).size : 0));
}

async function main() {
    const options = parseAndroidArgs(process.argv.slice(2));
    if ('help' in options) {
        console.log(USAGE);
        return;
    }
    const { device, appId } = options;
    if (options.build) {
        const android = join(import.meta.dirname, '../android');
        const built = spawnSync('./gradlew', ['assembleRelease'], {
            cwd: android,
            stdio: 'inherit',
            env: { ...process.env, ...EXPO_ENV, APP_VARIANT: options.variant },
        });
        if (built.status !== 0) {
            throw new Error('The release build failed.');
        }
        options.apk ??= join(android, 'app/build/outputs/apk/release/app-release.apk');
    }
    if (options.apk) {
        adb(device, ['install', '-r', options.apk]);
    }
    const sdk = adb(device, ['shell', 'getprop', 'ro.build.version.release']).trim();
    const model = adb(device, ['shell', 'getprop', 'ro.product.model']).trim();
    const component = adb(device, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', appId])
        .trim()
        .split('\n')
        .at(-1);
    if (!component?.includes('/')) {
        throw new Error(`${appId} has no launcher activity on ${device}: is it installed?`);
    }
    const start = () => adb(device, ['shell', 'am', 'start', '-W', '-n', component]);
    const stop = () => adb(device, ['shell', 'am', 'force-stop', appId]);

    if (options.fillSeconds > 0) {
        console.log(`Filling the cache: ${options.fillSeconds} s online.`);
        stop();
        start();
        await sleep(options.fillSeconds * 1000);
    }
    stop();
    adb(device, ['reverse', '--remove-all']);
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
    adb(device, ['shell', 'cmd', 'connectivity', 'airplane-mode', 'enable']);
    await sleep(3000);
    const airplane = adb(device, ['shell', 'settings', 'get', 'global', 'airplane_mode_on']).trim();
    if (airplane !== '1') {
        throw new Error('Airplane mode did not turn on.');
    }
    const logSizes = sizes(options.serverLogs);
    const since = Date.now();

    const records = [];
    const launches = [];
    try {
        for (let run = 0; run <= options.runs; run += 1) {
            stop();
            await sleep(1500);
            adb(device, ['logcat', '-c']);
            const total = totalTimeMs(start());
            let log = '';
            for (let waited = 0; waited < 20_000; waited += 500) {
                await sleep(500);
                log = adb(device, ['logcat', '-d', '-v', 'brief']);
                if (log.includes('[cold-start] ') && fullyDrawnMs(log) !== null) {
                    break;
                }
            }
            // Leave it a moment, so a sync it starts would show its failure.
            await sleep(2500);
            log = adb(device, ['logcat', '-d', '-v', 'brief']);
            const [record] = parseRecords(log);
            const syncWarnings = log.split('\n').filter((line) => line.includes('[sync]')).length;
            launches.push({
                run,
                discarded: run === 0,
                firstFrame: record?.ms.firstFrame ?? null,
                fullyDrawn: fullyDrawnMs(log),
                totalTime: total,
                syncWarnings,
            });
            console.log(
                `${run === 0 ? 'discarded' : `run ${run}`}: first frame ${record?.ms.firstFrame ?? '-'} ms, ` +
                    `Fully drawn ${fullyDrawnMs(log) ?? '-'} ms, TotalTime ${total ?? '-'} ms, [sync] warnings ${syncWarnings}`,
            );
            if (record) {
                records.push(record);
            }
        }
    } finally {
        stop();
        if (!options.keepAirplane) {
            adb(device, ['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], { check: false });
        }
    }
    const grown = options.serverLogs.filter((file, index) => sizes([file])[0] !== logSizes[index]);
    const summary = summarize(records, { since, discard: 1, platform: 'android' });
    const timed = launches.filter((launch) => !launch.discarded);
    console.log(`\n${model}, Android ${sdk}`);
    console.log(formatSummary(summary));
    console.log(
        `Fully drawn (system): median ${summarizeValues(timed.map((l) => l.fullyDrawn))}; ` +
            `am start TotalTime: median ${summarizeValues(timed.map((l) => l.totalTime))}`,
    );
    console.log(
        grown.length === 0
            ? `No request reached the server: ${options.serverLogs.length} log(s) unchanged during the runs.`
            : `These logs grew during the runs: ${grown.join(', ')}`,
    );
    if (options.out) {
        writeFileSync(
            options.out,
            `${JSON.stringify({ model, android: sdk, summary, launches, records, grown }, null, 2)}\n`,
        );
    }
    if (records.length < options.runs + 1) {
        process.exitCode = 1;
        console.error(`Only ${records.length} of ${options.runs + 1} launches wrote their marks.`);
    }
}

/** @param {(number | null)[]} values */
function summarizeValues(values) {
    const value = median(values.filter((v) => typeof v === 'number'));
    return Number.isNaN(value) ? '-' : `${Math.round(value)} ms`;
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
