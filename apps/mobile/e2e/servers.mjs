#!/usr/bin/env node
// Local Socio servers for the app's end-to-end flows:
// the fake model and one to three workspaces, each a server from this checkout's
// `pnpm run build`, with Better Auth accounts and different seeded data: chats
// and a Space, a room Ada and Ben share, and issues, memories, a profile and a
// repeating task.
//
//   node apps/mobile/e2e/servers.mjs [--count 1-3 | --ports 4351,4352,4353]
//       [--model-port 4550] [--control 4549] [--device <serial>] [--no-adb] [--once]
//       [--capture <dir>] [--no-rooms] [--dev-links] [--codes] [--feature-flags <list>]
//
// Every child gets an environment built from scratch (PATH, plus the
// recipe's settings), so no key or token from the shell reaches a server.
// The servers, the auth CLI and the fake model run under
// scripts/egress-log.mjs, and the teardown names any connection it logged
// outside the machine. Ctrl-C stops everything, removes the adb reverse
// rules this run added and deletes the temporary folder. Loopback HTTP on the
// control port restarts the workspaces on their own databases:
// `POST /restart` (a new process, sessions and data kept, nothing seeded
// again: only the first start seeds), `POST
// /restart?ahead=<days>` with the servers' clock that many days ahead
// (clock-ahead.mjs: a session past its expiry), `?ahead=0` back to the real one.
// A restart also takes the app versions the servers serve (CB-553): `minimum=<version>`
// and `recommended=<version>` (APP_MINIMUM_VERSION, APP_RECOMMENDED_VERSION: Update
// Socio, the banner), for every workspace or, as `minimum=<letter>:<version>`, for one;
// and `version=<letter>:<version>` the server version one workspace reports
// (server-version.mjs: "needs a server update" there alone). Each is repeatable, and each
// restart starts from what it names: a plain `POST /restart` is back to the defaults.
// With --codes each workspace also sends sign-in codes to an SMTP sink
// and a fake Telegram of its own (web-side.mjs), and the control port plays Ada
// on the web: the codes sent, Add a device's QR code and 6 digits, and Sign out
// and erase (README, Getting in).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

import { fakeCloud } from './fake-cloud.mjs';
import {
    eraseDevices,
    fakeTelegramAt,
    FAKE_BOT_TOKEN,
    outbox,
    seedChannels,
    setSocialPolicy,
    smtpSink,
    webPairing,
    webSession,
} from './web-side.mjs';

/** The repository root, which holds the build (`dist/`) the servers run. */
export const ROOT = resolve(import.meta.dirname, '../../..');

/** Clear of 4310, 4312, 4331 and 4340, which other servers on the machine use. */
export const DEFAULT_PORTS = [4351, 4352, 4353];
export const DEFAULT_MODEL_PORT = 4550;
export const DEFAULT_CONTROL_PORT = 4549;
/** --social's fake cloud services (fake-cloud.mjs). */
export const DEFAULT_CLOUD_PORT = 4548;
/** Cy (deactivated) is linked to Google and Apple as this test account, for the `deactivated` refusal. */
export const CY_SOCIAL_ACCOUNT = 'cy-test';

/** Fixed: these servers are local and hold made-up accounts only. */
export const SESSION_SECRET = 'socio-e2e-local-session-secret-not-for-real-use';

/**
 * The same people in every workspace. Cy is deactivated, for BANNED_USER. Opal, a second admin,
 * only sets the workspace's branding and its access policy, so the app shows its name. Ada, the
 * first admin, is the workspace owner.
 */
export const ACCOUNTS = [
    { email: 'ada@example.test', name: 'Ada', role: 'admin', deactivated: false },
    { email: 'ben@example.test', name: 'Ben', role: 'member', deactivated: false },
    { email: 'cy@example.test', name: 'Cy', role: 'member', deactivated: true },
    { email: 'opal@example.test', name: 'Opal', role: 'admin', deactivated: false },
];

/** Opal's email: she sets the branding and the access policy. */
const OPAL = 'opal@example.test';

/** The bundled logo the branding keeps (packages/shared's DEFAULT_BRANDING): the app shows its mascot. */
export const BRANDING_LOGO = '/favicon.svg';
const CLOCK_AHEAD = './apps/mobile/e2e/clock-ahead.mjs';
const SERVER_VERSION = './apps/mobile/e2e/server-version.mjs';
const DAY_MS = 24 * 60 * 60 * 1000;

const LETTERS = ['A', 'B', 'C'];
const EGRESS_LOG = './scripts/egress-log.mjs';
const SERVER_ENTRY = 'dist/server/server/index.js';
const AUTH_CLI_ENTRY = 'dist/server/server/auth/auth-cli.js';

const USAGE = `Usage: node apps/mobile/e2e/servers.mjs [options]

  --count <1-3>        how many workspaces, on the first of ${DEFAULT_PORTS.join(', ')} (default 1)
  --ports <list>       the workspaces' ports instead, comma-separated, one to three
  --model-port <port>  the fake model's port (default ${DEFAULT_MODEL_PORT})
  --control <port>     the loopback control port: POST /restart[?ahead=<days>&minimum=[<letter>:]<v>&recommended=…&version=<letter>:<v>]
                       (default ${DEFAULT_CONTROL_PORT})
  --device <serial>    the Android device for adb reverse (default: ANDROID_SERIAL, or the only one)
  --no-adb             skip adb reverse (an iOS simulator over an SSH tunnel)
  --once               seed, print the credentials file, and tear down
  --capture <dir>      write the first workspace's room history and transcript, as Ada and as Ben, there
  --no-rooms           Rooms off and no room seeded (chat-tour.yaml: a room can't be archived from the app)
  --dev-links          Add a device links for the development build (AUTH_APP_DEV_LINKS)
  --feature-flags <l>  FEATURE_FLAGS for every workspace (datasets-in-spaces=on, CB-469)
  --codes              sign-in codes: an SMTP sink and a fake Telegram per workspace, email on A, Telegram elsewhere
  --social             Google and Apple sign-in (CB-570): every workspace enrolls with a fake cloud that verifies test accounts
  --cloud-port <port>  the fake cloud's port (default ${DEFAULT_CLOUD_PORT})`;

/** @param {string} value @param {string} flag */
function port(value, flag) {
    const number = Number(value);
    if (!/^\d+$/.test(value) || number < 1024 || number > 65535) {
        throw new Error(`${flag} takes ports from 1024 to 65535, not "${value}".`);
    }
    return number;
}

/**
 * Reads the command line. Throws with a message for anything it can't use.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseServerArgs(argv, env = {}) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            count: { type: 'string' },
            ports: { type: 'string' },
            'model-port': { type: 'string' },
            control: { type: 'string' },
            device: { type: 'string' },
            'no-adb': { type: 'boolean', default: false },
            once: { type: 'boolean', default: false },
            capture: { type: 'string' },
            'no-rooms': { type: 'boolean', default: false },
            'dev-links': { type: 'boolean', default: false },
            'feature-flags': { type: 'string' },
            codes: { type: 'boolean', default: false },
            social: { type: 'boolean', default: false },
            'cloud-port': { type: 'string' },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: USAGE };
    }
    if (values.capture !== undefined && values['no-rooms']) {
        throw new Error('--capture writes the room, which --no-rooms leaves out.');
    }
    if (values.count !== undefined && values.ports !== undefined) {
        throw new Error('Give --count or --ports, not both.');
    }
    let ports = DEFAULT_PORTS.slice(0, 1);
    if (values.count !== undefined) {
        const count = Number(values.count);
        if (![1, 2, 3].includes(count) || !/^\d$/.test(values.count)) {
            throw new Error(`--count is 1, 2 or 3, not "${values.count}".`);
        }
        ports = DEFAULT_PORTS.slice(0, count);
    } else if (values.ports !== undefined) {
        ports = values.ports.split(',').map((entry) => port(entry.trim(), '--ports'));
        if (ports.length < 1 || ports.length > 3) {
            throw new Error(`--ports takes one to three ports, not ${ports.length}.`);
        }
    }
    const modelPort =
        values['model-port'] === undefined ? DEFAULT_MODEL_PORT : port(values['model-port'], '--model-port');
    const control = values.control === undefined ? DEFAULT_CONTROL_PORT : port(values.control, '--control');
    const cloudPort =
        values['cloud-port'] === undefined ? DEFAULT_CLOUD_PORT : port(values['cloud-port'], '--cloud-port');
    if (values['cloud-port'] !== undefined && !values.social) {
        throw new Error('--cloud-port is for --social.');
    }
    const all = [...ports, modelPort, control, ...(values.social ? [cloudPort] : [])];
    if (new Set(all).size !== all.length) {
        throw new Error("Every port must be different, the fake model's, the control's and the cloud's included.");
    }
    return {
        ports,
        modelPort,
        control,
        device: values.device ?? (env.ANDROID_SERIAL || undefined),
        adb: !values['no-adb'],
        once: values.once,
        capture: values.capture ? resolve(values.capture) : undefined,
        rooms: !values['no-rooms'],
        devLinks: values['dev-links'],
        featureFlags: values['feature-flags'],
        codes: values.codes,
        social: values.social ? { cloudPort } : null,
    };
}

/**
 * One server's environment, from scratch: PATH and the recipe's settings,
 * nothing from the shell or a .env. The provider is the fake model. Rooms
 * start on unless `rooms` is false (`--no-rooms`).
 * With `channels` (--codes), SMTP to the sink and Telegram to the fake Bot API.
 * With `cloud` (--social), the fake cloud's issuer and one enrollment token for this server.
 * @param {{ port: number, home: string, modelPort: number, path?: string, rooms?: boolean, devLinks?: boolean, featureFlags?: string, channels?: { smtpPort: number, telegramRoot: string }, cloud?: { issuer: string, token: string } }} options
 * @returns {Record<string, string>}
 */
export function serverEnv({
    port: serverPort,
    home,
    modelPort,
    path = '',
    rooms = true,
    devLinks = false,
    channels,
    featureFlags,
    cloud,
}) {
    return {
        PATH: path,
        HOME: home,
        HOST: '127.0.0.1',
        PORT: String(serverPort),
        DATABASE_PATH: join(home, 'brain.sqlite'),
        // The default, data/backups, is relative to the working directory and would be shared.
        BACKUP_DIR: join(home, 'backups'),
        BACKUP_INTERVAL_HOURS: '0',
        AUTH_PROVIDER: 'betterauth',
        APP_ORIGIN: `http://localhost:${serverPort}`,
        SESSION_SECRET,
        // A fresh database seeds its first inference backend from these, which
        // POST /api/conversations needs (503 "Setup required" without one).
        OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
        OPENAI_MODEL: 'fake-model',
        OPENAI_API_KEY: 'unused',
        TELEGRAM_BOT_TOKEN: '',
        ...(channels
            ? {
                  SMTP_URL: `smtp://127.0.0.1:${channels.smtpPort}`,
                  SMTP_FROM: 'socio@example.test',
                  TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
                  TELEGRAM_POLLING: 'true',
                  TELEGRAM_API_ROOT: channels.telegramRoot,
              }
            : {}),
        // Settings → General → Rooms starts on, for the seeded room (an admin's choice would win).
        ...(rooms ? { ROOMS_ENABLED: 'true' } : {}),
        // --dev-links: a development build can Add a device here (links on link-staging.socio.sh).
        ...(devLinks ? { AUTH_APP_DEV_LINKS: 'true' } : {}),
        // --feature-flags: this instance's flag defaults (datasets-in-spaces=on for CB-469's checks).
        // An internal deployment, so flags in development may be on (CB-503).
        ...(featureFlags ? { FEATURE_FLAGS: featureFlags, SOCIO_DEPLOYMENT_KIND: 'internal' } : {}),
        // --social: the fake cloud services (fake-cloud.mjs), on loopback; otherwise the cloud
        // connection has no enrollment token and sends nothing.
        ...(cloud ? { SOCIO_CLOUD_ISSUER: cloud.issuer, SOCIO_CLOUD_ENROLLMENT_TOKEN: cloud.token } : {}),
        OPS_ANALYTICS_MODE: 'off',
        OPS_PRICE_SYNC: 'off',
        OTEL_SDK_DISABLED: 'true',
        DO_NOT_TRACK: '1',
    };
}

/**
 * What each workspace gets: a name, a Space with a page and its subpage (for the
 * library and tree), a marker chat with one turn (its
 * message asks the fake model for its long answer, so the chat screen has a
 * transcript taller than the phone) and an archived chat, each with its
 * letter, so a flow can tell the workspaces apart and see the archived chat
 * left out of the list. With `rooms` false (`--no-rooms`) Rooms stay off and
 * there is no room (`room: null`), so a flow can empty the chat list.
 * @param {{ ports: number[], modelPort: number, dir: string, path?: string, rooms?: boolean, devLinks?: boolean, featureFlags?: string, channels?: Array<{ smtpPort: number, telegramRoot: string }>, clouds?: Array<{ issuer: string, token: string }> }} options
 */
export function seedPlan({
    ports,
    modelPort,
    dir,
    path = '',
    rooms = true,
    devLinks = false,
    featureFlags,
    channels,
    clouds,
}) {
    if (ports.length < 1 || ports.length > LETTERS.length) {
        throw new Error(`The seed plan has one to ${LETTERS.length} workspaces, not ${ports.length}.`);
    }
    return ports.map((serverPort, index) => {
        const letter = LETTERS[index];
        const home = join(dir, `ws${index + 1}`);
        return {
            letter,
            port: serverPort,
            origin: `http://localhost:${serverPort}`,
            home,
            log: join(dir, `server-${serverPort}.log`),
            env: serverEnv({
                port: serverPort,
                home,
                modelPort,
                path,
                rooms,
                devLinks,
                featureFlags,
                channels: channels?.[index],
                cloud: clouds?.[index],
            }),
            workspaceName: `Workspace ${letter}`,
            chat: `${letter}: kickoff`,
            message: `${letter}: smoke long`,
            space: `${letter} only`,
            page: `${letter}: handbook`,
            subpage: `${letter}: first week`,
            archivedChat: `${letter}: archived`,
            ...(rooms ? a2Seeds(letter) : { room: null }),
            ...a3Seeds(letter),
        };
    });
}

/** A week, the repeating task's interval: it runs once when seeded, then not again during a session. */
export const TASK_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/**
 * What the issue, memory and schedule screens read, per workspace: one issue in each status
 * (the Board's columns and won't fix), the triage one filed by Ben, a member;
 * Ben's vote and comment on the open one; a picture on the one in progress;
 * two memories and a profile for Ada, and a socio's proposal waiting for her
 * (a3-tour.yaml approves it); and a repeating task, in a chat of its own so
 * the marker chat's transcript stays as it is. Goals and jobs have no
 * HTTP create (only socio tools make them), so they stay on the fake server
 * in the Node tests.
 * @param {string} letter
 */
export function a3Seeds(letter) {
    return {
        issues: [
            { status: 'triage', by: 'ben', title: `${letter}: Search misses accents`, kind: 'bug', priority: 'medium' },
            {
                status: 'open',
                by: 'ada',
                title: `${letter}: Export the board as CSV`,
                kind: 'feature',
                priority: 'high',
                vote: true,
                comment: `${letter}: We need this for the monthly report.`,
            },
            {
                status: 'ready',
                by: 'ada',
                title: `${letter}: Shorter onboarding`,
                kind: 'improvement',
                priority: 'medium',
            },
            {
                status: 'in_progress',
                by: 'ada',
                title: `${letter}: Chat header overlaps the notch`,
                kind: 'bug',
                priority: 'critical',
                picture: 'header-overlap.png',
            },
            {
                status: 'in_review',
                by: 'ada',
                title: `${letter}: Document the import format`,
                kind: 'docs',
                priority: 'low',
            },
            { status: 'blocked', by: 'ada', title: `${letter}: Calendar sync`, kind: 'feature', priority: 'high' },
            { status: 'done', by: 'ada', title: `${letter}: Dark mode`, kind: 'feature', priority: 'medium' },
            {
                status: 'wont_fix',
                by: 'ada',
                title: `${letter}: Fax integration`,
                kind: 'feature',
                priority: 'low',
                resolution: 'Out of scope.',
            },
        ],
        memories: [`${letter}: Ada prefers short answers.`, `${letter}: The team ships on Thursdays.`],
        proposal: `${letter}: Ada reviews the board every Monday morning.`,
        profile: { name: 'Ada', role: `Admin, Workspace ${letter}`, timezone: 'Europe/Madrid' },
        task: {
            prompt: `${letter}: weekly digest of the board`,
            intervalSeconds: TASK_INTERVAL_SECONDS,
            chat: `${letter}: digest`,
        },
    };
}

/**
 * A small PNG (96 by 64, a two-color gradient) for the picture attachment:
 * the server checks an attachment's type from its bytes.
 */
export function seedPicture() {
    const width = 96;
    const height = 64;
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 3 + 1);
        for (let x = 0; x < width; x++) {
            const at = row + 1 + x * 3;
            rows[at] = Math.round(40 + (180 * x) / width);
            rows[at + 1] = 90;
            rows[at + 2] = Math.round(200 - (120 * y) / height);
        }
    }
    const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Which of a workspace's issue and memory seeds the server's answers lack, as lines; empty
 * when all are there. `details` are the issue details by title, for the vote,
 * comment and picture the list doesn't carry.
 * @param {ReturnType<typeof a3Seeds>} plan
 * @param {{ issues: { issues: Array<{ title: string, status: string, votes?: number }> },
 *   details: Record<string, { comments?: unknown[], attachments?: Array<{ mediaType: string }> } | undefined>,
 *   memories: { profile: { fields: Record<string, string | undefined> } | null, memories: Array<{ text: string }>,
 *     proposals?: Array<{ text: string }> },
 *   schedules: { schedules: Array<{ prompt: string, intervalSeconds: number | null, threadId: string | null,
 *     lastRun?: { finishedAt: number | null } | null }> },
 *   conversations: Array<{ id: string, title?: string | null }> }} found
 */
export function missingSeeds(plan, found) {
    const missing = [];
    for (const issue of plan.issues) {
        const listed = found.issues.issues.find((row) => row.title === issue.title);
        if (!listed || listed.status !== issue.status) {
            missing.push(`issue "${issue.title}" in ${issue.status}`);
            continue;
        }
        if (issue.vote && (listed.votes ?? 0) < 1) {
            missing.push(`a vote on "${issue.title}"`);
        }
        const detail = found.details[issue.title];
        if (issue.comment && !detail?.comments?.length) {
            missing.push(`a comment on "${issue.title}"`);
        }
        if (issue.picture && !detail?.attachments?.some((file) => file.mediaType === 'image/png')) {
            missing.push(`a picture on "${issue.title}"`);
        }
    }
    for (const text of plan.memories) {
        if (!found.memories.memories.some((memory) => memory.text === text)) {
            missing.push(`memory "${text}"`);
        }
    }
    if (!found.memories.proposals?.some((memory) => memory.text === plan.proposal)) {
        missing.push(`proposal "${plan.proposal}"`);
    }
    for (const [field, value] of Object.entries(plan.profile)) {
        if (found.memories.profile?.fields[field] !== value) {
            missing.push(`the profile's ${field}`);
        }
    }
    const task = found.schedules.schedules.find((schedule) => schedule.prompt === plan.task.prompt);
    if (!task || task.intervalSeconds !== plan.task.intervalSeconds || !task.threadId) {
        missing.push(`repeating task "${plan.task.prompt}" in /api/schedules`);
        return missing;
    }
    if (!task.lastRun?.finishedAt) {
        missing.push(`the finished first run of "${plan.task.prompt}"`);
    }
    if (found.conversations.find((chat) => chat.id === task.threadId)?.title !== plan.task.chat) {
        missing.push(`the task's chat named "${plan.task.chat}" again`);
    }
    return missing;
}

/** How a room's handoff note is marked (`@socio/shared/rooms/room-handoffs`). */
export const HANDOFF_NOTE_SOURCE = 'room_handoff';

/**
 * What the room screens read, per workspace: a room Ada makes with Sebas
 * as its lead and Manny, a second company socio, and Ben invited, who joins.
 * Three messages make its history: Ada's opening, whose turn calls tools (so
 * Ben's copy has its results withheld); Ada's mention of both socios, which
 * Sebas answers and then hands to Manny (a handoff note); and Ben's, sent
 * under a one-token limit so its turn fails, after which the limit goes.
 * Every text avoids the fake model's phrases read from a chat's first
 * message (`smoke trace`, `smoke data`, ...), since every later turn's model
 * request starts with the opening.
 * @param {string} letter
 */
export function a2Seeds(letter) {
    return {
        room: {
            title: `${letter}: launch room`,
            description: `Ada and Ben plan the launch in ${letter}.`,
            lead: 'Sebas',
            second: { name: 'Manny', character: 'manny' },
            opening: `${letter}: smoke context 1: what can you see from here?`,
            handoff: `@Sebas @Manny ${letter}: plan the launch together.`,
            failing: `${letter}: smoke context 2: one more look, please.`,
        },
    };
}

/**
 * Which of a workspace's room seeds the server's answers lack, as lines; empty
 * when all are there. `room` is Ada's `GET /api/rooms/:id`; `ada` and `ben`
 * are each one's `/history` of it (the newest page, which holds all of it).
 * @param {ReturnType<typeof a2Seeds>['room']} plan
 * @param {{ room: { title: string, dotId: string, members: Array<{ name: string, status: string }>,
 *     socios: Array<{ dotId: string, name: string, status: string }> } | null,
 *   ada: { runs: Array<{ status: string, messages: Array<{ id: string, role: string, content?: unknown, metadata?: Record<string, unknown> }> }> },
 *   ben: { runs: Array<{ status: string, messages: Array<{ id: string, role: string, content?: unknown, metadata?: Record<string, unknown> }> }> } }} found
 */
export function missingRoomSeeds(plan, found) {
    const { room } = found;
    if (!room || room.title !== plan.title) {
        return [`room "${plan.title}"`];
    }
    const missing = [];
    const lead = room.socios.find((socio) => socio.dotId === room.dotId);
    if (lead?.name !== plan.lead || lead.status !== 'active') {
        missing.push(`${plan.lead} as the room's lead`);
    }
    if (!room.socios.some((socio) => socio.name === plan.second.name && socio.status === 'active')) {
        missing.push(`${plan.second.name} active in the room`);
    }
    for (const name of ['Ada', 'Ben']) {
        if (!room.members.some((member) => member.name === name && member.status === 'active')) {
            missing.push(`${name} a member of the room`);
        }
    }
    const said = (/** @type {string} */ text) =>
        found.ada.runs.find((run) =>
            run.messages.some((message) => message.role === 'user' && message.content === text),
        );
    if (said(plan.opening)?.status !== 'finished') {
        missing.push(`the lead's answer to "${plan.opening}"`);
    }
    const notes = found.ada.runs.filter((run) =>
        run.messages.some((message) => message.metadata?.socioSource === HANDOFF_NOTE_SOURCE),
    );
    if (!said(plan.handoff) || !notes.some((run) => run.status === 'finished')) {
        missing.push(`a handoff after "${plan.handoff}"`);
    }
    if (!found.ada.runs.some((run) => run.status === 'failed')) {
        missing.push(`a failed turn after "${plan.failing}"`);
    }
    const withheld = found.ben.runs.some((run) =>
        run.messages.some(
            (message) =>
                message.role === 'tool' &&
                typeof message.content === 'string' &&
                message.content.includes('"withheld":true'),
        ),
    );
    if (!withheld) {
        missing.push("a result withheld from Ben's copy");
    }
    return missing;
}

/**
 * Waits until a room has `runs` stored runs, none running and nothing of the
 * caller's waiting to be read. Returns its history (the newest page).
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} roomId
 * @param {number} runs
 */
async function roomSettled(call, roomId, runs, timeoutMs = 120_000) {
    const until = Date.now() + timeoutMs;
    const id = encodeURIComponent(roomId);
    for (;;) {
        const steering = await (await call('GET', `/api/conversations/${id}/steering`)).json();
        const history = await (await call('GET', `/api/conversations/${id}/history`)).json();
        const done = history.runs.filter((/** @type {{ status: string }} */ run) => run.status !== 'running');
        if (
            !steering.running &&
            !steering.messages.length &&
            done.length === history.runs.length &&
            done.length >= runs
        ) {
            return history;
        }
        if (Date.now() > until) {
            throw new Error(`Room ${roomId} still busy after ${timeoutMs / 1000} s (${done.length} of ${runs} runs).`);
        }
        await sleep(500);
    }
}

/**
 * The shared room on one server (`a2Seeds`), through the API: Ada makes Manny and the
 * room, lets Manny in, and Ben accepts; then the three messages, each sent only
 * when the history lacks it, so a second run over the same server adds nothing.
 * Checks every seed is there. Returns the room's id and its socios' and
 * people's ids, for the credentials file.
 * @param {{ letter: string } & ReturnType<typeof a2Seeds>} server
 * @param {Awaited<ReturnType<typeof signedIn>>} ada
 * @param {Awaited<ReturnType<typeof signedIn>>} ben
 */
export async function seedRoom(server, ada, ben) {
    const plan = server.room;
    const workspace = await (await ada('GET', '/api/workspace')).json();
    const lead = workspace.dots.find((/** @type {{ name: string }} */ dot) => dot.name === plan.lead);
    if (!lead) {
        throw new Error(`${server.letter} has no socio named ${plan.lead}.`);
    }
    let second = workspace.dots.find(
        (/** @type {{ name: string, ownerId?: string | null }} */ dot) => dot.name === plan.second.name && !dot.ownerId,
    );
    if (!second) {
        second = await (
            await ada('POST', '/api/dots', {
                name: plan.second.name,
                instructions: 'Be warm and brief. Pick up where the other socios left off.',
                researchAllowed: false,
                memoryAllowed: false,
                spaceId: lead.spaceIds?.[0] ?? lead.spaceId,
                character: plan.second.character,
                personal: false,
            })
        ).json();
    }
    let roomId = workspace.conversations.find(
        (/** @type {{ title: string, kind?: string }} */ chat) => chat.kind === 'room' && chat.title === plan.title,
    )?.id;
    if (!roomId) {
        // A person joins the workspace's people with their first request after signing in.
        await ben('GET', '/api/workspace');
        const people = await (await ada('GET', '/api/rooms/people')).json();
        const benId = (Array.isArray(people) ? people : (people.people ?? [])).find(
            (/** @type {{ name: string }} */ person) => person.name === 'Ben',
        )?.userId;
        if (!benId) {
            throw new Error(`${server.letter}: Ben isn't among the people a room may invite.`);
        }
        const created = await (
            await ada('POST', '/api/rooms', {
                dotId: lead.id,
                title: plan.title,
                description: plan.description,
                dotIds: [second.id],
                userIds: [benId],
            })
        ).json();
        roomId = created.id ?? created.room?.id;
    }
    const id = encodeURIComponent(roomId);
    let room = await (await ada('GET', `/api/rooms/${id}`)).json();
    if (
        room.socios.find((/** @type {{ dotId: string }} */ socio) => socio.dotId === second.id)?.status === 'requested'
    ) {
        await ada('POST', `/api/rooms/${id}/socios/${encodeURIComponent(second.id)}/authorize`, {});
    }
    const invite = (await (await ben('GET', '/api/rooms/invites')).json()).find(
        (/** @type {{ roomId: string }} */ entry) => entry.roomId === roomId,
    );
    if (invite) {
        await ben('POST', `/api/rooms/${id}/accept`, { disclosureVersion: invite.disclosure.version });
    }

    const sent = (/** @type {{ runs: any[] }} */ history, /** @type {string} */ text) =>
        history.runs.some((run) =>
            run.messages.some((/** @type {any} */ message) => message.role === 'user' && message.content === text),
        );
    let history = await roomSettled(ada, roomId, 0);
    // The opening: the lead's turn calls tools.
    if (!sent(history, plan.opening)) {
        await ada('POST', `/api/conversations/${id}/steering`, { text: plan.opening });
        history = await roomSettled(ada, roomId, history.runs.length + 1);
    }
    // Both socios named: Sebas answers, then a handoff note and Manny's turn.
    if (!sent(history, plan.handoff)) {
        await ada('POST', `/api/conversations/${id}/steering`, { text: plan.handoff });
        history = await roomSettled(ada, roomId, history.runs.length + 2);
    }
    // Ben's, under a one-token limit: its turn fails. The room's own limits go after.
    if (!history.runs.some((/** @type {{ status: string }} */ run) => run.status === 'failed')) {
        await ada('PUT', `/api/rooms/${id}/limits`, { cycleTokens: 1 });
        try {
            await ben('POST', `/api/conversations/${id}/steering`, { text: plan.failing });
            history = await roomSettled(ada, roomId, history.runs.length + 1);
        } finally {
            await ada('PUT', `/api/rooms/${id}/limits`, {});
        }
    }

    room = await (await ada('GET', `/api/rooms/${id}`)).json();
    const missing = missingRoomSeeds(plan, {
        room,
        ada: history,
        ben: await (await ben('GET', `/api/conversations/${id}/history`)).json(),
    });
    if (missing.length) {
        throw new Error(`${server.letter} lacks room seeds after start: ${missing.join('; ')}`);
    }
    say(
        `${server.letter} room "${plan.title}": ${plan.lead} leads, ${plan.second.name} too, Ben joined; ${history.runs.length} runs with a handoff and a failed turn`,
    );
    const person = (/** @type {string} */ name) =>
        room.members.find((/** @type {{ name: string }} */ member) => member.name === name)?.userId;
    return {
        id: roomId,
        title: plan.title,
        socios: { [plan.lead]: lead.id, [plan.second.name]: second.id },
        people: { Ada: person('Ada'), Ben: person('Ben') },
    };
}

/**
 * The seeded room's history page and transcript, as Ada and as Ben (whose copy
 * withholds the results of Ada's turns), as JSON files in `dir`: fixtures for
 * the app's room view models and their parity check.
 * @param {string} dir
 * @param {string} roomId
 * @param {Record<'ada' | 'ben', Awaited<ReturnType<typeof signedIn>>>} callers
 */
async function captureRoom(dir, roomId, callers) {
    mkdirSync(dir, { recursive: true });
    const id = encodeURIComponent(roomId);
    for (const [who, call] of Object.entries(callers)) {
        for (const page of ['history', 'transcript']) {
            const body = await (await call('GET', `/api/conversations/${id}/${page}`)).json();
            writeFileSync(join(dir, `room-${page}-${who}.json`), `${JSON.stringify(body, null, 4)}\n`);
        }
    }
    say(`captured the room's history and transcript, as Ada and as Ben, in ${dir}`);
}

/** The auth CLI's commands for one workspace: create every account, then deactivate. @param {string} passwordFile */
export function accountCommands(passwordFile) {
    return [
        ...ACCOUNTS.map((account) => [
            'create-user',
            '--email',
            account.email,
            '--name',
            account.name,
            '--role',
            account.role,
            '--password-file',
            passwordFile,
        ]),
        ...ACCOUNTS.filter((account) => account.deactivated).map((account) => ['deactivate', '--email', account.email]),
    ];
}

/**
 * A signed-in caller on one server, with Origin set to APP_ORIGIN. Each call
 * throws on an answer that isn't ok.
 * @param {{ port: number, origin: string }} server
 * @param {string} email
 * @param {string} password
 */
export async function signedIn(server, email, password) {
    const base = `http://127.0.0.1:${server.port}`;
    let cookie = '';
    const call = async (
        /** @type {string} */ method,
        /** @type {string} */ path,
        /** @type {unknown} */ body = undefined,
    ) => {
        const response = await fetch(base + path, {
            method,
            redirect: 'manual',
            headers: {
                Origin: server.origin,
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(cookie ? { Cookie: cookie } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            throw new Error(
                `${method} ${path} on ${server.port}: ${response.status} ${(await response.text()).slice(0, 300)}`,
            );
        }
        return response;
    };
    const signIn = await call('POST', '/api/auth/sign-in/email', { email, password });
    cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
    return call;
}

/** What Opal sets: the workspace's name as its branding, the bundled logo kept. @param {string} name */
export const brandingOf = (name) => ({ branding: { name, logo: BRANDING_LOGO } });

/**
 * Polls a repeating task's latest run until it has finished; throws when it
 * hasn't after `tries` reads `delayMs` apart (30 s by default), so "ready"
 * never prints while the seeded run is still going. Returns the run.
 * @param {() => Promise<{ status: string, finishedAt: number | null } | null | undefined>} read
 * @param {string} name
 */
export async function firstRunFinished(read, name, { tries = 60, delayMs = 500 } = {}) {
    let run;
    for (let attempt = 0; attempt < tries; attempt++) {
        run = await read();
        if (run?.finishedAt) {
            return run;
        }
        if (attempt < tries - 1) {
            await sleep(delayMs);
        }
    }
    throw new Error(
        `The first run of ${name} hasn't finished after ${(tries * delayMs) / 1000} s (${run ? run.status : 'not started'}).`,
    );
}

/** A chat's title in /api/workspace, or undefined when it isn't listed. */
async function titleOf(/** @type {Awaited<ReturnType<typeof signedIn>>} */ call, /** @type {string} */ id) {
    const { conversations } = await (await call('GET', '/api/workspace')).json();
    return conversations.find((/** @type {{ id: string }} */ chat) => chat.id === id)?.title;
}

/**
 * The server names a chat once, after its first turn (ThreadTitler): waits
 * for that, then puts the seeded name back. Throws when the server's name
 * hasn't come within 15 s (it would replace the seeded one after "ready"), or
 * the seeded name doesn't read back.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} id
 * @param {string} title
 */
async function restoreTitle(call, id, title) {
    let named = false;
    for (let tries = 0; tries < 30 && !named; tries++) {
        named = (await titleOf(call, id)) !== title;
        if (!named) {
            await sleep(500);
        }
    }
    if (!named) {
        throw new Error(`The server didn't name chat "${title}" (${id}) within 15 s, so its name may still change.`);
    }
    await call('PATCH', `/api/conversations/${id}`, { title });
    const now = await titleOf(call, id);
    if (now !== title) {
        throw new Error(`Chat ${id} reads "${now}" after its name was put back to "${title}".`);
    }
}

/**
 * Seeds one server through its API as Ada: the workspace's name, its Space,
 * the marker chat with Sebas and its one turn (a run read to its end; the
 * name the server gives it after, put back), and a second chat it archives;
 * then, as Opal, the branding's name. Then the shared room (`seedRoom`) and
 * the issue and memory seeds (`a3Seeds`), with Ben signed in for his part, and checks they are all
 * there. Three sign-ins per server, Ada, Opal and Ben, once each (sign-in is
 * limited to 30 a minute per address). Only the first start seeds: a restart
 * through the control port starts the servers on their own databases.
 * Returns the issues' numbers, in plan order, the room's ids, and both callers.
 * @param {ReturnType<typeof seedPlan>[number]} server
 * @param {string} password
 */
async function seed(server, password) {
    const call = await signedIn(server, ACCOUNTS[0].email, password);
    const workspace = await (await call('GET', '/api/workspace')).json();
    const sebas =
        workspace.dots.find((/** @type {{ name: string }} */ dot) => dot.name === 'Sebas') ?? workspace.dots[0];
    await call('PATCH', '/api/settings', { name: server.workspaceName });
    const marker = await (await call('POST', '/api/conversations', { dotId: sebas.id, title: server.chat })).json();
    const run = await call('POST', `/api/copilotkit/agent/${encodeURIComponent(sebas.id)}/run`, {
        threadId: marker.id,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', content: server.message }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
    });
    const events = await run.text();
    if (!events.includes('RUN_FINISHED')) {
        throw new Error(`The marker chat's turn on ${server.port} didn't finish: ${events.slice(-300)}`);
    }
    await restoreTitle(call, marker.id, server.chat);
    const space = await (await call('POST', '/api/spaces', { name: server.space })).json();
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const handbook = await (
        await call('POST', pages, { title: server.page, content: `# ${server.page}\n\nHow we work here.` })
    ).json();
    await call('POST', pages, {
        title: server.subpage,
        content: `# ${server.subpage}\n\nWhat to read first.`,
        parentId: handbook.id,
    });
    const archived = await (
        await call('POST', '/api/conversations', { dotId: sebas.id, title: server.archivedChat })
    ).json();
    await call('PATCH', `/api/conversations/${archived.id}`, { archived: true });
    const opal = await signedIn(server, OPAL, password);
    await opal('PATCH', '/api/settings', brandingOf(server.workspaceName));
    say(
        `${server.letter} seeded at ${server.origin}: "${server.workspaceName}", Space "${server.space}", chat "${server.chat}", archived "${server.archivedChat}"`,
    );
    const ben = await signedIn(server, ACCOUNTS[1].email, password);
    const room = server.room ? await seedRoom(server, call, ben) : null;
    return { numbers: await seedA3(server, call, ben, sebas.id), room, ada: call, ben };
}

/**
 * The issue and memory seeds on one server, in plan order (so issue numbers follow it), then
 * the check that each is there. Returns the issues' numbers, in plan order.
 * @param {ReturnType<typeof seedPlan>[number]} server
 * @param {Awaited<ReturnType<typeof signedIn>>} ada
 * @param {Awaited<ReturnType<typeof signedIn>>} ben
 * @param {string} dotId
 */
async function seedA3(server, ada, ben, dotId) {
    const picture = seedPicture().toString('base64');
    /** @type {number[]} */
    const numbers = [];
    for (const issue of server.issues) {
        const { status, by, title, kind, priority, resolution } = issue;
        const fields =
            by === 'ben'
                ? { title, body: `Filed by Ben in ${server.workspaceName}.`, kind, priority }
                : { title, body: `Seeded in ${server.workspaceName}.`, status, kind, priority, resolution };
        const { issue: created } = await (await (by === 'ben' ? ben : ada)('POST', '/api/issues', fields)).json();
        numbers.push(created.number);
        if (issue.vote) {
            await ben('POST', `/api/issues/${created.number}/vote`, {});
        }
        if (issue.comment) {
            await ben('POST', `/api/issues/${created.number}/comments`, { body: issue.comment });
        }
        if (issue.picture) {
            await ada('POST', `/api/issues/${created.number}/attachments`, {
                name: issue.picture,
                mediaType: 'image/png',
                data: picture,
            });
        }
    }
    for (const text of server.memories) {
        await ada('POST', '/api/memories', { text });
    }
    await ada('PUT', '/api/memories/profile', { fields: server.profile, shareable: false });
    const chat = await (await ada('POST', '/api/conversations', { dotId, title: server.task.chat })).json();
    const task = await (
        await ada('POST', '/api/tasks', {
            prompt: server.task.prompt,
            intervalSeconds: server.task.intervalSeconds,
            threadId: chat.id,
        })
    ).json();
    // A new task runs at once: wait for that run, then put its chat's name back.
    await firstRunFinished(
        async () =>
            (await (await ada('GET', '/api/schedules')).json()).schedules.find(
                (/** @type {{ id: string }} */ entry) => entry.id === task.id,
            )?.lastRun,
        `${server.letter}: "${server.task.prompt}"`,
    );
    await restoreTitle(ada, chat.id, server.task.chat);
    proposeMemory(server.env.DATABASE_PATH, {
        text: server.proposal,
        like: server.memories[0],
        dotId,
        threadId: chat.id,
        now: Date.now(),
    });

    const issues = await (await ada('GET', '/api/issues')).json();
    /** @type {Record<string, any>} */
    const details = {};
    for (const issue of server.issues.filter((entry) => entry.comment || entry.picture)) {
        const listed = issues.issues.find((/** @type {{ title: string }} */ row) => row.title === issue.title);
        if (listed) {
            details[issue.title] = await (await ada('GET', `/api/issues/${listed.number}`)).json();
        }
    }
    const missing = missingSeeds(server, {
        issues,
        details,
        memories: await (await ada('GET', '/api/memories')).json(),
        schedules: await (await ada('GET', '/api/schedules')).json(),
        conversations: (await (await ada('GET', '/api/workspace')).json()).conversations,
    });
    if (missing.length) {
        throw new Error(`${server.letter} lacks seeds after start: ${missing.join('; ')}`);
    }
    say(
        `${server.letter} board seeds: ${server.issues.length} issues (one per status), ${server.memories.length} memories, a proposal and a profile, repeating task "${server.task.prompt}"`,
    );
    return numbers;
}

/**
 * A socio's memory proposal for Ada, written straight into the server's
 * database: only a socio's tool call in a turn makes one, and the fake model
 * makes none. Ada's id is read from her memory `like`, seeded first through
 * the API. Once only: a proposal with that text is left as it is.
 * @param {string} database the server's DATABASE_PATH
 * @param {{ text: string, like: string, dotId: string, threadId: string, now: number }} proposal
 */
export function proposeMemory(database, { text, like, dotId, threadId, now }) {
    const db = new DatabaseSync(database);
    try {
        db.exec('PRAGMA busy_timeout = 10000');
        const owner = /** @type {{ userId: string } | undefined} */ (
            db.prepare('SELECT userId FROM memories WHERE text = ? AND deletedAt IS NULL').get(like)
        );
        if (!owner?.userId) {
            throw new Error(`No memory "${like}" to take Ada's id from.`);
        }
        if (db.prepare('SELECT 1 FROM memories WHERE text = ? AND userId = ?').get(text, owner.userId)) {
            return;
        }
        db.prepare(
            `INSERT INTO memories (id, text, createdAt, userId, status, source, shareable, dotId, threadId, updatedAt)
             VALUES (?, ?, ?, ?, 'proposed', 'socio', 0, ?, ?, ?)`,
        ).run(randomUUID(), text, now, owner.userId, dotId, threadId, now);
    } finally {
        db.close();
    }
}

// ── Running ──

const say = (/** @type {string} */ line) => console.log(`[servers] ${line}`);
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/** @type {{ children: import('node:child_process').ChildProcess[], logs: string[], reversed: number[], dir?: string, done: boolean, restarting: Set<import('node:child_process').ChildProcess>, cloud?: { close: () => Promise<unknown> } }} */
const state = { children: [], logs: [], reversed: [], done: false, restarting: new Set() };
let adb = (/** @type {string[]} */ _args) => spawnSync('true');

/** A long-running child in its own process group, writing to `log`. */
function start(
    /** @type {string[]} */ args,
    /** @type {Record<string, string>} */ env,
    /** @type {string} */ log,
    { append = false } = {},
) {
    if (!append) {
        writeFileSync(log, '');
    }
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
    child.stderr.on('data', (chunk) => writeFileSync(log, chunk, { flag: 'a' }));
    child.once('exit', (code, signal) => {
        if (state.restarting.delete(child)) {
            state.children = state.children.filter((other) => other !== child);
            return;
        }
        if (!state.done) {
            console.error(`[servers] ${args.at(-1)} stopped (${signal ?? code}); log ${log}`);
            void teardown(1);
        }
    });
    state.children.push(child);
    if (!state.logs.includes(log)) {
        state.logs.push(log);
    }
    return child;
}

/**
 * The days a restart's `ahead` asks for: 0 to 400, else null.
 * @param {string | null} value
 */
export function aheadDays(value) {
    if (value === null || value === '') {
        return 0;
    }
    const days = Number(value);
    return /^\d+(\.\d+)?$/.test(value) && days <= 400 ? days : null;
}

const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
const SERVER_VERSION_VALUE = /^\d+\.\d+\.\d+$/;

/**
 * Per workspace letter, or `*` for every workspace.
 * @typedef {{ days: number, minimum: Record<string, string>, recommended: Record<string, string>, versions: Record<string, string> }} RestartOptions
 */

/**
 * `<value>` (every workspace, `*`) or `<letter>:<value>` into `into`; false when it doesn't read.
 * @param {string} value @param {RegExp} pattern @param {Record<string, string>} into @param {boolean} scoped
 */
function scopedValue(value, pattern, into, scoped) {
    const parts = value.split(':');
    const [letter, version] = parts.length === 2 ? parts : ['*', parts[0]];
    if (parts.length > 2 || (letter === '*' && scoped) || (letter !== '*' && !LETTERS.includes(letter ?? ''))) {
        return false;
    }
    if (!pattern.test(version ?? '')) {
        return false;
    }
    into[/** @type {string} */ (letter)] = /** @type {string} */ (version);
    return true;
}

/**
 * A restart's options from its query: `ahead` (aheadDays), the `minimum` and `recommended` app versions
 * (`0.2.8` for every workspace, `B:0.2.8` for one), and each `version=<letter>:<x.y.z>`, a workspace's
 * server version. Null for anything else.
 * @param {URLSearchParams} query
 * @returns {RestartOptions | null}
 */
export function restartOptions(query) {
    const days = aheadDays(query.get('ahead'));
    if (days === null) {
        return null;
    }
    /** @type {RestartOptions} */
    const options = { days, minimum: {}, recommended: {}, versions: {} };
    for (const name of /** @type {const} */ (['minimum', 'recommended'])) {
        for (const value of query.getAll(name)) {
            if (!scopedValue(value, VERSION, options[name], false)) {
                return null;
            }
        }
    }
    for (const value of query.getAll('version')) {
        if (!scopedValue(value, SERVER_VERSION_VALUE, options.versions, true)) {
            return null;
        }
    }
    return options;
}

/**
 * What a restart gives workspace `letter`: its app minimum and recommendation, its server version.
 * @param {RestartOptions} options @param {string} letter
 */
export function restartFor({ minimum, recommended, versions }, letter) {
    return {
        minimum: minimum[letter] ?? minimum['*'],
        recommended: recommended[letter] ?? recommended['*'],
        version: versions[letter],
    };
}

/**
 * A workspace server's command and environment: its clock `days` ahead when not 0, the app versions
 * it serves, and the server version it reports (`version`) when given.
 * @param {Record<string, string>} env
 * @param {number} days
 * @param {{ minimum?: string, recommended?: string, version?: string }} [more]
 */
export function serverStart(env, days, more = {}) {
    const args = ['--import', EGRESS_LOG];
    /** @type {Record<string, string>} */
    const extra = {};
    if (days !== 0) {
        args.push('--import', CLOCK_AHEAD);
        extra.SOCIO_E2E_CLOCK_AHEAD_MS = String(Math.round(days * DAY_MS));
    }
    if (more.version !== undefined) {
        args.push('--import', SERVER_VERSION);
        extra.SOCIO_E2E_SERVER_VERSION = more.version;
    }
    if (more.minimum !== undefined) {
        extra.APP_MINIMUM_VERSION = more.minimum;
    }
    if (more.recommended !== undefined) {
        extra.APP_RECOMMENDED_VERSION = more.recommended;
    }
    args.push(SERVER_ENTRY);
    return { args, env: Object.keys(extra).length === 0 ? env : { ...env, ...extra } };
}

/** @param {RestartOptions} options */
function restartLine({ days, minimum, recommended, versions }) {
    const where = (/** @type {string} */ letter) => (letter === '*' ? '' : ` on ${letter}`);
    return [
        days ? `, the clock ${days} days ahead` : '',
        ...Object.entries(minimum).map(([letter, version]) => `, app minimum ${version}${where(letter)}`),
        ...Object.entries(recommended).map(([letter, version]) => `, app recommended ${version}${where(letter)}`),
        ...Object.entries(versions).map(([letter, version]) => `, ${letter} at ${version}`),
    ].join('');
}

/**
 * Stops each workspace server and starts it again on its own database (a new process, as after a
 * deploy), with `options`: its clock ahead, the app versions, a workspace's server version.
 * @param {{ server: ReturnType<typeof seedPlan>[number], child: import('node:child_process').ChildProcess }[]} running
 * @param {RestartOptions} options
 */
async function restart(running, options) {
    for (const entry of running) {
        const { child } = entry;
        state.restarting.add(child);
        const exited = new Promise((done) => child.once('exit', done));
        try {
            process.kill(-(child.pid ?? 0), 'SIGTERM');
        } catch {
            // Gone already.
        }
        await exited;
        const { args, env } = serverStart(entry.server.env, options.days, restartFor(options, entry.server.letter));
        entry.child = start(args, env, entry.server.log, { append: true });
    }
    for (const entry of running) {
        await listening(entry.server.port);
    }
    say(`restarted ${running.map(({ server }) => server.port).join(', ')}${restartLine(options)}`);
}

/** Waits until something accepts connections on the port. */
async function listening(/** @type {number} */ number, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const up = await new Promise((done) => {
            const socket = connect(number, '127.0.0.1');
            socket.once('connect', () => {
                socket.end();
                done(true);
            });
            socket.once('error', () => done(false));
        });
        if (up) {
            return;
        }
        await sleep(250);
    }
    throw new Error(`Nothing listens on ${number} after ${timeoutMs / 1000} s.`);
}

/** @param {number} code */
async function teardown(code) {
    if (state.done) {
        return;
    }
    state.done = true;
    for (const number of state.reversed) {
        adb(['reverse', '--remove', `tcp:${number}`]);
    }
    await state.cloud?.close().catch(() => undefined);
    for (const child of state.children) {
        try {
            process.kill(-(child.pid ?? 0), 'SIGTERM');
        } catch {
            // Gone already.
        }
    }
    await sleep(1_000);
    const outside = state.logs.flatMap((log) =>
        [...(existsSync(log) ? readFileSync(log, 'utf8') : '').matchAll(/^\[egress\] (\S+)$/gm)]
            .map(([, target]) => target)
            .filter((target) => !/^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?):\d+$/.test(target)),
    );
    if (outside.length) {
        console.error(
            `[servers] the egress log shows connections off the machine: ${[...new Set(outside)].join(', ')}`,
        );
    }
    if (state.dir && code === 0) {
        rmSync(state.dir, { recursive: true, force: true });
    } else if (state.dir) {
        say(`kept ${state.dir} for its logs`);
    }
    process.exit(outside.length ? 3 : code);
}

async function main() {
    const options = parseServerArgs(process.argv.slice(2), process.env);
    if ('help' in options) {
        console.log(options.help);
        return;
    }
    for (const entry of [SERVER_ENTRY, AUTH_CLI_ENTRY]) {
        if (!existsSync(join(ROOT, entry))) {
            throw new Error(`${entry} is missing: run \`pnpm run build\` in ${ROOT} first.`);
        }
    }
    for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM'])) {
        process.on(signal, () => void teardown(0));
    }
    const dir = mkdtempSync(join(tmpdir(), 'socio-e2e-'));
    state.dir = dir;
    if (options.adb) {
        const sdk = process.env.ANDROID_HOME ?? join(process.env.HOME ?? '', 'Android/Sdk');
        const path = existsSync(join(sdk, 'platform-tools/adb')) ? join(sdk, 'platform-tools/adb') : 'adb';
        const device = options.device ? ['-s', options.device] : [];
        adb = (args) => spawnSync(path, [...device, ...args], { encoding: 'utf8' });
    }
    const password = randomBytes(18).toString('base64url');
    const passwordFile = join(dir, 'password');
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    const path = process.env.PATH ?? '';

    start(
        ['--import', EGRESS_LOG, '--import', 'tsx', 'tests/fixtures/serve-fake-model.ts', String(options.modelPort)],
        { PATH: path, HOME: dir },
        join(dir, 'fake-model.log'),
    );
    await listening(options.modelPort);
    say(`fake model on http://127.0.0.1:${options.modelPort}/v1`);

    // --codes: each workspace's own SMTP sink and fake Telegram, in this process.
    /** @type {Array<{ sink: Awaited<ReturnType<typeof smtpSink>>, telegram: Awaited<ReturnType<typeof fakeTelegramAt>> }>} */
    const channelSet = [];
    if (options.codes) {
        for (const _ of options.ports) {
            channelSet.push({ sink: await smtpSink(), telegram: await fakeTelegramAt(ROOT) });
        }
        say(
            `SMTP sinks and fake Telegrams on ${channelSet.map(({ sink, telegram }) => `${sink.port} ${telegram.apiRoot}`).join(', ')}`,
        );
    }
    // --social: the fake cloud services, and one enrollment token per workspace.
    const cloud = options.social ? await fakeCloud(options.social.cloudPort) : null;
    if (cloud) {
        state.cloud = cloud;
        say(`fake cloud services on ${cloud.origin} (Google and Apple test accounts)`);
    }
    const servers = seedPlan({
        clouds: cloud ? options.ports.map(() => ({ issuer: cloud.origin, token: cloud.provision() })) : undefined,
        ports: options.ports,
        modelPort: options.modelPort,
        dir,
        path,
        rooms: options.rooms,
        devLinks: options.devLinks,
        featureFlags: options.featureFlags,
        channels: options.codes
            ? channelSet.map(({ sink, telegram }) => ({ smtpPort: sink.port, telegramRoot: telegram.apiRoot }))
            : undefined,
    });
    /** @type {Map<string, number[]>} */
    const issueNumbers = new Map();
    /** @type {Map<string, Awaited<ReturnType<typeof seedRoom>> | null>} */
    const rooms = new Map();
    const running = servers.map((server) => {
        mkdirSync(server.home, { recursive: true });
        const { args, env } = serverStart(server.env, 0);
        return { server, child: start(args, env, server.log) };
    });
    for (const server of servers) {
        await listening(server.port);
        for (const args of accountCommands(passwordFile)) {
            const result = spawnSync(process.execPath, ['--import', EGRESS_LOG, AUTH_CLI_ENTRY, ...args], {
                cwd: ROOT,
                env: server.env,
                encoding: 'utf8',
            });
            writeFileSync(server.log, result.stdout + result.stderr, { flag: 'a' });
            if (result.status !== 0) {
                throw new Error(`auth ${args.slice(0, 3).join(' ')} on ${server.port} failed; log ${server.log}`);
            }
        }
        const seeded = await seed(server, password);
        if (options.codes) {
            const index = servers.indexOf(server);
            await seedChannels(
                server,
                {
                    ada: ACCOUNTS[0].email,
                    opal: OPAL,
                    password,
                    emailLinks: index === 0,
                },
                channelSet[index].telegram,
            );
            say(`${server.letter}: sign-in codes by ${index === 0 ? 'email' : 'Telegram'}`);
        }
        if (cloud) {
            linkSocial(server.env.DATABASE_PATH, ACCOUNTS[2].email, CY_SOCIAL_ACCOUNT);
            await socialOffered(server);
            say(`${server.letter}: Google and Apple offered; Cy linked as ${CY_SOCIAL_ACCOUNT}`);
        }
        issueNumbers.set(server.letter, seeded.numbers);
        rooms.set(server.letter, seeded.room);
        if (options.capture && seeded.room && server === servers[0]) {
            await captureRoom(options.capture, seeded.room.id, { ada: seeded.ada, ben: seeded.ben });
        }
        if (options.adb) {
            const result = adb(['reverse', `tcp:${server.port}`, `tcp:${server.port}`]);
            if (result.status === 0) {
                state.reversed.push(server.port);
            } else {
                say(`adb reverse ${server.port} failed: ${String(result.stderr).trim()}`);
            }
        }
    }

    const credentials = join(dir, 'credentials.json');
    const body = {
        password,
        accounts: ACCOUNTS,
        rooms: options.rooms,
        ...(cloud
            ? {
                  social: {
                      cy: CY_SOCIAL_ACCOUNT,
                      refusals: ['refuse-invalid', 'refuse-nonce', 'refuse-many', 'refuse-unavailable'],
                  },
              }
            : {}),
        ...(options.codes
            ? {
                  codes: Object.fromEntries(
                      servers.map((server, index) => [server.letter, index === 0 ? 'email' : 'telegram']),
                  ),
              }
            : {}),
        servers: servers.map(
            ({
                letter,
                origin,
                workspaceName,
                chat,
                space,
                page,
                subpage,
                archivedChat,
                issues,
                memories,
                profile,
                task,
            }) => ({
                letter,
                origin,
                workspaceName,
                chat,
                space,
                page,
                subpage,
                archivedChat,
                room: rooms.get(letter),
                issues: issues.map((issue, index) => ({
                    number: issueNumbers.get(letter)?.[index],
                    title: issue.title,
                    status: issue.status,
                })),
                memories,
                profile,
                task,
            }),
        ),
    };
    writeFileSync(credentials, `${JSON.stringify(body, null, 4)}\n`, { mode: 0o600 });
    say(`credentials in ${credentials} (mode 600)`);
    if (options.once) {
        await teardown(0);
        return;
    }
    let restarting = Promise.resolve();
    const web = webControl(servers, channelSet, password);
    const control = createHttpServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname.startsWith('/web/')) {
            web(request.method ?? 'GET', url).then(
                (answer) =>
                    response.writeHead(200, { 'Content-Type': 'application/json' }).end(`${JSON.stringify(answer)}\n`),
                (error) => response.writeHead(400).end(`${error instanceof Error ? error.message : String(error)}\n`),
            );
            return;
        }
        const options = restartOptions(url.searchParams);
        if (request.method !== 'POST' || url.pathname !== '/restart' || options === null) {
            response
                .writeHead(404)
                .end('POST /restart[?ahead=<days>&minimum=<v>&recommended=<v>&version=<letter>:<x.y.z>]\n');
            return;
        }
        restarting = restarting
            .then(() => restart(running, options))
            .then(
                () => response.writeHead(200).end('restarted\n'),
                (error) => response.writeHead(500).end(`${error instanceof Error ? error.message : String(error)}\n`),
            );
    });
    control.unref();
    control.listen(options.control, '127.0.0.1');
    say(
        `ready; control on 127.0.0.1:${options.control} (POST /restart[?ahead=…&minimum=…&recommended=…&version=…]); Ctrl-C stops everything`,
    );
}

/**
 * Links `email`'s account to Google and Apple as the test account `sub` (CB-570), straight into the
 * server's auth tables as a link made in the app would be. For Cy, who is deactivated and can't
 * sign in to link.
 * @param {string} database @param {string} email @param {string} sub
 */
export function linkSocial(database, email, sub) {
    const db = new DatabaseSync(database);
    try {
        const user = /** @type {{ id: string } | undefined} */ (
            db.prepare('SELECT id FROM auth_user WHERE email = ?').get(email)
        );
        if (!user) {
            throw new Error(`No account ${email} to link.`);
        }
        const now = new Date().toISOString();
        for (const providerId of ['google-native', 'apple-native']) {
            db.prepare(
                'INSERT OR IGNORE INTO auth_account(id, accountId, providerId, userId, linkEmail, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(randomUUID(), sub, providerId, user.id, `${sub}@example.test`, now, now);
        }
    } finally {
        db.close();
    }
}

/** Waits until the workspace's manifest offers Google and Apple (it enrolled with the fake cloud). */
async function socialOffered(/** @type {{ port: number, letter: string }} */ server, timeoutMs = 60_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const answer = await fetch(`http://127.0.0.1:${server.port}/.well-known/socio/workspace`);
            const social = answer.ok ? (await answer.json())?.methods?.social : null;
            if (Array.isArray(social) && social.includes('google') && social.includes('apple')) {
                return;
            }
        } catch {
            // Not yet.
        }
        await sleep(500);
    }
    throw new Error(`${server.letter} never offered Google and Apple: did it enroll with the fake cloud?`);
}

/**
 * The control port's `/web/` routes, Ada on the web of workspace
 * `?letter=` (A by default), each answering JSON:
 * `GET /web/outbox` the codes sent by email and Telegram (--codes);
 * `POST /web/pair` a new Add a device QR code (`{ link }`), polled every 2 s as the page does;
 * `POST /web/confirm?digits=` the 6 digits typed on the page;
 * `POST /web/other` another device claims that QR code first (its digits and redeem's answer);
 * `GET /web/pair?digits=` the states the page saw, and whether any poll held those digits;
 * `POST /web/erase` Sign out and erase for every device of Ada's;
 * `POST /web/social?google=off&apple=on` Opal's access policy for the app's Google and Apple (--social).
 * @param {ReturnType<typeof seedPlan>} servers
 * @param {Array<{ sink: { mail: any[] }, telegram: { calls: any[] } }>} channelSet
 * @param {string} password
 */
function webControl(servers, channelSet, password) {
    /** @type {Map<string, { call: Awaited<ReturnType<typeof webSession>>, pairing: ReturnType<typeof webPairing> }>} */
    const sessions = new Map();
    const of = async (/** @type {string} */ letter) => {
        const server = servers.find((entry) => entry.letter === letter);
        if (!server) {
            throw new Error(`No workspace ${letter}.`);
        }
        let held = sessions.get(letter);
        if (!held) {
            const call = await webSession(server, ACCOUNTS[0].email, password);
            held = { call, pairing: webPairing(call, server) };
            sessions.set(letter, held);
        }
        return { server, ...held };
    };
    return async (/** @type {string} */ method, /** @type {URL} */ url) => {
        const letter = url.searchParams.get('letter') ?? 'A';
        const route = `${method} ${url.pathname}`;
        if (route === 'GET /web/outbox') {
            const index = servers.findIndex((entry) => entry.letter === letter);
            if (!channelSet[index]) {
                throw new Error('No sign-in code channels: start servers.mjs with --codes.');
            }
            return outbox(channelSet[index].sink, channelSet[index].telegram);
        }
        const { call, pairing } = await of(letter);
        switch (route) {
            case 'POST /web/pair':
                return pairing.start();
            case 'POST /web/confirm':
                return pairing.confirm(url.searchParams.get('digits') ?? '');
            case 'POST /web/other':
                return pairing.other();
            case 'GET /web/pair':
                return pairing.status(url.searchParams.get('digits') ?? undefined);
            case 'POST /web/erase':
                return eraseDevices(call);
            case 'POST /web/social': {
                const server = servers.find((entry) => entry.letter === letter);
                /** @param {string | null} value */
                const flag = (value) => (value === null ? undefined : value === 'on');
                return setSocialPolicy(server ?? servers[0], OPAL, password, {
                    google: flag(url.searchParams.get('google')),
                    apple: flag(url.searchParams.get('apple')),
                });
            }
            default:
                throw new Error(`No route ${route}.`);
        }
    };
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`[servers] ${error instanceof Error ? error.message : String(error)}`);
        void teardown(1);
    });
}
