#!/usr/bin/env node
// Kill mid-send: sends a message,
// kills or locks the app a random 0 to 2 s after the tap (spread over every
// phase of the send: the draft's commit, the outbox row, the request, the
// stream before and after RUN_STARTED), relaunches it, and goes again. Then
// it waits for the outbox to settle and counts, per message, the stored user
// messages and the runs that hold them (a run stores the messages it was
// given: RUN_STARTED's `input.messages`). It passes only on exactly once:
// every message stored once, in one run, and no row left in the outbox but
// `sent` ones: no `queued`, `inflight`, `unknown` or `held` row and no refused
// write. That is read from Diagnostics' Outbox line (src/sync/outbox-tally.ts,
// every row), since the transcript is virtualized and the bubbles on screen
// are only the last few; it also sweeps the screen for pending bubbles
// (Sending…, Waiting to send, Not sent, Couldn’t confirm…). A message the kill left
// unsent waited across a restart, so it asks first: the
// script taps its Send now, as the person would, and counts it.
//
//   node apps/mobile/perf/kill-send.mjs --device <serial> --credentials <file>
//       [--workspace A] [--variant development --metro 8104] [--rounds 30]
//       [--mode kill|lock|mixed] [--chat <id>] [--settle-seconds 120] [--out <file.json>]
//   node apps/mobile/perf/kill-send.mjs --platform ios --device <udid> --credentials <file> [...]
//
// Android runs by itself over adb at `--device` (an emulator or a phone on USB;
// the lock is KEYCODE_SLEEP, then KEYCODE_WAKEUP). Lock rounds run only on an
// emulator: a phone with a screen lock can't be unlocked again over adb, and the
// test phones may be reached remotely, so a lock would leave one locked until
// someone is beside it (`lockRefusal`). On a phone, use `--mode kill`. iOS has no remote control of
// a phone's taps, so there the script leads: it prints each round's message
// and delay, the person sends it and kills (swipes away) or locks the phone,
// reopens the app on the chat and presses Enter; the counting is the same.
//
// The app must be signed in to the credentials' workspace (servers.mjs and the
// sign-in flow) with that origin reachable from the phone (servers.mjs's adb
// reverse, or a tunnel). The script signs in to the server itself, as Ada, only
// to make the chat and read its history: made-up local accounts, nothing else.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

/** Each variant's application id and scheme (variant.ts). */
export const VARIANTS = {
    development: { id: 'com.ingenioventures.socio.dev', scheme: 'socio-dev' },
    preview: { id: 'com.ingenioventures.socio.preview', scheme: 'socio-preview' },
    production: { id: 'com.ingenioventures.socio', scheme: 'socio' },
};

/** A pending bubble's words (src/chat/composer.ts, 10.2): any left after the settle fails the run. */
export const PENDING_WORDS = [
    'Sending…',
    'Waiting to send',
    'Sends when ',
    'Not sent',
    'Couldn’t confirm this was sent',
    'Uploading files…',
    // A message asking first (6.2), not yet tapped.
    'Send now',
];

/** The outbox states a settled run may still hold: only `sent` rows waiting for the store (src/sync/outbox.ts). */
export const SETTLED_STATES = ['sent'];

/**
 * Diagnostics' Outbox line ("Outbox: queued 0 · inflight 0 · …", src/sync/outbox-tally.ts)
 * as counts, or null when the text isn't one.
 * @param {string} text
 * @returns {Record<string, number> | null}
 */
export function parseOutboxTally(text) {
    const at = text.indexOf('Outbox:');
    if (at < 0) {
        return null;
    }
    /** @type {Record<string, number>} */
    const counts = {};
    for (const part of text.slice(at + 'Outbox:'.length).split('·')) {
        const match = /^\s*([a-z]+) (\d+)\s*$/.exec(part);
        if (!match) {
            return null;
        }
        counts[match[1] ?? ''] = Number(match[2]);
    }
    return 'unsent' in counts && 'unknown' in counts ? counts : null;
}

/**
 * What a settled run mustn't hold: every state but `sent` with rows, and refused writes ("unknown 1").
 * @param {Record<string, number> | null} tally
 */
export function outboxLeft(tally) {
    if (tally === null) {
        return ['no Outbox line read'];
    }
    return Object.entries(tally)
        .filter(([state, count]) => count > 0 && !SETTLED_STATES.includes(state))
        .map(([state, count]) => `${state} ${count}`);
}

/** A message that waited across a restart asks first; the person's tap sends it. */
export const SEND_NOW = 'Send now';

/** The longest wait after a tap before the kill or lock. */
export const MAX_DELAY_MS = 2000;

const USAGE = `Usage: node apps/mobile/perf/kill-send.mjs --device <serial> --credentials <file> [options]

  --device <serial>       the phone or emulator (adb serial; on iOS the udid, for the report)
  --platform <name>       android (default, runs by itself) or ios (the person kills by hand)
  --credentials <file>    servers.mjs's credentials file
  --workspace <letter>    which of its workspaces the app has open (default A)
  --variant <name>        development (default), preview or production
  --metro <port>          a development build's Metro port, for its relaunch link
  --rounds <n>            sends, each killed or locked (default 30)
  --mode <mode>           kill (default), lock, or mixed (one lock in four)
  --chat <id>             send in this chat (default: a new "Kill-send" chat with the first socio)
  --settle-seconds <n>    how long the outbox may take to settle at the end (default 120)
  --seed <n>              the random delays' seed, to repeat a run
  --out <file>            write the rounds and the counts as JSON`;

/** @param {string[]} argv */
export function parseKillSendArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            device: { type: 'string' },
            platform: { type: 'string', default: 'android' },
            credentials: { type: 'string' },
            workspace: { type: 'string', default: 'A' },
            variant: { type: 'string', default: 'development' },
            metro: { type: 'string' },
            rounds: { type: 'string', default: '30' },
            mode: { type: 'string', default: 'kill' },
            chat: { type: 'string' },
            'settle-seconds': { type: 'string', default: '120' },
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
    if (!['android', 'ios'].includes(values.platform)) {
        throw new Error(`--platform is android or ios, not "${values.platform}".`);
    }
    if (!values.credentials) {
        throw new Error('--credentials is required: servers.mjs prints its file.');
    }
    if (!(values.variant in VARIANTS)) {
        throw new Error(`--variant is development, preview or production, not "${values.variant}".`);
    }
    if (values.platform === 'android' && values.variant === 'development' && values.metro === undefined) {
        throw new Error('A development build relaunches through Metro: give --metro <port>.');
    }
    if (!['kill', 'lock', 'mixed'].includes(values.mode)) {
        throw new Error(`--mode is kill, lock or mixed, not "${values.mode}".`);
    }
    const rounds = Number(values.rounds);
    if (!Number.isInteger(rounds) || rounds < 1) {
        throw new Error('--rounds takes a whole number from 1.');
    }
    const settle = Number(values['settle-seconds']);
    if (!Number.isFinite(settle) || settle < 0) {
        throw new Error('--settle-seconds takes a number of seconds.');
    }
    const metro = values.metro === undefined ? null : Number(values.metro);
    if (metro !== null && (!Number.isInteger(metro) || metro < 1024 || metro > 65535)) {
        throw new Error(`--metro takes a port, not "${values.metro}".`);
    }
    return {
        device: values.device,
        platform: values.platform,
        credentials: values.credentials,
        workspace: values.workspace.toUpperCase(),
        variant: values.variant,
        app: VARIANTS[values.variant],
        metro,
        rounds,
        mode: values.mode,
        chat: values.chat ?? null,
        settleSeconds: settle,
        seed: values.seed === undefined ? Date.now() % 2 ** 31 : Number(values.seed),
        out: values.out ?? null,
    };
}

/** A small seeded generator (mulberry32), so a run's delays can be repeated. @param {number} seed */
/**
 * Why a run may not lock this Android device, or null when it may: only an
 * emulator (`ro.kernel.qemu` is 1), since nothing can enter a phone's PIN.
 * @param {{ mode: string, qemu: string }} device
 */
export function lockRefusal({ mode, qemu }) {
    if (mode === 'kill' || qemu.trim() === '1') {
        return null;
    }
    return `--mode ${mode} locks the screen, which runs only on an emulator: a phone with a screen lock stays locked until someone unlocks it by hand. Use --mode kill on a phone.`;
}

export function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Each round's message, action and delay. The delays are spread evenly over
 * 0 to 2 s (one per slice, in a shuffled order), so every phase gets kills
 * however few rounds run; `mixed` locks one round in four.
 * @param {{ rounds: number, mode: string, tag: string, random: () => number }} input
 */
export function killPlan({ rounds, mode, tag, random }) {
    const slices = Array.from({ length: rounds }, (_, index) => index);
    for (let index = slices.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [slices[index], slices[other]] = [slices[other], slices[index]];
    }
    return slices.map((slice, round) => ({
        round: round + 1,
        marker: `ks-${tag}-${String(round + 1).padStart(3, '0')}`,
        action: mode === 'lock' || (mode === 'mixed' && round % 4 === 3) ? 'lock' : 'kill',
        delayMs: Math.round(((slice + random()) / rounds) * MAX_DELAY_MS),
    }));
}

/** A message's text, whatever its shape (a string or AG-UI's parts). @param {unknown} content */
function textOf(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    }
    return '';
}

/**
 * Per marker: the stored user messages that carry it, their ids, and how many
 * runs hold them. Exactly once is one message in one run.
 * @param {readonly { runId: string, messages: readonly { id: string, role: string, content?: unknown }[] }[]} runs
 * @param {readonly string[]} markers
 */
export function countDeliveries(runs, markers) {
    const rows = markers.map((marker) => {
        const ids = new Set();
        const runIds = new Set();
        let messages = 0;
        for (const run of runs) {
            for (const message of run.messages) {
                if (message.role === 'user' && textOf(message.content).includes(marker)) {
                    messages += 1;
                    ids.add(message.id);
                    runIds.add(run.runId);
                }
            }
        }
        return { marker, messages, ids: [...ids], runs: runIds.size };
    });
    return {
        rows,
        once: rows.filter((row) => row.messages === 1 && row.runs === 1).length,
        lost: rows.filter((row) => row.messages === 0).map((row) => row.marker),
        duplicated: rows.filter((row) => row.messages > 1 || row.runs > 1).map((row) => row.marker),
    };
}

/** XML attribute values, unescaped. @param {string} value */
const unescape = (value) =>
    value
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');

/**
 * The nodes of a uiautomator dump: resource id (React Native's testID), text,
 * content description and the center of the bounds.
 * @param {string} xml
 */
export function uiNodes(xml) {
    return [...xml.matchAll(/<node\b([^>]*?)\/?>/g)].map(([, attributes]) => {
        const read = (/** @type {string} */ name) => {
            const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes ?? '');
            return match ? unescape(match[1] ?? '') : '';
        };
        const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(read('bounds'));
        const hint = read('hint');
        const text = read('text');
        return {
            id: read('resource-id'),
            // An empty field reads its placeholder as its text.
            text: hint !== '' && text === hint ? '' : text,
            description: read('content-desc'),
            center: bounds
                ? {
                      x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
                      y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
                  }
                : null,
        };
    });
}

/** Pending bubbles' words on screen. @param {ReturnType<typeof uiNodes>} nodes */
export function pendingOnScreen(nodes) {
    return nodes.flatMap((node) =>
        PENDING_WORDS.filter((words) => node.text.includes(words) || node.description.includes(words)).map((words) =>
            words.trim(),
        ),
    );
}

// ── Running ──

const say = (/** @type {string} */ line) => console.log(`[kill-send] ${line}`);
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/** The workspace's API as Ada: the chat to send in and its stored runs. */
export async function serverOf(/** @type {string} */ file, /** @type {string} */ letter) {
    const credentials = JSON.parse(readFileSync(file, 'utf8'));
    const server = credentials.servers.find((/** @type {{ letter: string }} */ entry) => entry.letter === letter);
    if (!server) {
        throw new Error(`The credentials file has no workspace ${letter}.`);
    }
    const origin = server.origin;
    let cookie = '';
    const call = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) => {
        const response = await fetch(origin + path, {
            method,
            redirect: 'manual',
            headers: {
                Origin: origin,
                'User-Agent': 'research-script/0.1',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
            throw new Error(`${method} ${path}: ${response.status}`);
        }
        return response;
    };
    const signIn = await call('POST', '/api/auth/sign-in/email', {
        email: credentials.accounts[0].email,
        password: credentials.password,
    });
    cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
    return {
        origin,
        /** The workspace's chats, for a check by title. */
        async chats() {
            const workspace = await (await call('GET', '/api/workspace')).json();
            return /** @type {{ id: string, title: string }[]} */ (workspace.conversations);
        },
        async newChat(/** @type {string} */ title) {
            const workspace = await (await call('GET', '/api/workspace')).json();
            const dot = workspace.dots[0];
            const chat = await (await call('POST', '/api/conversations', { dotId: dot.id, title })).json();
            return /** @type {string} */ (chat.id);
        },
        async runs(/** @type {string} */ chat) {
            /** @type {{ seq: number, runId: string, messages: { id: string, role: string, content?: unknown }[] }[]} */
            const all = [];
            let after = 0;
            for (let page = 0; page < 200; page += 1) {
                const answer = await (
                    await call('GET', `/api/conversations/${encodeURIComponent(chat)}/history?after=${after}`)
                ).json();
                all.push(...answer.runs);
                if (!answer.more || answer.runs.length === 0) {
                    break;
                }
                after = answer.runs.at(-1).seq;
            }
            return all;
        },
    };
}

/** @param {string} serial */
export function androidDevice(
    serial,
    /** @type {{ id: string, scheme: string }} */ app,
    /** @type {number | null} */ metro,
) {
    const sdk = process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk');
    const path = existsSync(join(sdk, 'platform-tools/adb')) ? join(sdk, 'platform-tools/adb') : 'adb';
    const adb = (/** @type {string[]} */ args) => {
        const result = spawnSync(path, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (result.status !== 0) {
            throw new Error(`adb ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
        }
        return result.stdout;
    };
    const dump = () => {
        for (let tries = 0; tries < 3; tries += 1) {
            const xml = spawnSync(path, ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
            }).stdout;
            if (xml?.includes('<hierarchy')) {
                return uiNodes(xml);
            }
        }
        return [];
    };
    const find = (/** @type {string} */ id) => dump().find((node) => node.id === id) ?? null;
    const tap = (/** @type {{ x: number, y: number }} */ at) =>
        adb(['shell', 'input', 'tap', String(at.x), String(at.y)]);
    const waitFor = async (/** @type {string} */ id, timeoutMs = 120_000) => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const node = find(id);
            if (node?.center) {
                return node;
            }
            await sleep(1000);
        }
        throw new Error(`${id} didn't show in ${timeoutMs / 1000} s.`);
    };
    return {
        adb,
        adbPath: path,
        dump,
        waitFor,
        tap,
        launch() {
            if (metro !== null) {
                const url = `${app.scheme}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metro}`)}&disableOnboarding=1`;
                adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, app.id]);
            } else {
                adb(['shell', 'monkey', '-p', app.id, '-c', 'android.intent.category.LAUNCHER', '1']);
            }
        },
        /** Opens the chat as a person would: the Chats tab, then its row (a link would reach the dev launcher). */
        async openChat(/** @type {string} */ title) {
            const until = Date.now() + 120_000;
            while (Date.now() < until) {
                const nodes = dump();
                const row = nodes.find((node) => node.text.includes(title) && node.center !== null);
                if (row?.center) {
                    tap(row.center);
                    return;
                }
                const tab = nodes.find((node) => node.text === 'Chats' && node.center !== null);
                if (tab?.center) {
                    tap(tab.center);
                } else if (nodes.some((node) => node.id === 'chat-header')) {
                    // The app opened on another chat (its last screen): back to the tabs.
                    adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
                }
                await sleep(1500);
            }
            throw new Error(`The chat "${title}" didn't show in Chats.`);
        },
        kill: () => adb(['shell', 'am', 'force-stop', app.id]),
        async lock() {
            adb(['shell', 'input', 'keyevent', 'KEYCODE_SLEEP']);
            await sleep(4000);
            adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
            adb(['shell', 'wm', 'dismiss-keyguard']);
            await sleep(1000);
            if (/isKeyguardShowing=true/.test(adb(['shell', 'dumpsys', 'window']))) {
                throw new Error(
                    'The screen is still locked after the lock round: stopping, so nothing taps a lock screen.',
                );
            }
        },
        type: (/** @type {string} */ text) => adb(['shell', 'input', 'text', text]),
        /** Opens Diagnostics (development and preview builds), reads its Outbox line, and goes back. */
        async readOutbox() {
            adb([
                'shell',
                'am',
                'start',
                '-a',
                'android.intent.action.VIEW',
                '-d',
                `'${app.scheme}://diagnostics'`,
                app.id,
            ]);
            try {
                const node = await waitFor('diagnostics-outbox', 30_000);
                return parseOutboxTally(node.text);
            } catch {
                return null;
            } finally {
                adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
                await sleep(1500);
            }
        },
        /** Taps each "Send now" on screen: a message that waited across the restart asks first (6.2). */
        sendHeld() {
            const held = dump().filter((node) => node.text === SEND_NOW && node.center !== null);
            for (const node of held) {
                tap(/** @type {{ x: number, y: number }} */ (node.center));
            }
            return held.length;
        },
    };
}

async function runAndroid(options, plan, title) {
    const device = androidDevice(options.device, options.app, options.metro);
    const refusal = lockRefusal({ mode: options.mode, qemu: device.adb(['shell', 'getprop', 'ro.kernel.qemu']) });
    if (refusal) {
        throw new Error(refusal);
    }
    say(`opening "${title}" on ${options.device}`);
    if (options.metro !== null) {
        // The development build loads from Metro on the host: this run's own rule, removed at the end.
        device.adb(['reverse', `tcp:${options.metro}`, `tcp:${options.metro}`]);
        process.once('exit', () => {
            spawnSync(device.adbPath, ['-s', options.device, 'reverse', '--remove', `tcp:${options.metro}`]);
        });
    }
    device.kill();
    device.launch();
    await device.openChat(title);
    await device.waitFor('chat-composer-input');
    const results = [];
    for (const step of plan) {
        const input = await device.waitFor('chat-composer-input');
        device.tap(input.center);
        await sleep(400);
        device.type(step.marker);
        // A person takes a moment before Send; the draft has its write by then.
        await sleep(1000);
        const send = await device.waitFor('chat-composer-send', 10_000);
        const tapped = Date.now();
        device.tap(send.center);
        await sleep(Math.max(0, step.delayMs - (Date.now() - tapped)));
        const after = Date.now() - tapped;
        if (step.action === 'kill') {
            device.kill();
            device.launch();
        } else {
            await device.lock();
        }
        // After the relaunch the chat opens again (the last screen); a send the kill beat is still in the box.
        const box = await device.waitFor('chat-composer-input');
        // A message the kill left unsent waited across the restart, so it asks first: tap as a person would.
        await sleep(2000);
        const held = device.sendHeld();
        const restored = box.text.includes(step.marker);
        if (restored) {
            const again = await device.waitFor('chat-composer-send', 10_000);
            device.tap(again.center);
        } else if (box.text.trim() !== '' && !PENDING_WORDS.some((words) => box.text.includes(words))) {
            // Something else was left in the box: say so, since the next round types after it.
            say(`round ${step.round}: the box held "${box.text}"`);
        }
        results.push({ ...step, afterMs: after, restored, held });
        say(
            `round ${step.round}: ${step.action} ${after} ms after Send${restored ? ', back in the box: sent again' : ''}${held ? `, ${held} asked first: Send now` : ''}`,
        );
    }
    // Settle: relaunch once more, online, and wait for the bubbles to clear.
    device.kill();
    device.launch();
    await device.waitFor('chat-composer-input');
    return {
        results,
        pending: async () => {
            device.sendHeld();
            return pendingOnScreen(device.dump());
        },
        outbox: () => device.readOutbox(),
    };
}

async function runIos(options, plan) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const results = [];
    say('iOS: you send and kill by hand. Keep the app open on the chat.');
    for (const step of plan) {
        await prompt.question(
            `\nRound ${step.round}/${plan.length}: type "${step.marker}", tap Send, then after about ${(step.delayMs / 1000).toFixed(1)} s ${
                step.action === 'kill' ? 'swipe the app away' : 'lock the phone'
            }. Reopen it on the chat (unlock first), then press Enter. `,
        );
        const asked = await prompt.question('Did a bubble ask first (Send now)? If so, tap it. [y/N] ');
        const answer = await prompt.question('Was the text back in the box after reopening? [y/N] ');
        const restored = /^y/i.test(answer.trim());
        if (restored) {
            await prompt.question('Tap Send again, then press Enter. ');
        }
        results.push({ ...step, afterMs: null, restored, held: /^y/i.test(asked.trim()) ? 1 : 0 });
    }
    let pendingAnswer = '';
    return {
        results,
        pending: async () => {
            pendingAnswer = await prompt.question(
                '\nAny bubble still saying Sending…, Waiting to send, Not sent or Couldn’t confirm? Type its words, or Enter for none: ',
            );
            return pendingAnswer.trim() === '' ? [] : [pendingAnswer.trim()];
        },
        outbox: async () => {
            const line = await prompt.question(
                '\nOpen Diagnostics (the <scheme>://diagnostics link) and type its Outbox line (queued 0 · inflight 0 · …): ',
            );
            prompt.close();
            return parseOutboxTally(`Outbox: ${line.replace(/^\s*Outbox:/, '')}`);
        },
    };
}

async function main() {
    const options = parseKillSendArgs(process.argv.slice(2));
    if ('help' in options) {
        console.log(options.help);
        return;
    }
    const server = await serverOf(options.credentials, options.workspace);
    const tag = Date.now().toString(36);
    const title = `Kill-send ${tag}`;
    const chat = options.chat ?? (await server.newChat(title));
    const shown =
        options.chat === null ? title : ((await server.chats()).find((entry) => entry.id === chat)?.title ?? title);
    const plan = killPlan({ rounds: options.rounds, mode: options.mode, tag, random: seeded(options.seed) });
    say(`${plan.length} rounds (${options.mode}), seed ${options.seed}, chat ${chat} at ${server.origin}`);
    const run = options.platform === 'android' ? await runAndroid(options, plan, shown) : await runIos(options, plan);

    const markers = plan.map((step) => step.marker);
    const until = Date.now() + options.settleSeconds * 1000;
    let counts = countDeliveries(await server.runs(chat), markers);
    let pending = await run.pending();
    while (Date.now() < until && (counts.once + counts.duplicated.length < markers.length || pending.length > 0)) {
        await sleep(5000);
        counts = countDeliveries(await server.runs(chat), markers);
        pending = options.platform === 'android' ? await run.pending() : pending;
    }
    // The bubbles on screen are only the last few: the outbox's own count settles it.
    let tally = await run.outbox();
    while (options.platform === 'android' && Date.now() < until && outboxLeft(tally).length > 0) {
        await sleep(5000);
        tally = await run.outbox();
    }
    const left = outboxLeft(tally);
    const summary = {
        device: options.device,
        platform: options.platform,
        variant: options.variant,
        seed: options.seed,
        chat,
        rounds: plan.length,
        kills: run.results.filter((step) => step.action === 'kill').length,
        locks: run.results.filter((step) => step.action === 'lock').length,
        restoredFromBox: run.results.filter((step) => step.restored).length,
        askedFirst: run.results.reduce((sum, step) => sum + step.held, 0),
        deliveredOnce: counts.once,
        lost: counts.lost,
        duplicated: counts.duplicated,
        pendingLeft: pending,
        outbox: tally,
        outboxLeft: left,
        passed: counts.once === markers.length && pending.length === 0 && left.length === 0,
    };
    console.log(JSON.stringify(summary, null, 4));
    if (options.out) {
        writeFileSync(
            options.out,
            `${JSON.stringify({ summary, rounds: run.results, counts: counts.rows }, null, 4)}\n`,
        );
    }
    process.exitCode = summary.passed ? 0 : 1;
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`[kill-send] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    });
}
