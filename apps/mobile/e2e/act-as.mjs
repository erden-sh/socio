#!/usr/bin/env node
// Acts as Ben, servers.mjs's second account, through a local server's API, so a
// flow or a push test has someone else in the room:
//
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] message [--text <text>] [--no-wait]
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] invite
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] cancel
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] read [--text <text>]
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] issues --text <title>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] comments --issue <title> --text <comment>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-file --text <title> [--count <n>]
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-retitle --text <title> --to <title>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-delete --text <title>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-sign-out
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-invite [--link-host <host>]
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-page --page <title> [--expect <text>]
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-page-write --page <title> --text <markdown>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-page-delete --page <title>
//   node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A] web-page-move --page <title> --to <Space>
//
// message: Ben sends a message to the seeded room that mentions Ada (by id, as
//   the web's people picker does, so the server records a mention notice),
//   then waits for the socio's turn to end, since a mention is pushed only
//   once a turn stores the message.
// invite: Ben makes his own room with the lead socio (once) and invites Ada.
// cancel: Ben takes that invite back.
// read: Ben reads the seeded room's transcript for Ada's newest message (with
//   that text, when given) and the mentions the server checked on it; it fails
//   unless the message mentions Ben (room-send.yaml).
// issues: Ben counts the board's issues with exactly that title and lists
//   their attachments (name, type and size); it fails unless there is exactly
//   one (file-issue-offline.yaml: filing offline makes exactly one
//   issue; its HEIC check on iOS: a JPEG under 5 MiB named .jpg).
// comments: Ben counts the comments saying exactly --text on the one issue
//   titled --issue; it fails unless there is exactly one (the issue chaos
//   flows: a comment that waited through a kill, a 401 or an expiry is sent
//   once, with no second copy).
// web-*: Ada, the admin, on the web in a sign-in of her own, for the issue
//   chaos flows (README, Chaos): web-file files an issue titled --text
//   (with --count, n issues titled "<text> 1" to "<text> n": a3-tour.yaml fills
//   the Board to about the live board's 330 for the cold start and scroll);
//   web-retitle changes the title of the one issue titled --text to --to;
//   web-delete deletes it; web-sign-out signs her out everywhere (the web's
//   "Sign out everywhere", /api/auth/revoke-sessions), so the app's next
//   request is a 401 before its session's expiry. web-invite adds a made-up
//   member (`invitee-<random>@example.test`) as People's Add person does and
//   prints the invite as the development build's link-domain link
//   (`https://<link host>/dev/i/<host>#t=<token>`, shared's appLink): the
//   server makes no such link for servers.mjs's plain-http workspaces.
// web-page*: Ada's pages on the web, for the pages' two-device and chaos
//   flows (README, Two devices): web-page prints the one live page titled
//   --page (its ids, revision and Markdown) and, with --expect (repeatable),
//   fails unless the Markdown holds each text exactly once; web-page-write
//   saves --text as its Markdown at its current revision (the web's
//   autosave); web-page-delete deletes it; web-page-move moves it to the
//   top of the Space named --to, made first when there is none.
//
// It prints one JSON line with what it did (ids only), and never the password.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { signedIn } from './servers.mjs';

export const COMMANDS = [
    'message',
    'invite',
    'cancel',
    'read',
    'issues',
    'comments',
    'web-file',
    'web-retitle',
    'web-delete',
    'web-sign-out',
    'web-invite',
    'web-page',
    'web-page-write',
    'web-page-delete',
    'web-page-move',
];

/** The page commands: each takes --page, the page's title. */
const PAGE_COMMANDS = ['web-page', 'web-page-write', 'web-page-delete', 'web-page-move'];

/** The commands that take --text, the title (or message) they act on; those marked true need it. */
const TEXT_COMMANDS = {
    message: false,
    read: false,
    issues: true,
    comments: true,
    'web-file': true,
    'web-retitle': true,
    'web-delete': true,
    'web-page-write': true,
};

const USAGE = `Usage: node apps/mobile/e2e/act-as.mjs --credentials <file> [--workspace A|B|C] <command>

  message [--text <text>] [--no-wait]   Ben mentions Ada in the seeded room, then waits for the turn
  invite                                Ben invites Ada to his own room (made once)
  cancel                                Ben takes that invite back
  read [--text <text>]                  Ben finds Ada's newest room message and checks it mentions him
  issues --text <title>                 Ben counts the issues with that title (exactly one) and their files
  comments --issue <t> --text <comment> Ben counts that comment on the issue titled <t> (exactly one)
  web-file --text <title> [--count <n>] Ada files an issue with that title on the web (n, numbered)
  web-retitle --text <title> --to <t>   Ada retitles the one issue with that title on the web
  web-delete --text <title>             Ada deletes the one issue with that title on the web
  web-sign-out                          Ada signs out everywhere on the web: the app's session ends
  web-invite [--link-host <host>]       Ada invites a made-up person; prints the email and the dev build's i link
  web-page --page <title> [--expect <t>] Ada reads that page (each --expect exactly once in its Markdown)
  web-page-write --page <t> --text <md> Ada saves that Markdown as the page's, at its revision
  web-page-delete --page <title>        Ada deletes that page on the web
  web-page-move --page <t> --to <Space> Ada moves that page to the top of that Space (made if missing)`;

/**
 * Reads the command line. Throws with a message for anything it can't use.
 * @param {string[]} argv
 */
export function parseActAsArgs(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: true,
        options: {
            credentials: { type: 'string' },
            workspace: { type: 'string', default: 'A' },
            text: { type: 'string' },
            to: { type: 'string' },
            issue: { type: 'string' },
            page: { type: 'string' },
            expect: { type: 'string', multiple: true },
            count: { type: 'string' },
            'link-host': { type: 'string' },
            'no-wait': { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
        },
    });
    if (values.help) {
        return { help: USAGE };
    }
    if (positionals.length !== 1 || !COMMANDS.includes(positionals[0])) {
        throw new Error(`Give one command: ${COMMANDS.join(', ')}.`);
    }
    const command = /** @type {Command} */ (positionals[0]);
    if (!values.credentials) {
        throw new Error("--credentials names servers.mjs's credentials file.");
    }
    if (!/^[ABC]$/.test(values.workspace)) {
        throw new Error(`--workspace is A, B or C, not "${values.workspace}".`);
    }
    if (command !== 'message' && values['no-wait']) {
        throw new Error('--no-wait goes with message only.');
    }
    if (!(command in TEXT_COMMANDS) && values.text !== undefined) {
        throw new Error(`--text goes with ${Object.keys(TEXT_COMMANDS).join(', ')} only.`);
    }
    if (TEXT_COMMANDS[/** @type {keyof typeof TEXT_COMMANDS} */ (command)] && values.text === undefined) {
        throw new Error(`${command} needs --text, the issue's title.`);
    }
    const takesTo = command === 'web-retitle' || command === 'web-page-move';
    if (takesTo !== (values.to !== undefined)) {
        throw new Error(takesTo ? `${command} needs --to.` : '--to goes with web-page-move or web-retitle only.');
    }
    const paged = PAGE_COMMANDS.includes(command);
    if (paged !== (values.page !== undefined)) {
        throw new Error(paged ? `${command} needs --page, the page's title.` : '--page goes with web-page* only.');
    }
    if (values.page !== undefined && !values.page.trim()) {
        throw new Error('--page is empty.');
    }
    if (values.expect !== undefined && command !== 'web-page') {
        throw new Error('--expect goes with web-page only.');
    }
    if ((command === 'comments') !== (values.issue !== undefined)) {
        throw new Error(
            command === 'comments' ? "comments needs --issue, the issue's title." : '--issue goes with comments only.',
        );
    }
    if (values.issue !== undefined && !values.issue.trim()) {
        throw new Error('--issue is empty.');
    }
    if (values.to !== undefined && !values.to.trim()) {
        throw new Error('--to is empty.');
    }
    if (values.text !== undefined && !values.text.trim()) {
        throw new Error('--text is empty.');
    }
    if (values['link-host'] !== undefined && command !== 'web-invite') {
        throw new Error('--link-host goes with web-invite only.');
    }
    if (values.count !== undefined && command !== 'web-file') {
        throw new Error('--count goes with web-file only.');
    }
    const count = values.count === undefined ? undefined : Number(values.count);
    if (count !== undefined && !(Number.isInteger(count) && count >= 1 && count <= 1000)) {
        throw new Error(`--count is a whole number from 1 to 1000, not "${values.count}".`);
    }
    return {
        command,
        credentials: values.credentials,
        letter: values.workspace,
        text: values.text,
        to: values.to,
        issue: values.issue,
        page: values.page,
        expect: values.expect,
        count,
        linkHost: command === 'web-invite' ? (values['link-host'] ?? DEV_LINK_HOST) : undefined,
        wait: !values['no-wait'],
    };
}

/** @typedef {'message' | 'invite' | 'cancel' | 'read' | 'issues' | 'comments' | 'web-file' | 'web-retitle' | 'web-delete' | 'web-sign-out' | 'web-invite' | 'web-page' | 'web-page-write' | 'web-page-delete' | 'web-page-move'} Command */

/**
 * Ben's room message mentioning Ada: `@Ada` in the text and her id in
 * `mentions`, the steering body the web's composer sends (CB-216).
 * @param {string} letter
 * @param {string} adaId
 * @param {string} [text]
 */
export function mentionBody(letter, adaId, text) {
    const said = text?.trim() || `${letter}: can you look at the launch notes?`;
    return { text: `@Ada ${said}`, mentions: [{ userId: adaId, label: 'Ada' }] };
}

/**
 * Ada's newest message in a room transcript (as Ben reads it), holding `text`
 * when given, with the names the server checked as mentioned; null for none.
 * @param {{ messages: Array<{ id: string, role: string, content?: unknown, author?: { name: string }, mentions?: Array<{ name: string, you: boolean }> }> }} transcript
 * @param {string} [text]
 */
export function adasMessage(transcript, text) {
    const found = transcript.messages.findLast(
        (message) =>
            message.role === 'user' &&
            message.author?.name === 'Ada' &&
            (text === undefined || (typeof message.content === 'string' && message.content.includes(text))),
    );
    if (!found) {
        return null;
    }
    const mentions = found.mentions ?? [];
    return {
        messageId: found.id,
        mentioned: mentions.map((mention) => mention.name),
        mentionsYou: mentions.some((mention) => mention.you),
    };
}

/**
 * The numbers of the issues titled exactly `title` (as the server stores it, trimmed), lowest first.
 * @param {{ issues: Array<{ number: number, title: string }> }} list
 * @param {string} title
 */
export function issuesTitled(list, title) {
    return list.issues
        .filter((issue) => issue.title === title.trim())
        .map((issue) => issue.number)
        .sort((a, b) => a - b);
}

/**
 * The ids of an issue detail's comments saying exactly `text` (as the server stores it, trimmed), oldest first.
 * @param {{ comments: Array<{ id: string, body: string, createdAt: number }> }} detail
 * @param {string} text
 */
export function commentsSaying(detail, text) {
    return detail.comments
        .filter((comment) => comment.body.trim() === text.trim())
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((comment) => comment.id);
}

/** The title of Ben's own room, which `invite` makes once. @param {string} letter */
export const bensRoom = (letter) => `${letter}: Ben's room`;

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Runs one command as Ben against the workspace in the credentials file.
 * @param {{ command: Command, letter: string, text?: string, to?: string, issue?: string, count?: number, linkHost?: string, wait: boolean }} options
 * @param {{ password: string, accounts: Array<{ email: string, name: string }>,
 *   servers: Array<{ letter: string, origin: string, room?: { id: string, socios: Record<string, string>, people: Record<string, string> } }> }} credentials
 */
export async function actAs(options, credentials) {
    const server = credentials.servers.find((entry) => entry.letter === options.letter);
    if (!server) {
        throw new Error(`The credentials file has no workspace ${options.letter}.`);
    }
    const web = options.command.startsWith('web-');
    const person = credentials.accounts.find((account) => account.name === (web ? 'Ada' : 'Ben'));
    if (!person) {
        throw new Error(`The credentials file has no ${web ? 'Ada' : 'Ben'}.`);
    }
    const call = await signedIn(
        { port: Number(new URL(server.origin).port), origin: server.origin },
        person.email,
        credentials.password,
    );
    if (PAGE_COMMANDS.includes(options.command)) {
        return { command: options.command, ...(await actOnPages(call, options)) };
    }
    if (options.command === 'web-invite') {
        return {
            command: 'web-invite',
            ...(await inviteOnTheWeb(call, server.origin, options.linkHost ?? DEV_LINK_HOST)),
        };
    }
    if (web) {
        const done = await actOnTheWeb(call, options);
        return { command: options.command, number: done.number, ...('filed' in done ? { filed: done.filed } : {}) };
    }
    if (options.command === 'issues') {
        const title = /** @type {string} */ (options.text);
        const numbers = issuesTitled(await (await call('GET', '/api/issues')).json(), title);
        const attachments = [];
        for (const number of numbers) {
            const detail = await (await call('GET', `/api/issues/${number}`)).json();
            attachments.push(
                detail.attachments.map((/** @type {{ name: string, mediaType: string, size: number }} */ file) => ({
                    name: file.name,
                    mediaType: file.mediaType,
                    size: file.size,
                })),
            );
        }
        if (numbers.length !== 1) {
            throw new Error(`${numbers.length} issues are titled "${title.trim()}" (${numbers.join(', ')}), not one.`);
        }
        return { command: 'issues', numbers, attachments };
    }
    if (options.command === 'comments') {
        const title = /** @type {string} */ (options.issue);
        const text = /** @type {string} */ (options.text);
        const numbers = issuesTitled(await (await call('GET', '/api/issues')).json(), title);
        if (numbers.length !== 1) {
            throw new Error(`${numbers.length} issues are titled "${title.trim()}" (${numbers.join(', ')}), not one.`);
        }
        const [number] = numbers;
        const ids = commentsSaying(await (await call('GET', `/api/issues/${number}`)).json(), text);
        if (ids.length !== 1) {
            throw new Error(`${ids.length} comments on #${number} say "${text.trim()}", not one.`);
        }
        return { command: 'comments', number, comments: ids };
    }
    if (!server.room) {
        throw new Error(`The credentials file has no seeded room for workspace ${options.letter}.`);
    }
    const adaId = server.room.people.Ada;
    if (options.command === 'message') {
        const id = encodeURIComponent(server.room.id);
        const { message } = await (
            await call('POST', `/api/conversations/${id}/steering`, mentionBody(options.letter, adaId, options.text))
        ).json();
        if (options.wait) {
            await stored(call, server.room.id, message.id);
        }
        return { command: 'message', roomId: server.room.id, messageId: message.id, waited: options.wait };
    }
    if (options.command === 'read') {
        const id = encodeURIComponent(server.room.id);
        const found = adasMessage(
            await (await call('GET', `/api/conversations/${id}/transcript`)).json(),
            options.text,
        );
        if (!found) {
            throw new Error("Ada's message isn't in the room's transcript.");
        }
        if (!found.mentionsYou) {
            throw new Error(`Ada's message ${found.messageId} doesn't mention Ben.`);
        }
        return { command: 'read', roomId: server.room.id, ...found };
    }
    const roomId = await ownRoom(call, options.letter, server.room.socios.Sebas);
    const id = encodeURIComponent(roomId);
    const view = await (await call('GET', `/api/rooms/${id}`)).json();
    const ada = view.members.find((/** @type {{ userId: string }} */ member) => member.userId === adaId);
    if (options.command === 'invite') {
        if (ada?.status !== 'invited' && ada?.status !== 'active') {
            await call('POST', `/api/rooms/${id}/invites`, { userId: adaId });
        }
        return { command: 'invite', roomId, adaWas: ada?.status ?? 'none' };
    }
    if (ada?.status === 'invited') {
        await call('DELETE', `/api/rooms/${id}/members/${encodeURIComponent(adaId)}`, {});
    }
    return { command: 'cancel', roomId, adaWas: ada?.status ?? 'none' };
}

/**
 * The titles `web-file --count` files: "<title> 1" to "<title> <count>".
 * @param {string} title
 * @param {number} count
 */
export function numberedTitles(title, count) {
    return Array.from({ length: count }, (_, index) => `${title} ${index + 1}`);
}

/** The development build's link host (the app's SOCIO_LINK_HOST default, shared's LINK_STAGING_HOST). */
export const DEV_LINK_HOST = 'link-staging.socio.sh';

/**
 * The invite's token read from the web's password link (`<origin>/reset-password?token=`)
 * and put in the development build's link-domain invite, as the server would on an https workspace.
 * @param {string} passwordLink
 * @param {string} origin
 * @param {string} linkHost
 */
export async function devInviteLink(passwordLink, origin, linkHost) {
    const token = new URL(passwordLink).searchParams.get('token');
    if (!token) {
        throw new Error('The invite has no token: is "Invites open the Socio app" on?');
    }
    const { appLink } = await import('../../../packages/shared/src/device-sign-in.ts');
    return appLink({ kind: 'i', variant: 'development', host: new URL(origin).host, fields: { t: token } }, linkHost);
}

/**
 * Ada adds a made-up member with no password (People's Add person), which makes their invite.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} origin
 * @param {string} linkHost
 */
async function inviteOnTheWeb(call, origin, linkHost) {
    const email = `invitee-${randomBytes(4).toString('hex')}@example.test`;
    const made = await (await call('POST', '/api/accounts', { email, name: 'Dee Invitee', role: 'member' })).json();
    return { email, link: await devInviteLink(made.link.url, origin, linkHost) };
}

/**
 * Ada's changes on the web (the issue chaos flows), in her own sign-in.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {{ command: Command, text?: string, to?: string, count?: number }} options
 */
async function actOnTheWeb(call, options) {
    if (options.command === 'web-sign-out') {
        await call('POST', '/api/auth/revoke-sessions', {});
        return { number: undefined };
    }
    const title = /** @type {string} */ (options.text).trim();
    if (options.command === 'web-file') {
        const file = async (/** @type {string} */ issueTitle) => {
            const created = await (
                await call('POST', '/api/issues', {
                    title: issueTitle,
                    body: 'Filed on the web for the chaos flows.',
                    kind: 'bug',
                    priority: 'high',
                })
            ).json();
            return /** @type {number} */ (created.issue?.number ?? created.number);
        };
        if (options.count === undefined) {
            return { number: await file(title) };
        }
        /** @type {number[]} */
        const numbers = [];
        for (const issueTitle of numberedTitles(title, options.count)) {
            numbers.push(await file(issueTitle));
        }
        return { number: numbers[0], filed: numbers.length };
    }
    const numbers = issuesTitled(await (await call('GET', '/api/issues')).json(), title);
    if (numbers.length !== 1) {
        throw new Error(`${numbers.length} issues are titled "${title}" (${numbers.join(', ')}), not one.`);
    }
    const [number] = numbers;
    if (options.command === 'web-retitle') {
        await call('PATCH', `/api/issues/${number}`, { title: /** @type {string} */ (options.to).trim() });
    } else {
        await call('DELETE', `/api/issues/${number}`, {});
    }
    return { number };
}

/**
 * How many times `text` stands in `content`, exactly as typed (the two-device flows: a line
 * typed on each phone is in the page once, never lost and never twice).
 * @param {string} content
 * @param {string} text
 */
export function occurrences(content, text) {
    return text === '' ? 0 : content.split(text).length - 1;
}

/**
 * Why a page's Markdown fails web-page's --expect: each text missing or there
 * more than once, as lines. Empty when it passes.
 * @param {string} content
 * @param {string[]} expected
 */
export function expectProblems(content, expected) {
    return expected.flatMap((text) => {
        const count = occurrences(content, text);
        return count === 1 ? [] : [`"${text}" is in the page ${count} times, not once`];
    });
}

/**
 * The one live page titled `title` in the Spaces Ada reads: its Space's id
 * and its summary. Throws unless there is exactly one.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} title
 */
async function pageTitled(call, title) {
    const { spaces } = await (await call('GET', '/api/workspace')).json();
    /** @type {Array<{ spaceId: string, id: string, revision: number }>} */
    const found = [];
    for (const space of spaces) {
        const list = await (await call('GET', `/api/spaces/${encodeURIComponent(space.id)}/pages`)).json();
        for (const page of list) {
            if (page.title === title.trim()) {
                found.push({ spaceId: space.id, id: page.id, revision: page.revision });
            }
        }
    }
    if (found.length !== 1) {
        throw new Error(`${found.length} pages are titled "${title.trim()}", not one.`);
    }
    return found[0];
}

/**
 * Ada's page changes on the web, in her own sign-in. Returns ids,
 * the revision and, for web-page, the Markdown (servers.mjs's made-up data).
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {{ command: Command, page?: string, text?: string, to?: string, expect?: string[] }} options
 */
async function actOnPages(call, options) {
    const found = await pageTitled(call, /** @type {string} */ (options.page));
    const path = `/api/spaces/${encodeURIComponent(found.spaceId)}/pages/${encodeURIComponent(found.id)}`;
    const ids = { spaceId: found.spaceId, pageId: found.id };
    if (options.command === 'web-page') {
        const page = await (await call('GET', path)).json();
        const problems = expectProblems(page.content, options.expect ?? []);
        if (problems.length > 0) {
            throw new Error(`${problems.join('; ')}. The page reads:\n${page.content}`);
        }
        return { ...ids, revision: page.revision, content: page.content };
    }
    if (options.command === 'web-page-write') {
        const page = await (
            await call('PATCH', path, { content: options.text, expectedRevision: found.revision })
        ).json();
        return { ...ids, revision: page.revision };
    }
    if (options.command === 'web-page-delete') {
        await call('DELETE', path, {});
        return ids;
    }
    const name = /** @type {string} */ (options.to).trim();
    const { spaces } = await (await call('GET', '/api/workspace')).json();
    const target =
        spaces.find((/** @type {{ name: string }} */ space) => space.name === name) ??
        (await (await call('POST', '/api/spaces', { name })).json());
    const moved = await (
        await call('POST', `${path}/move`, { spaceId: target.id, parentId: null, expectedRevision: found.revision })
    ).json();
    return { ...ids, to: target.id, revision: moved.revision ?? moved.page?.revision };
}

/**
 * Ben's own room, made once with the lead socio (any member may make one
 * while Rooms are on). Returns its id.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} letter
 * @param {string} leadId
 */
async function ownRoom(call, letter, leadId) {
    const { conversations } = await (await call('GET', '/api/workspace')).json();
    const found = conversations.find(
        (/** @type {{ kind?: string, title: string }} */ chat) =>
            chat.kind === 'room' && chat.title === bensRoom(letter),
    );
    if (found) {
        return found.id;
    }
    const created = await (await call('POST', '/api/rooms', { dotId: leadId, title: bensRoom(letter) })).json();
    return created.id;
}

/**
 * Waits until the room's history holds the message and no turn runs.
 * @param {Awaited<ReturnType<typeof signedIn>>} call
 * @param {string} roomId
 * @param {string} messageId
 */
async function stored(call, roomId, messageId, timeoutMs = 120_000) {
    const id = encodeURIComponent(roomId);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const steering = await (await call('GET', `/api/conversations/${id}/steering`)).json();
        const history = await (await call('GET', `/api/conversations/${id}/history`)).json();
        const held = history.runs.some((/** @type {{ messages: Array<{ id: string }> }} */ run) =>
            run.messages.some((message) => message.id === messageId),
        );
        if (held && !steering.running) {
            return;
        }
        await sleep(500);
    }
    throw new Error(`The message ${messageId} wasn't stored with its turn ended after ${timeoutMs / 1000} s.`);
}

async function main() {
    const options = parseActAsArgs(process.argv.slice(2));
    if ('help' in options) {
        console.log(options.help);
        return;
    }
    const credentials = JSON.parse(readFileSync(options.credentials, 'utf8'));
    console.log(JSON.stringify(await actAs(options, credentials)));
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`[act-as] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
