#!/usr/bin/env node
// Hands an encrypted push to a debug build's Android messaging service through adb, with no FCM
// and no relay (modules/socio-push/android/README.md, Debug hook):
//
//   node apps/mobile/e2e/debug-push.mjs [--serial emulator-5554] [--package <id>]
//       [--workspace <id>] [--registration <id>] [--name <workspace name>]
//       [--title <text>] [--body <text>] [--link <path>] [--tag <tag>] [--count <n>] [--generic]
//       [--credentials <file> [--letter A]]
//
// It seeds the workspace's keys and registration on the phone first (the debug receiver's SEED,
// which makes new keys each time, as push registration will), encrypts the server's payload to
// them with web-push's aes128gcm (the server's library), and sends the relay's FCM data `{s, p}`
// (PUSH). `--generic` sends the relay's generic `{s, g}` instead. Made-up ids and text only: nothing leaves the machine.
//
// `--credentials` (servers.mjs's file) aims it at a workspace the app signed in to: Ada's copy
// of workspace `--letter`'s seeded room, so tapping it opens the room. The workspace id is the app's
// directory id (src/data/layout.ts: the SHA-256 of the origin, a newline and Ada's app user id).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import webpush from 'web-push';

const ADB = process.env.ADB ?? `${process.env.HOME}/Android/Sdk/platform-tools/adb`;
const ACTION = 'expo.modules.sociopush.debug';
const RECEIVER = 'expo.modules.sociopush.DebugPushReceiver';

/**
 * Reads the command line. Throws with a message for anything it can't use.
 * @param {string[]} argv
 */
export function parseDebugPushArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            serial: { type: 'string', default: process.env.ANDROID_SERIAL ?? 'emulator-5554' },
            package: { type: 'string', default: 'com.ingenioventures.socio.dev' },
            workspace: { type: 'string', default: 'debug-workspace' },
            registration: { type: 'string', default: 'debug-registration' },
            name: { type: 'string', default: 'Workspace A' },
            title: { type: 'string', default: 'Ben in A: launch room' },
            body: { type: 'string', default: '@Ada can you check the launch notes?' },
            link: { type: 'string', default: '/chats/debug-room' },
            tag: { type: 'string', default: 'debug-room' },
            count: { type: 'string', default: '1' },
            generic: { type: 'boolean', default: false },
            credentials: { type: 'string' },
            letter: { type: 'string', default: 'A' },
        },
    });
    if (values.credentials !== undefined) {
        Object.assign(values, roomTarget(JSON.parse(readFileSync(values.credentials, 'utf8')), values.letter));
    }
    const id = /^[A-Za-z0-9_-]{1,128}$/;
    for (const key of ['workspace', 'registration']) {
        if (!id.test(values[key])) {
            throw new Error(`--${key} is 1 to 128 letters, digits, "-" or "_".`);
        }
    }
    if (!values.link.startsWith('/')) {
        throw new Error('--link is a web path, starting with "/".');
    }
    const count = Number(values.count);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error('--count is 1 to 20.');
    }
    return { ...values, count };
}

/** The app's directory id for a workspace and person (src/data/layout.ts' `workspaceId`). */
export const directoryId = (origin, appUserId) => createHash('sha256').update(`${origin}\n${appUserId}`).digest('hex');

/**
 * Ada's copy of workspace `letter`'s seeded room in servers.mjs's credentials: the workspace id, its
 * name, and a mention in the room linking to it, as the server sends one (rooms/notices.ts).
 */
export function roomTarget(credentials, letter) {
    const server = credentials.servers?.find((entry) => entry.letter === letter);
    const room = server?.room;
    if (!server || !room?.id || !room.people?.Ada) {
        throw new Error(
            `The credentials have no room with Ada for workspace ${letter} (servers.mjs without --no-rooms).`,
        );
    }
    return {
        workspace: directoryId(server.origin, room.people.Ada),
        name: server.workspaceName,
        title: `Ben in ${room.title}`,
        link: `/chats/${encodeURIComponent(room.id)}`,
        tag: room.id,
    };
}

/** The server's payload (src/server/notifications/push.ts), as JSON. */
export function payloadOf({ title, body, link, tag }, index = 0, count = 1) {
    const numbered = count > 1 ? `${body} (${index + 1})` : body;
    return JSON.stringify({ kind: 'message', title, body: numbered, link, ...(tag ? { tag } : {}) });
}

/** The aes128gcm body for these keys, base64url, as the relay forwards it in `p`. */
export function encryptFor(keys, payload) {
    return Buffer.from(webpush.encrypt(keys.p256dh, keys.auth, payload, 'aes128gcm').cipherText).toString('base64url');
}

/** `adb shell am broadcast` arguments for the debug receiver. Values are base64url or plain ids. */
export function broadcastArgs(pkg, action, extras) {
    const args = ['shell', 'am', 'broadcast', '-a', `${ACTION}.${action}`, '-n', `${pkg}/${RECEIVER}`];
    for (const [key, value] of Object.entries(extras)) {
        args.push('--es', key, `'${String(value).replaceAll("'", "'\\''")}'`);
    }
    return args;
}

/** The receiver's result data from `am broadcast`'s output, or throws when it didn't answer. */
export function resultOf(output) {
    const match = /result=1, data="(.*)"\s*$/m.exec(output);
    if (!match) {
        throw new Error(`The debug receiver didn't answer (a debug build of the app?): ${output.trim()}`);
    }
    return match[1];
}

function broadcast(options, action, extras) {
    const output = execFileSync(ADB, ['-s', options.serial, ...broadcastArgs(options.package, action, extras)], {
        encoding: 'utf8',
    });
    return resultOf(output);
}

function main() {
    const options = parseDebugPushArgs(process.argv.slice(2));
    const keys = JSON.parse(
        broadcast(options, 'SEED', {
            workspace: options.workspace,
            registration: options.registration,
            name: options.name,
        }),
    );
    for (let index = 0; index < options.count; index += 1) {
        const extras = options.generic
            ? { s: options.registration, g: '1' }
            : { s: options.registration, p: encryptFor(keys, payloadOf(options, index, options.count)) };
        broadcast(options, 'PUSH', extras);
    }
    console.log(JSON.stringify({ sent: options.count, generic: options.generic, workspace: options.workspace }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
