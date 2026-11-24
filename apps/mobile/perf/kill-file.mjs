#!/usr/bin/env node
// Kill mid-filing (the check "filing offline, then going online, makes
// exactly one issue"): files an issue with
// one photo under a unique title, kills the app a random 0 to 2 s after File
// (spread over every phase: the draft and the outbox rows, the create in
// flight, the create answered, the attachment in flight), relaunches it, and
// goes again. Every other round files offline (chaos-proxy.mjs down, as
// airplane mode, which doesn't cut adb reverse) and comes back online at the
// relaunch. Then it waits for the outbox to settle and counts, per title, the
// server's issues and their attachments. It passes only on exactly once:
// every title on exactly one issue with exactly one attachment, and no row
// left in the outbox but `sent` ones (Diagnostics' Outbox line, as
// kill-send.mjs reads it), so nothing `queued`, `unknown` or refused.
//
//   node apps/mobile/perf/kill-file.mjs --device <serial> --credentials <file> --metro <port>
//       [--workspace A] [--variant development] [--rounds 50] [--online-only]
//       [--proxy-control 4459] [--settle-seconds 180] [--seed <n>] [--out <file.json>]
//
// Android only, by itself over adb (an emulator or a phone on USB). The app
// must be signed in to the credentials' workspace with the Board in reach
// (board-open.yaml), a photo seeded (attach-photo.yaml's header), and, unless
// --online-only, chaos-proxy.mjs between the app and the workspace (README,
// Chaos). A filing the kill beat to the outbox is still FileIssue's draft
// (`issue:new`): the next New issue opens on it, and the script files it
// again, as the person would. The script reads the server as Ada (made-up
// local accounts) only to count.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { signedIn } from '../e2e/servers.mjs';

import { androidDevice, MAX_DELAY_MS, outboxLeft, seeded, VARIANTS } from './kill-send.mjs';

/** The words a filing still on its way shows (src/shell/issue-filing.ts, 10.2): any left after the settle fails. */
export const PENDING_WORDS = ['Waiting to send', 'Couldn’t confirm', 'CB-?'];

/** The system photo picker's newest photo (common/pick-photo.yaml). */
const PICKER_PHOTO = /^Photo taken on/i;

const USAGE = `Usage: node apps/mobile/perf/kill-file.mjs --device <serial> --credentials <file> --metro <port> [options]

  --device <serial>       the emulator or phone (adb serial)
  --credentials <file>    servers.mjs's credentials file
  --workspace <letter>    which of its workspaces the app has open (default A)
  --variant <name>        development (default), preview or production
  --metro <port>          a development build's Metro port, for its relaunch link
  --rounds <n>            filings, each killed (default 50)
  --online-only           no offline rounds (no chaos-proxy.mjs running)
  --proxy-control <port>  chaos-proxy.mjs's control port (default 4459)
  --settle-seconds <n>    how long the outbox may take to settle at the end (default 180)
  --seed <n>              the random delays' seed, to repeat a run
  --out <file>            write the rounds and the counts as JSON`;

/** @param {string[]} argv */
export function parseKillFileArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            device: { type: 'string' },
            credentials: { type: 'string' },
            workspace: { type: 'string', default: 'A' },
            variant: { type: 'string', default: 'development' },
            metro: { type: 'string' },
            rounds: { type: 'string', default: '50' },
            'online-only': { type: 'boolean', default: false },
            'proxy-control': { type: 'string', default: '4459' },
            'settle-seconds': { type: 'string', default: '180' },
            seed: { type: 'string' },
            out: { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: USAGE };
    }
    if (!values.device) {
        throw new Error('--device is required: the phone stays the one you mean.');
    }
    if (!values.credentials) {
        throw new Error('--credentials is required: servers.mjs prints its file.');
    }
    if (!(values.variant in VARIANTS)) {
        throw new Error(`--variant is development, preview or production, not "${values.variant}".`);
    }
    if (values.variant === 'development' && values.metro === undefined) {
        throw new Error('A development build relaunches through Metro: give --metro <port>.');
    }
    const rounds = Number(values.rounds);
    if (!Number.isInteger(rounds) || rounds < 1) {
        throw new Error('--rounds takes a whole number from 1.');
    }
    const settle = Number(values['settle-seconds']);
    if (!Number.isFinite(settle) || settle < 0) {
        throw new Error('--settle-seconds takes a number of seconds.');
    }
    /** @param {string | undefined} value @param {string} flag */
    const port = (value, flag) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1024 || number > 65535) {
            throw new Error(`${flag} takes a port, not "${value}".`);
        }
        return number;
    };
    return {
        device: values.device,
        credentials: values.credentials,
        workspace: values.workspace.toUpperCase(),
        variant: values.variant,
        app: VARIANTS[values.variant],
        metro: values.metro === undefined ? null : port(values.metro, '--metro'),
        rounds,
        offline: !values['online-only'],
        proxyControl: port(values['proxy-control'], '--proxy-control'),
        settleSeconds: settle,
        seed: values.seed === undefined ? Date.now() % 2 ** 31 : Number(values.seed),
        out: values.out ?? null,
    };
}

/**
 * Each round's title, delay and whether it files offline. The delays are
 * spread evenly over 0 to 2 s (one per slice, shuffled), so every phase gets
 * kills however few rounds run; with `offline`, every other round files
 * with the server away and comes back online at the relaunch.
 * @param {{ rounds: number, offline: boolean, tag: string, random: () => number }} input
 */
export function filePlan({ rounds, offline, tag, random }) {
    const slices = Array.from({ length: rounds }, (_, index) => index);
    for (let index = slices.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [slices[index], slices[other]] = [slices[other], slices[index]];
    }
    return slices.map((slice, round) => ({
        round: round + 1,
        title: `kf-${tag}-${String(round + 1).padStart(3, '0')}`,
        offline: offline && round % 2 === 0,
        delayMs: Math.round(((slice + random()) / rounds) * MAX_DELAY_MS),
    }));
}

/**
 * Per title: the server's issues with exactly that title and each one's
 * attachments. Exactly once is one issue with one attachment.
 * @param {readonly { number: number, title: string, attachments: number }[]} issues
 * @param {readonly string[]} titles
 */
export function countFilings(issues, titles) {
    const rows = titles.map((title) => {
        const found = issues.filter((issue) => issue.title === title);
        return {
            title,
            numbers: found.map((issue) => issue.number).sort((a, b) => a - b),
            attachments: found.map((issue) => issue.attachments),
        };
    });
    return {
        rows,
        once: rows.filter((row) => row.numbers.length === 1 && row.attachments[0] === 1).length,
        lost: rows.filter((row) => row.numbers.length === 0).map((row) => row.title),
        duplicated: rows.filter((row) => row.numbers.length > 1).map((row) => row.title),
        wrongFiles: rows
            .filter((row) => row.numbers.length === 1 && row.attachments[0] !== 1)
            .map((row) => `${row.title} (${row.attachments[0]} files)`),
    };
}

/**
 * The verdict: every title filed once with one file, no kept draft that lost
 * its photo (the draft's text and tray commit together, so a title without
 * its file is lost data), no pending words on screen, and nothing left in the
 * outbox but `sent` rows.
 * @param {ReturnType<typeof countFilings>} counts
 * @param {number} titles
 * @param {readonly string[]} pending
 * @param {readonly string[]} left
 * @param {number} draftsLostFile
 */
export const passed = (counts, titles, pending, left, draftsLostFile) =>
    counts.once === titles && draftsLostFile === 0 && pending.length === 0 && left.length === 0;

/** Pending words in a uiautomator dump. @param {readonly { text: string, description: string }[]} nodes */
export function pendingOnScreen(nodes) {
    return nodes.flatMap((node) =>
        PENDING_WORDS.filter((words) => node.text.includes(words) || node.description.includes(words)),
    );
}

// ── Running ──

const say = (/** @type {string} */ line) => console.log(`[kill-file] ${line}`);
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/** chaos-proxy.mjs's control: the server away (`down`) or back (`up`). */
async function proxy(/** @type {number} */ port, /** @type {'down' | 'up'} */ action) {
    const response = await fetch(`http://127.0.0.1:${port}/${action}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
        throw new Error(`chaos-proxy ${action} answered ${response.status}.`);
    }
}

/** The workspace's issues as Ada, with each title's attachments counted. */
async function serverOf(/** @type {string} */ file, /** @type {string} */ letter) {
    const credentials = JSON.parse(readFileSync(file, 'utf8'));
    const server = credentials.servers.find((/** @type {{ letter: string }} */ entry) => entry.letter === letter);
    if (!server) {
        throw new Error(`The credentials file has no workspace ${letter}.`);
    }
    const call = await signedIn(
        { port: Number(new URL(server.origin).port), origin: server.origin },
        credentials.accounts[0].email,
        credentials.password,
    );
    return {
        origin: server.origin,
        /** @param {string} prefix */
        async issues(prefix) {
            const list = await (await call('GET', '/api/issues')).json();
            const mine = list.issues.filter((/** @type {{ title: string }} */ issue) => issue.title.startsWith(prefix));
            const counted = [];
            for (const issue of mine) {
                const detail = await (await call('GET', `/api/issues/${issue.number}`)).json();
                counted.push({ number: issue.number, title: issue.title, attachments: detail.attachments.length });
            }
            return counted;
        },
    };
}

/** The filing half on top of kill-send.mjs's adb device. */
function filer(
    /** @type {ReturnType<typeof androidDevice>} */ device,
    /** @type {{ scheme: string, id: string }} */ app,
) {
    const ids = (/** @type {ReturnType<typeof device.dump>} */ nodes) => new Set(nodes.map((node) => node.id));
    /** The screen's nodes; a development client's menu over the app (it shows after a relaunch) is closed first. */
    const dump = () => {
        const nodes = device.dump();
        if (nodes.some((node) => node.text === 'Go home') && nodes.some((node) => node.text === 'Reload')) {
            device.adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
            spawnSync('sleep', ['1']);
            return device.dump();
        }
        return nodes;
    };
    const waitFor = async (/** @type {string} */ id, timeoutMs = 120_000) => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const node = dump().find((entry) => entry.id === id && entry.center);
            if (node?.center) {
                return /** @type {typeof node & { center: { x: number, y: number } }} */ (node);
            }
            await sleep(1000);
        }
        throw new Error(`${id} didn't show in ${timeoutMs / 1000} s.`);
    };
    const keyboardUp = () => /mInputShown=true/.test(device.adb(['shell', 'dumpsys', 'input_method']));
    /** Waits for any of the ids; returns the dump that had one. */
    const waitAny = async (/** @type {string[]} */ wanted, timeoutMs = 120_000) => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const nodes = dump();
            if (wanted.some((id) => ids(nodes).has(id))) {
                return nodes;
            }
            await sleep(1000);
        }
        throw new Error(`None of ${wanted.join(', ')} showed in ${timeoutMs / 1000} s.`);
    };
    /** The Board, through its link (the app is up): the screen New issue sits on. */
    const board = async () => {
        for (let tries = 0; tries < 3; tries += 1) {
            device.adb([
                'shell',
                'am',
                'start',
                '-a',
                'android.intent.action.VIEW',
                '-d',
                `'${app.scheme}://issues'`,
                app.id,
            ]);
            try {
                return await waitFor('board-new-issue', 30_000);
            } catch {
                // A relaunch still loading, or the dev menu over it: the back key, then the link again.
                device.adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
            }
        }
        return waitFor('board-new-issue', 30_000);
    };
    /** Photos, then the picker's newest photo, then its Add or Done; waits for the tray. */
    const attach = async () => {
        if (keyboardUp()) {
            device.adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
            await sleep(500);
        }
        let button = dump().find((node) => node.id === 'composer-attach-photos' && node.center);
        for (let tries = 0; !button && tries < 4; tries += 1) {
            device.adb(['shell', 'input', 'swipe', '540', '1600', '540', '600', '300']);
            await sleep(700);
            button = dump().find((node) => node.id === 'composer-attach-photos' && node.center);
        }
        if (!button?.center) {
            throw new Error('Photos didn’t show on New issue.');
        }
        device.tap(button.center);
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
            const nodes = dump();
            const photo = nodes.find(
                (node) => (PICKER_PHOTO.test(node.description) || PICKER_PHOTO.test(node.text)) && node.center,
            );
            if (photo?.center) {
                device.tap(photo.center);
                await sleep(1500);
                const confirm = dump().find((node) => /^(Add|Done)$/i.test(node.text) && node.center);
                if (confirm?.center) {
                    device.tap(confirm.center);
                }
                // The tray is under the hint, which a long form may leave below the screen.
                const shown = Date.now() + 30_000;
                while (Date.now() < shown) {
                    if (dump().some((node) => node.id === 'composer-tray')) {
                        return;
                    }
                    device.adb(['shell', 'input', 'swipe', '540', '1600', '540', '900', '300']);
                    await sleep(1000);
                }
                throw new Error('The photo didn’t show in the tray in 30 s.');
            }
            await sleep(1000);
        }
        throw new Error('The photo picker showed no photo: seed one (attach-photo.yaml’s header).');
    };
    /**
     * A development client's floating Tools button sits over File after each
     * launch: dragged down out of the way, as common/move-dev-tools.yaml does.
     */
    const moveTools = async () => {
        const tools = dump().find((node) => node.description === 'Tools' && node.center);
        if (tools?.center) {
            const { x, y } = tools.center;
            device.adb(['shell', 'input', 'swipe', String(x), String(y), String(x), String(y + 900), '1500']);
            await sleep(500);
        }
    };
    /** File, once Tools is out of the way; returns when the tap went. */
    const fileButton = async () => {
        await moveTools();
        return waitFor('file-issue-submit', 10_000);
    };
    const submit = async () => {
        const file = await fileButton();
        device.tap(file.center);
    };
    return {
        dump,
        waitFor,
        fileButton,
        board,
        attach,
        submit,
        waitAny,
        /**
         * New issue: when the draft still holds an earlier round's title (the
         * kill beat its filing to the outbox), files it again as it is, as the
         * person would, and opens New issue anew. Returns that title, and the
         * kept titles whose tray came back empty: never re-attached, since a
         * draft that kept its text but lost its photo is a lost attachment.
         */
        async openNew(/** @type {readonly string[]} */ earlier) {
            let restored = null;
            /** @type {string[]} */
            const lostFile = [];
            for (let tries = 0; tries < 3; tries += 1) {
                const entry = await board();
                device.tap(entry.center);
                const title = await waitFor('file-issue-title', 15_000);
                const kept = earlier.find((name) => title.text.includes(name));
                if (kept === undefined) {
                    if (title.text.trim() === '') {
                        return { title, restored, lostFile };
                    }
                    // A draft another run left (a failed one): its title and its files go, so each filing has one.
                    say(`New issue held "${title.text}": cleared`);
                    device.tap(title.center);
                    device.adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
                    device.adb(['shell', 'input', 'keyevent', ...Array(title.text.length).fill('KEYCODE_DEL')]);
                    if (keyboardUp()) {
                        device.adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
                    }
                    for (let swipes = 0; swipes < 3; swipes += 1) {
                        device.adb(['shell', 'input', 'swipe', '540', '1600', '540', '600', '300']);
                    }
                    await sleep(700);
                    for (let left = 0; left < 10; left += 1) {
                        const remove = dump().find((node) => /^composer-tray-.+-remove$/.test(node.id) && node.center);
                        if (!remove?.center) {
                            break;
                        }
                        say('New issue held a file: removed');
                        device.tap(remove.center);
                        await sleep(800);
                    }
                    for (let swipes = 0; swipes < 3; swipes += 1) {
                        device.adb(['shell', 'input', 'swipe', '540', '600', '540', '1600', '300']);
                    }
                    await sleep(700);
                    return { title: await waitFor('file-issue-title', 15_000), restored, lostFile };
                }
                restored = kept;
                // Its photo, if the draft kept one, is in the tray below the fields.
                for (let swipes = 0; swipes < 3; swipes += 1) {
                    device.adb(['shell', 'input', 'swipe', '540', '1600', '540', '600', '300']);
                }
                await sleep(700);
                if (!dump().some((node) => node.id === 'composer-tray')) {
                    say(`${kept} was still the draft without its photo: the file was lost`);
                    lostFile.push(kept);
                }
                await submit();
                await waitAny(['issue-screen'], 30_000);
            }
            throw new Error('New issue kept opening on an earlier filing.');
        },
    };
}

async function run(options) {
    const server = await serverOf(options.credentials, options.workspace);
    const tag = Date.now().toString(36);
    const plan = filePlan({ rounds: options.rounds, offline: options.offline, tag, random: seeded(options.seed) });
    const titles = plan.map((step) => step.title);
    say(`${plan.length} rounds, seed ${options.seed}, titles kf-${tag}-…, at ${server.origin}`);

    const device = androidDevice(options.device, options.app, options.metro);
    const files = filer(device, options.app);
    if (options.metro !== null) {
        // The development build loads from Metro on the host: this run's own rule, removed at the end.
        device.adb(['reverse', `tcp:${options.metro}`, `tcp:${options.metro}`]);
        process.once('exit', () => {
            spawnSync(device.adbPath, ['-s', options.device, 'reverse', '--remove', `tcp:${options.metro}`]);
        });
    }
    if (options.offline) {
        process.once('exit', () => {
            // Never leave the server away for the next run.
            spawnSync('curl', ['-s', '-X', 'POST', `http://127.0.0.1:${options.proxyControl}/up`]);
        });
        await proxy(options.proxyControl, 'up');
    }
    device.kill();
    device.launch();
    const results = [];
    for (const step of plan) {
        const { title, restored, lostFile } = await files.openNew(titles.slice(0, step.round - 1));
        for (const entry of results) {
            if (lostFile.includes(entry.title)) {
                entry.restoredWithoutFile = true;
            }
        }
        device.tap(title.center);
        await sleep(400);
        device.type(step.title);
        await files.attach();
        if (step.offline) {
            await proxy(options.proxyControl, 'down');
        }
        // A person takes a moment before File; the draft has its write by then.
        await sleep(1000);
        const file = await files.fileButton();
        const tapped = Date.now();
        device.tap(file.center);
        await sleep(Math.max(0, step.delayMs - (Date.now() - tapped)));
        const after = Date.now() - tapped;
        device.kill();
        if (step.offline) {
            await proxy(options.proxyControl, 'up');
        }
        device.launch();
        // The relaunch opens on the last screen: the issue as CB-? or its number, or the Board.
        const shown = await files.waitAny(['issue-screen', 'board-screen', 'home-tile-board'], 180_000);
        const where = shown.some((node) => node.id === 'issue-screen') ? 'issue' : 'board';
        const earlier = results.find((entry) => entry.title === restored);
        if (earlier) {
            // The earlier round's filing was still the draft, so this round filed it again first.
            earlier.refiled = true;
        }
        results.push({ ...step, afterMs: after, refiled: false, restoredWithoutFile: false, openedOn: where });
        say(
            `round ${step.round}: ${restored ? `${restored} was still the draft: filed again; ` : ''}${step.offline ? 'offline, ' : ''}killed ${after} ms after File, opened on the ${where}`,
        );
    }
    // The last round's filing may still be the draft: New issue files it as the person would, then Cancel.
    const last = await files.openNew(titles);
    if (last.restored) {
        say(`after the rounds: ${last.restored} was still the draft: filed again`);
        results.at(-1).refiled = true;
    }
    if (last.lostFile.length > 0) {
        results.at(-1).restoredWithoutFile = true;
    }
    const cancel = await files.waitFor('file-issue-cancel', 10_000);
    device.tap(cancel.center);

    // Settle: relaunch once more, online, and wait for every title on the server.
    device.kill();
    device.launch();
    await files.board();
    const until = Date.now() + options.settleSeconds * 1000;
    let counts = countFilings(await server.issues(`kf-${tag}-`), titles);
    let pending = pendingOnScreen(files.dump());
    while (Date.now() < until && (counts.once < titles.length || pending.length > 0)) {
        await sleep(5000);
        counts = countFilings(await server.issues(`kf-${tag}-`), titles);
        pending = pendingOnScreen((await files.board(), files.dump()));
    }
    let tally = await device.readOutbox();
    while (Date.now() < until && outboxLeft(tally).length > 0) {
        await sleep(5000);
        tally = await device.readOutbox();
    }
    const left = outboxLeft(tally);
    const summary = {
        device: options.device,
        variant: options.variant,
        seed: options.seed,
        tag,
        rounds: plan.length,
        offlineRounds: plan.filter((step) => step.offline).length,
        refiledFromDraft: results.filter((step) => step.refiled).length,
        draftsLostFile: results.filter((step) => step.restoredWithoutFile).length,
        openedOnIssue: results.filter((step) => step.openedOn === 'issue').length,
        filedOnce: counts.once,
        lost: counts.lost,
        duplicated: counts.duplicated,
        wrongFiles: counts.wrongFiles,
        pendingLeft: pending,
        outbox: tally,
        outboxLeft: left,
        passed: passed(counts, titles.length, pending, left, results.filter((step) => step.restoredWithoutFile).length),
    };
    console.log(JSON.stringify(summary, null, 4));
    if (options.out) {
        writeFileSync(options.out, `${JSON.stringify({ summary, rounds: results, counts: counts.rows }, null, 4)}\n`);
    }
    process.exitCode = summary.passed ? 0 : 1;
}

if (import.meta.main) {
    try {
        const options = parseKillFileArgs(process.argv.slice(2));
        if ('help' in options) {
            console.log(options.help);
        } else {
            await run(options);
        }
    } catch (error) {
        console.error(`[kill-file] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    }
}
