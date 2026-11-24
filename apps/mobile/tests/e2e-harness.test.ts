import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { ISSUE_ATTACHMENT_MAX_BYTES, ISSUE_STATUSES } from '@socio/shared/issues/issue-types';

import {
    adasMessage,
    bensRoom,
    commentsSaying,
    COMMANDS,
    DEV_LINK_HOST,
    devInviteLink,
    expectProblems,
    issuesTitled,
    mentionBody,
    numberedTitles,
    occurrences,
    parseActAsArgs,
} from '../e2e/act-as.mjs';
import { dateAhead } from '../e2e/clock-ahead.mjs';
import {
    appSnapshots,
    checkNoWorkspaceLeft,
    httpCacheEntries,
    webViewStorage,
    credentialEnv,
    devClientUrl,
    FLOWS,
    parseRunArgs,
    RESERVED_ENV,
    reversedOrigins,
    roomsRefusal,
    VARIANT_APPS,
    workspaceCacheUrls,
    workspaceFolders,
} from '../e2e/run.mjs';
import {
    a2Seeds,
    a3Seeds,
    accountCommands,
    ACCOUNTS,
    aheadDays,
    BRANDING_LOGO,
    brandingOf,
    DEFAULT_PORTS,
    firstRunFinished,
    HANDOFF_NOTE_SOURCE,
    missingRoomSeeds,
    missingSeeds,
    proposeMemory,
    parseServerArgs,
    seedPicture,
    seedPlan,
    serverEnv,
    serverStart,
    TASK_INTERVAL_SECONDS,
} from '../e2e/servers.mjs';
import { codeIn, decodeQuotedPrintable, FAKE_BOT_TOKEN, outbox, pkce, readMail, smtpSink } from '../e2e/web-side.mjs';
import { outboxTallyLine } from '../src/sync/outbox-tally';

describe('servers.mjs', () => {
    it('reads its arguments', () => {
        expect(parseServerArgs([])).toMatchObject({ ports: [4351], modelPort: 4550, adb: true, once: false });
        expect(parseServerArgs(['--count', '3']).ports).toEqual(DEFAULT_PORTS);
        expect(parseServerArgs(['--ports', '5001,5002', '--model-port', '5100', '--no-adb', '--once'])).toMatchObject({
            ports: [5001, 5002],
            modelPort: 5100,
            adb: false,
            once: true,
        });
        expect(parseServerArgs([], { ANDROID_SERIAL: 'emulator-5554' }).device).toBe('emulator-5554');
        expect(parseServerArgs(['--device', 'x'], { ANDROID_SERIAL: 'y' }).device).toBe('x');
        expect(parseServerArgs(['--help'])).toHaveProperty('help');
        expect(parseServerArgs([]).control).toBe(4549);
        // --dev-links: development-build links (AUTH_APP_DEV_LINKS), off by default.
        expect(parseServerArgs([]).devLinks).toBe(false);
        expect(parseServerArgs(['--dev-links']).devLinks).toBe(true);
        const plan = (devLinks: boolean) =>
            seedPlan({ ports: [4351], modelPort: 4550, dir: '/tmp/x', devLinks })[0].env.AUTH_APP_DEV_LINKS;
        expect(plan(false)).toBeUndefined();
        expect(plan(true)).toBe('true');
        expect(parseServerArgs(['--control', '4600']).control).toBe(4600);
        expect(() => parseServerArgs(['--control', '4351'])).toThrow(/different/);
        expect(parseServerArgs([]).capture).toBeUndefined();
        expect(parseServerArgs(['--capture', '/tmp/rooms']).capture).toBe('/tmp/rooms');
        expect(parseServerArgs([]).rooms).toBe(true);
        expect(parseServerArgs(['--no-rooms']).rooms).toBe(false);
        expect(() => parseServerArgs(['--no-rooms', '--capture', '/tmp/rooms'])).toThrow(/--no-rooms/);
    });

    it('names the workspace in its branding, as an admin, with the bundled logo', () => {
        // No operator role (CB-390): Ada and Opal are both admins.
        expect(ACCOUNTS.filter((account) => account.role === 'admin').map((account) => account.email)).toEqual([
            'ada@example.test',
            'opal@example.test',
        ]);
        expect(brandingOf('Workspace A')).toEqual({ branding: { name: 'Workspace A', logo: '/favicon.svg' } });
        expect(BRANDING_LOGO).toBe('/favicon.svg');
    });

    it('restarts a server on its own database, its clock ahead when asked', () => {
        const [server] = seedPlan({ ports: [4351], modelPort: 4550, dir: '/tmp/e2e' });
        const plain = serverStart(server!.env, 0);
        expect(plain.env).toBe(server!.env);
        expect(plain.args).not.toContain('./apps/mobile/e2e/clock-ahead.mjs');
        const ahead = serverStart(server!.env, 8);
        expect(ahead.args).toContain('./apps/mobile/e2e/clock-ahead.mjs');
        expect(ahead.env.SOCIO_E2E_CLOCK_AHEAD_MS).toBe(String(8 * 24 * 60 * 60 * 1000));
        expect(ahead.env.DATABASE_PATH).toBe(server!.env.DATABASE_PATH);
        expect(existsSync(join(import.meta.dirname, '../e2e/clock-ahead.mjs'))).toBe(true);
        expect([
            aheadDays(null),
            aheadDays('8'),
            aheadDays('0.5'),
            aheadDays('-1'),
            aheadDays('x'),
            aheadDays('401'),
        ]).toEqual([0, 8, 0.5, null, null, null]);
    });

    it('moves "now" ahead and leaves a given date alone (clock-ahead.mjs)', () => {
        const Ahead = dateAhead(Date, 8 * 24 * 60 * 60 * 1000);
        const shifted = Ahead.now() - Date.now();
        expect(shifted).toBeGreaterThanOrEqual(8 * 24 * 60 * 60 * 1000 - 5);
        expect(new Ahead().getTime() - Date.now()).toBeGreaterThanOrEqual(8 * 24 * 60 * 60 * 1000 - 5);
        expect(new Ahead(0).getTime()).toBe(0);
        expect(new Ahead('2026-01-02T00:00:00Z').toISOString()).toBe('2026-01-02T00:00:00.000Z');
        expect(new Ahead() instanceof Date).toBe(true);
    });

    it('refuses arguments it cannot use', () => {
        expect(() => parseServerArgs(['--count', '4'])).toThrow(/--count/);
        expect(() => parseServerArgs(['--count', '2', '--ports', '5001'])).toThrow(/not both/);
        expect(() => parseServerArgs(['--ports', '5001,5002,5003,5004'])).toThrow(/one to three/);
        expect(() => parseServerArgs(['--ports', '80'])).toThrow(/1024/);
        expect(() => parseServerArgs(['--ports', '4550'])).toThrow(/different/);
        expect(() => parseServerArgs(['--rooms'])).toThrow();
    });

    it('plans a distinct name, Space and chats per workspace, on its own origin and files', () => {
        const plan = seedPlan({ ports: DEFAULT_PORTS, modelPort: 4550, dir: '/tmp/e2e', path: '/usr/bin' });
        expect(
            plan.map(({ origin, workspaceName, chat, space, archivedChat }) => ({
                origin,
                workspaceName,
                chat,
                space,
                archivedChat,
            })),
        ).toEqual([
            {
                origin: 'http://localhost:4351',
                workspaceName: 'Workspace A',
                chat: 'A: kickoff',
                space: 'A only',
                archivedChat: 'A: archived',
            },
            {
                origin: 'http://localhost:4352',
                workspaceName: 'Workspace B',
                chat: 'B: kickoff',
                space: 'B only',
                archivedChat: 'B: archived',
            },
            {
                origin: 'http://localhost:4353',
                workspaceName: 'Workspace C',
                chat: 'C: kickoff',
                space: 'C only',
                archivedChat: 'C: archived',
            },
        ]);
        // The marker chat's one turn asks the fake model for its long answer (the chat screen's transcript).
        expect(plan.map((server) => server.message)).toEqual(['A: smoke long', 'B: smoke long', 'C: smoke long']);
        const [first] = plan;
        expect(first.env).toMatchObject({
            PATH: '/usr/bin',
            HOST: '127.0.0.1',
            PORT: '4351',
            APP_ORIGIN: 'http://localhost:4351',
            AUTH_PROVIDER: 'betterauth',
            DATABASE_PATH: join('/tmp/e2e/ws1', 'brain.sqlite'),
            BACKUP_DIR: join('/tmp/e2e/ws1', 'backups'),
            OPENAI_BASE_URL: 'http://127.0.0.1:4550/v1',
            OPENAI_API_KEY: 'unused',
            ROOMS_ENABLED: 'true',
        });
        // Built from scratch: no key from the shell.
        expect(Object.keys(first.env).filter((name) => /KEY|TOKEN/.test(name))).toEqual([
            'OPENAI_API_KEY',
            'TELEGRAM_BOT_TOKEN',
        ]);
        expect(new Set(plan.map((server) => server.env.DATABASE_PATH)).size).toBe(3);
        expect(() => seedPlan({ ports: [], modelPort: 4550, dir: '/tmp/e2e' })).toThrow();
    });

    it('creates every account, then deactivates Cy', () => {
        const commands = accountCommands('/tmp/pw');
        expect(commands.map((command) => command.slice(0, 3))).toEqual([
            ...ACCOUNTS.map((account) => ['create-user', '--email', account.email]),
            ['deactivate', '--email', 'cy@example.test'],
        ]);
        expect(commands[0]).toContain('/tmp/pw');
        expect(ACCOUNTS.every((account) => account.email.endsWith('@example.test'))).toBe(true);
    });

    it("plans A3's seeds: an issue in every status, Ben's in triage, memories, a profile and a repeating task", () => {
        const [a, b] = seedPlan({ ports: [4351, 4352], modelPort: 4550, dir: '/tmp/e2e' });
        expect(a.issues.map((issue) => issue.status)).toEqual([...ISSUE_STATUSES]);
        expect(a.issues.filter((issue) => issue.by === 'ben').map((issue) => issue.status)).toEqual(['triage']);
        expect(a.issues.filter((issue) => issue.vote && issue.comment)).toHaveLength(1);
        expect(a.issues.filter((issue) => issue.picture)).toHaveLength(1);
        expect(new Set(a.issues.map((issue) => issue.title)).size).toBe(a.issues.length);
        expect(a.issues.every((issue) => issue.title.startsWith('A: '))).toBe(true);
        expect(b.issues.every((issue) => issue.title.startsWith('B: '))).toBe(true);
        expect(a.memories).toHaveLength(2);
        expect(a.proposal).toBe('A: Ada reviews the board every Monday morning.');
        expect(a.memories).not.toContain(a.proposal);
        expect(a.profile).toMatchObject({ name: 'Ada', timezone: 'Europe/Madrid' });
        // A chat of its own: its run must not add a turn to the marker chat.
        expect(a.task).toEqual({
            prompt: 'A: weekly digest of the board',
            intervalSeconds: TASK_INTERVAL_SECONDS,
            chat: 'A: digest',
        });
        expect(a.task.chat).not.toBe(a.chat);
        expect(a3Seeds('C').task.prompt).toBe('C: weekly digest of the board');
    });

    it('draws a PNG the server takes as an image', () => {
        const png = seedPicture();
        expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([96, 64]);
        expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
        expect(png.length).toBeLessThan(ISSUE_ATTACHMENT_MAX_BYTES);
    });

    it('names each A3 seed the server lacks after start', () => {
        const plan = a3Seeds('A');
        const voted = plan.issues.find((issue) => issue.vote);
        const pictured = plan.issues.find((issue) => issue.picture);
        if (!voted || !pictured) {
            throw new Error('The plan has a voted and a pictured issue.');
        }
        const complete = {
            issues: {
                issues: plan.issues.map((issue) => ({
                    title: issue.title,
                    status: issue.status,
                    ...(issue.vote ? { votes: 1 } : {}),
                })),
            },
            details: {
                [voted.title]: { comments: [{}], attachments: [] },
                [pictured.title]: { comments: [], attachments: [{ mediaType: 'image/png' }] },
            },
            memories: {
                profile: { fields: { ...plan.profile } },
                memories: plan.memories.map((text) => ({ text })),
                proposals: [{ text: plan.proposal }],
            },
            schedules: {
                schedules: [
                    {
                        prompt: plan.task.prompt,
                        intervalSeconds: plan.task.intervalSeconds,
                        threadId: 't-1',
                        lastRun: { finishedAt: 1_000 },
                    },
                ],
            },
            conversations: [{ id: 't-1', title: plan.task.chat }],
        };
        expect(missingSeeds(plan, complete)).toEqual([]);
        // The task's run still going, and its chat still under the server's name.
        expect(
            missingSeeds(plan, {
                ...complete,
                schedules: {
                    schedules: complete.schedules.schedules.map((task) => ({ ...task, lastRun: { finishedAt: null } })),
                },
                conversations: [{ id: 't-1', title: 'Weekly board digest' }],
            }),
        ).toEqual([
            'the finished first run of "A: weekly digest of the board"',
            'the task\'s chat named "A: digest" again',
        ]);

        const broken = {
            issues: {
                issues: complete.issues.issues
                    .filter((issue) => issue.status !== 'blocked')
                    .map((issue) => (issue.status === 'triage' ? { ...issue, status: 'open' } : issue))
                    .map(({ votes: _votes, ...issue }) => issue),
            },
            details: {},
            memories: { profile: null, memories: [{ text: plan.memories[0] }] },
            schedules: { schedules: [{ prompt: plan.task.prompt, intervalSeconds: null, threadId: 't-1' }] },
            conversations: [],
        };
        expect(missingSeeds(plan, broken)).toEqual([
            'issue "A: Search misses accents" in triage',
            'a vote on "A: Export the board as CSV"',
            'a comment on "A: Export the board as CSV"',
            'a picture on "A: Chat header overlaps the notch"',
            'issue "A: Calendar sync" in blocked',
            'memory "A: The team ships on Thursdays."',
            'proposal "A: Ada reviews the board every Monday morning."',
            "the profile's name",
            "the profile's role",
            "the profile's timezone",
            'repeating task "A: weekly digest of the board" in /api/schedules',
        ]);
    });
});

describe("servers.mjs: the socio's memory proposal", () => {
    it('writes one proposal for the owner of a seeded memory, once', () => {
        const dir = mkdtempSync(join(tmpdir(), 'xb3-propose-'));
        try {
            const path = join(dir, 'brain.sqlite');
            const db = new DatabaseSync(path);
            db.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL,
                userId TEXT, deletedAt INTEGER, deletedBy TEXT, status TEXT NOT NULL DEFAULT 'active',
                source TEXT NOT NULL DEFAULT 'person', shareable INTEGER NOT NULL DEFAULT 0, dotId TEXT,
                threadId TEXT, updatedAt INTEGER, confirmedAt INTEGER)`);
            db.prepare('INSERT INTO memories (id, text, createdAt, userId) VALUES (?, ?, ?, ?)').run(
                'm-1',
                'A: Ada prefers short answers.',
                1,
                'u-ada',
            );
            const proposal = {
                text: 'A: Ada reviews the board every Monday morning.',
                like: 'A: Ada prefers short answers.',
                dotId: 'd-sebas',
                threadId: 't-1',
                now: 5,
            };
            proposeMemory(path, proposal);
            proposeMemory(path, proposal);
            expect(
                db
                    .prepare(
                        "SELECT text, userId, status, source, dotId, threadId FROM memories WHERE status = 'proposed'",
                    )
                    .all(),
            ).toEqual([
                {
                    text: proposal.text,
                    userId: 'u-ada',
                    status: 'proposed',
                    source: 'socio',
                    dotId: 'd-sebas',
                    threadId: 't-1',
                },
            ]);
            expect(() => proposeMemory(path, { ...proposal, like: 'Nobody wrote this.' })).toThrow(/No memory/);
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("servers.mjs: the repeating task's first run", () => {
    it('returns the run once it has finished', async () => {
        const reads = [null, { status: 'running', finishedAt: null }, { status: 'finished', finishedAt: 5 }];
        await expect(
            firstRunFinished(async () => reads.shift(), 'A: "digest"', { tries: 5, delayMs: 1 }),
        ).resolves.toEqual({ status: 'finished', finishedAt: 5 });
        expect(reads).toEqual([]);
    });

    it('throws when the run is still going after every try, instead of going on', async () => {
        let read = 0;
        await expect(
            firstRunFinished(
                async () => {
                    read++;
                    return { status: 'running', finishedAt: null };
                },
                'A: "digest"',
                { tries: 3, delayMs: 1 },
            ),
        ).rejects.toThrow('The first run of A: "digest" hasn\'t finished after 0.003 s (running).');
        expect(read).toBe(3);
        await expect(firstRunFinished(async () => undefined, 'B: "digest"', { tries: 2, delayMs: 1 })).rejects.toThrow(
            '(not started)',
        );
    });
});

describe("servers.mjs's room", () => {
    const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
    const ada = fixture('room-history-ada.json');
    const ben = fixture('room-history-ben.json');
    const plan = a2Seeds('A').room;
    const room = {
        title: plan.title,
        dotId: 'd-sebas',
        members: [
            { name: 'Ada', status: 'active' },
            { name: 'Ben', status: 'active' },
        ],
        socios: [
            { dotId: 'd-sebas', name: 'Sebas', status: 'active' },
            { dotId: 'd-manny', name: 'Manny', status: 'active' },
        ],
    };

    it('leaves Rooms off and the room out with --no-rooms, for chat-tour.yaml', () => {
        const [on] = seedPlan({ ports: [4351], modelPort: 4550, dir: '/tmp/e2e' });
        const [off] = seedPlan({ ports: [4351], modelPort: 4550, dir: '/tmp/e2e', rooms: false });
        expect(on.env.ROOMS_ENABLED).toBe('true');
        expect(off.env).not.toHaveProperty('ROOMS_ENABLED');
        expect(off.room).toBeNull();
        // Everything else is the same plan.
        const { room: _on, env: _onEnv, ...restOn } = on;
        const { room: _off, env: _offEnv, ...restOff } = off;
        expect(restOff).toEqual(restOn);
    });

    it('plans a room per workspace: Sebas leads, Manny joins, three messages', () => {
        const [a, b] = seedPlan({ ports: [4351, 4352], modelPort: 4550, dir: '/tmp/e2e' });
        if (!a.room || !b.room) {
            throw new Error('Rooms are on by default, so each workspace has a room.');
        }
        expect(a.room).toMatchObject({ title: 'A: launch room', lead: 'Sebas', second: { name: 'Manny' } });
        expect(b.room.title).toBe('B: launch room');
        // The handoff: both socios named, the lead first.
        expect(a.room.handoff.startsWith('@Sebas @Manny ')).toBe(true);
        // Every later turn's model request starts with the opening, so it names
        // none of the fake model's phrases read from a chat's first message.
        for (const phrase of [
            'smoke phases',
            'smoke trace',
            'smoke hold',
            'smoke data',
            'smoke approvals',
            'smoke view',
        ]) {
            expect(a.room.opening).not.toContain(phrase);
        }
        expect(new Set([a.room.opening, a.room.handoff, a.room.failing]).size).toBe(3);
    });

    it('finds every seed in the captured history, and names each one missing', () => {
        expect(missingRoomSeeds(plan, { room, ada, ben })).toEqual([]);
        expect(missingRoomSeeds(plan, { room: null, ada, ben })).toEqual(['room "A: launch room"']);

        const notes = (page: typeof ada) => ({
            runs: page.runs.filter(
                (run: { messages: { metadata?: Record<string, unknown> }[] }) =>
                    !run.messages.some((message) => message.metadata?.socioSource === HANDOFF_NOTE_SOURCE),
            ),
        });
        const finished = { runs: ada.runs.filter((run: { status: string }) => run.status !== 'failed') };
        expect(
            missingRoomSeeds(plan, {
                room: {
                    ...room,
                    members: [
                        { name: 'Ada', status: 'active' },
                        { name: 'Ben', status: 'invited' },
                    ],
                    socios: [room.socios[0]!, { ...room.socios[1]!, status: 'requested' }],
                },
                ada: notes(finished),
                ben: ada,
            }),
        ).toEqual([
            'Manny active in the room',
            'Ben a member of the room',
            'a handoff after "@Sebas @Manny A: plan the launch together."',
            'a failed turn after "A: smoke context 2: one more look, please."',
            "a result withheld from Ben's copy",
        ]);
    });

    it("holds what the room screen needs: Ben's copy withholds Ada's results, a handoff note, Ben's failed turn", () => {
        const tools = (page: typeof ada) =>
            page.runs.flatMap((run: { messages: { role: string; content: string }[] }) =>
                run.messages.filter((message) => message.role === 'tool').map((message) => message.content),
            );
        expect(tools(ada).length).toBeGreaterThan(0);
        expect(tools(ada).every((content: string) => !content.includes('"withheld":true'))).toBe(true);
        expect(tools(ben).every((content: string) => content.includes('"withheld":true'))).toBe(true);
        const transcript = fixture('room-transcript-ada.json');
        expect(transcript.problems).toEqual([
            expect.objectContaining({ author: expect.objectContaining({ name: 'Ben', you: false }) }),
        ]);
        expect(fixture('room-transcript-ben.json').problems).toEqual([
            expect.objectContaining({ author: expect.objectContaining({ name: 'Ben', you: true }) }),
        ]);
    });
});

describe('act-as.mjs', () => {
    it('reads its arguments', () => {
        expect(parseActAsArgs(['--credentials', '/tmp/c.json', 'message'])).toEqual({
            command: 'message',
            credentials: '/tmp/c.json',
            letter: 'A',
            text: undefined,
            wait: true,
        });
        expect(
            parseActAsArgs([
                '--credentials',
                '/tmp/c.json',
                '--workspace',
                'B',
                'message',
                '--text',
                'hi',
                '--no-wait',
            ]),
        ).toMatchObject({ letter: 'B', text: 'hi', wait: false });
        for (const command of ['message', 'invite', 'cancel', 'read', 'web-sign-out']) {
            expect(parseActAsArgs(['--credentials', 'c', command]).command).toBe(command);
        }
        expect(parseActAsArgs(['--credentials', 'c', 'issues', '--text', 'FI: x'])).toMatchObject({
            command: 'issues',
            text: 'FI: x',
        });
        expect(parseActAsArgs(['--help'])).toHaveProperty('help');
    });

    it('acts as Ada on the web for the chaos flows', () => {
        expect(COMMANDS).toEqual(expect.arrayContaining(['web-file', 'web-retitle', 'web-delete', 'web-sign-out']));
        for (const command of ['web-file', 'web-delete']) {
            expect(parseActAsArgs(['--credentials', 'c', command, '--text', 'XB2: x'])).toMatchObject({
                command,
                text: 'XB2: x',
            });
            expect(() => parseActAsArgs(['--credentials', 'c', command])).toThrow(/needs --text/);
        }
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-retitle', '--text', 'XB2: x', '--to', 'XB2: y']),
        ).toMatchObject({ command: 'web-retitle', text: 'XB2: x', to: 'XB2: y' });
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-retitle', '--text', 'XB2: x'])).toThrow(/needs --to/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-delete', '--text', 'x', '--to', 'y'])).toThrow(
            /web-retitle only/,
        );
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-sign-out', '--text', 'x'])).toThrow(/--text goes/);
    });

    it('files n numbered issues with web-file --count, for the full Board', () => {
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-file', '--text', 'XB3: row', '--count', '330']),
        ).toMatchObject({ command: 'web-file', text: 'XB3: row', count: 330 });
        expect(parseActAsArgs(['--credentials', 'c', 'web-file', '--text', 'XB2: x']).count).toBeUndefined();
        for (const count of ['0', '1.5', '1001', 'many']) {
            expect(() => parseActAsArgs(['--credentials', 'c', 'web-file', '--text', 'x', '--count', count])).toThrow(
                /1 to 1000/,
            );
        }
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-delete', '--text', 'x', '--count', '2'])).toThrow(
            /web-file only/,
        );
        expect(numberedTitles('XB3: row', 3)).toEqual(['XB3: row 1', 'XB3: row 2', 'XB3: row 3']);
    });

    it('refuses arguments it cannot use', () => {
        expect(() => parseActAsArgs(['message'])).toThrow(/--credentials/);
        expect(() => parseActAsArgs(['--credentials', 'c'])).toThrow(/one command/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'approve'])).toThrow(/one command/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'invite', 'cancel'])).toThrow(/one command/);
        expect(() => parseActAsArgs(['--credentials', 'c', '--workspace', 'D', 'message'])).toThrow(/A, B or C/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'invite', '--text', 'x'])).toThrow(/--text goes with/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'issues'])).toThrow(/needs --text/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'read', '--no-wait'])).toThrow(/message only/);
        expect(parseActAsArgs(['--credentials', 'c', 'read', '--text', 'hi'])).toMatchObject({
            command: 'read',
            text: 'hi',
        });
        expect(() => parseActAsArgs(['--credentials', 'c', 'message', '--text', ' '])).toThrow(/empty/);
    });

    it("mentions Ada by id, as the web's people picker sends it", () => {
        expect(mentionBody('A', 'u-ada')).toEqual({
            text: '@Ada A: can you look at the launch notes?',
            mentions: [{ userId: 'u-ada', label: 'Ada' }],
        });
        expect(mentionBody('B', 'u-ada', 'Ready?').text).toBe('@Ada Ready?');
        expect(bensRoom('C')).toBe("C: Ben's room");
    });

    it('counts the issues with exactly a title (file-issue-offline.yaml)', () => {
        const list = {
            issues: [
                { number: 9, title: 'FI: Filed offline' },
                { number: 3, title: 'FI: Filed offline' },
                { number: 4, title: 'FI: Filed offline, again' },
            ],
        };
        expect(issuesTitled(list, ' FI: Filed offline ')).toEqual([3, 9]);
        expect(issuesTitled(list, 'Nothing')).toEqual([]);
    });

    it('counts a comment on an issue, so the chaos flows catch a second copy', () => {
        expect(
            parseActAsArgs(['--credentials', 'c', 'comments', '--issue', 'A: Export', '--text', 'XB2: once']),
        ).toMatchObject({ command: 'comments', issue: 'A: Export', text: 'XB2: once' });
        expect(() => parseActAsArgs(['--credentials', 'c', 'comments', '--text', 'XB2: once'])).toThrow(
            /needs --issue/,
        );
        expect(() => parseActAsArgs(['--credentials', 'c', 'comments', '--issue', 'A: Export'])).toThrow(
            /needs --text/,
        );
        expect(() => parseActAsArgs(['--credentials', 'c', 'issues', '--text', 'x', '--issue', 'y'])).toThrow(
            /--issue goes with comments only/,
        );
        expect(() => parseActAsArgs(['--credentials', 'c', 'comments', '--issue', ' ', '--text', 'x'])).toThrow(
            /--issue is empty/,
        );
        const detail = {
            comments: [
                { id: 'c3', body: 'XB2: once', createdAt: 3 },
                { id: 'c1', body: ' XB2: once ', createdAt: 1 },
                { id: 'c2', body: 'XB2: once, and more', createdAt: 2 },
            ],
        };
        // Two copies of the same comment: the command fails on anything but one.
        expect(commentsSaying(detail, 'XB2: once')).toEqual(['c1', 'c3']);
        expect(commentsSaying(detail, 'XB2: once, and more')).toEqual(['c2']);
        expect(commentsSaying(detail, 'nothing')).toEqual([]);
    });

    it("finds Ada's newest room message and the mentions the server checked (room-send.yaml)", () => {
        const transcript = JSON.parse(
            readFileSync(join(import.meta.dirname, 'fixtures', 'room-transcript-ben.json'), 'utf8'),
        );
        expect(adasMessage(transcript)).toEqual({
            messageId: '0b9ed8f6-2abc-4ce0-a60f-e57fcc524c1a',
            mentioned: [],
            mentionsYou: false,
        });
        expect(adasMessage(transcript, 'smoke context 1')?.messageId).toBe('5d655dbe-cb89-4ab9-be0b-5e83699da2fc');
        expect(adasMessage(transcript, 'not there')).toBeNull();
        const mentioned = {
            messages: [
                ...transcript.messages,
                {
                    id: 'm-app',
                    role: 'user',
                    content: '@Ben from the app',
                    author: { name: 'Ada', you: false },
                    mentions: [{ name: 'Ben', you: true }],
                },
            ],
        };
        expect(adasMessage(mentioned, 'from the app')).toEqual({
            messageId: 'm-app',
            mentioned: ['Ben'],
            mentionsYou: true,
        });
    });
});

describe('run.mjs', () => {
    it('reads its arguments', () => {
        expect(parseRunArgs([])).toMatchObject({
            scheme: 'socio-dev',
            platform: 'android',
            appId: VARIANT_APPS.development.id,
            devClient: '',
            flows: [join(FLOWS, 'launch.yaml')],
        });
        const metro = parseRunArgs(['--metro', '8104', '--device', 'emulator-5554']);
        expect(metro.devClient).toBe(devClientUrl('socio-dev', 8104));
        expect(metro.devClient).toBe(
            'socio-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8104&disableOnboarding=1',
        );
        expect(parseRunArgs(['--platform', 'ios', '--variant', 'preview'], { ANDROID_SERIAL: 'x' })).toMatchObject({
            platform: 'ios',
            appId: 'com.ingenioventures.socio.preview',
            device: undefined,
        });
        expect(parseRunArgs([], { ANDROID_SERIAL: 'emulator-5554' }).device).toBe('emulator-5554');
    });

    it("hands flows the control ports, the defaults or a second set's", () => {
        expect(parseRunArgs([])).toMatchObject({ proxyControl: 4459, serversControl: 4549 });
        expect(parseRunArgs(['--proxy-control', '4469', '--servers-control', '4569'])).toMatchObject({
            proxyControl: 4469,
            serversControl: 4569,
        });
        expect(() => parseRunArgs(['--proxy-control', '80'])).toThrow(/--proxy-control/);
        expect(() => parseRunArgs(['--servers-control', 'x'])).toThrow(/--servers-control/);
        for (const [script, name] of [
            ['proxy.js', 'PROXY_CONTROL'],
            ['servers.js', 'SERVERS_CONTROL'],
        ]) {
            const source = readFileSync(join(FLOWS, 'common', script), 'utf8');
            expect(source).toContain(`'http://localhost:' + ${name} + '/`);
            expect(source).not.toMatch(/localhost:\d/);
        }
    });

    it('refuses arguments it cannot use', () => {
        expect(() => parseRunArgs(['--platform', 'web'])).toThrow(/--platform/);
        expect(() => parseRunArgs(['--variant', 'staging'])).toThrow(/--variant/);
        expect(() => parseRunArgs(['--metro', '80'])).toThrow(/--metro/);
        expect(() => parseRunArgs(['--variant', 'preview', '--metro', '8104'])).toThrow(/development/);
    });

    it('hands a flow the credentials file by workspace letter', () => {
        const servers = seedPlan({ ports: [4351, 4352], modelPort: 4550, dir: '/tmp/x' }).map(
            ({ letter, origin, workspaceName, chat }) => ({ letter, origin, workspaceName, chat }),
        );
        expect(credentialEnv({ password: 'pw', servers })).toEqual({
            PASSWORD: 'pw',
            ORIGIN_A: 'http://localhost:4351',
            HOST_A: 'localhost:4351',
            WORKSPACE_A: 'Workspace A',
            CHAT_A: 'A: kickoff',
            ORIGIN_B: 'http://localhost:4352',
            HOST_B: 'localhost:4352',
            WORKSPACE_B: 'Workspace B',
            CHAT_B: 'B: kickoff',
        });
        // Each workspace's Space, page and subpage, by letter, from a file that has them.
        const [a] = seedPlan({ ports: [4351], modelPort: 4550, dir: '/tmp/x' });
        expect(credentialEnv({ password: 'pw', servers: [a!] })).toMatchObject({
            SPACE_A: 'A only',
            PAGE_A: 'A: handbook',
            SUBPAGE_A: 'A: first week',
        });
        expect(parseRunArgs(['--credentials', 'c.json', '--no-workspace-left'])).toMatchObject({
            credentials: join(process.cwd(), 'c.json'),
            noWorkspaceLeft: true,
        });
        expect(parseRunArgs([])).toMatchObject({ credentials: undefined, noWorkspaceLeft: false, serversDown: false });
        expect(parseRunArgs(['--credentials', 'c.json', '--servers-down']).serversDown).toBe(true);
        expect(() => parseRunArgs(['--servers-down'])).toThrow(/--credentials/);
    });

    it('finds the workspace folders a container listing still holds', () => {
        const id = 'ab'.repeat(32);
        const listing = [
            './files/socio/registry.db',
            `./files/socio/${id}/cache.db`,
            `./files/socio/${id}/images/test-1.bin`,
            './files/socio/diagnostics',
        ].join('\n');
        expect(workspaceFolders(listing)).toEqual([`socio/${id}`]);
        expect(workspaceFolders('./files/socio/registry.db\n./files/socio/registry.db-wal')).toEqual([]);
    });

    it('passes --no-workspace-left only for a listing that worked and reached the app files', () => {
        const clean = '.\n./files/socio\n./files/socio/registry.db\n./files/socio/registry.db-wal';
        expect(checkNoWorkspaceLeft(clean, [0])).toEqual([]);
        expect(checkNoWorkspaceLeft('/x/Documents/socio/registry.db', [0, 0])).toEqual([]);
        // run-as's error alone: no folder matches, but nothing was listed.
        const error = 'run-as: package not debuggable: com.ingenioventures.socio.dev';
        expect(checkNoWorkspaceLeft(error, [1])).toHaveLength(2);
        expect(checkNoWorkspaceLeft('', [0])).toEqual([expect.stringMatching(/registry\.db/)]);
        expect(checkNoWorkspaceLeft(clean, [0, null])).toEqual([expect.stringMatching(/failed/)]);
        expect(checkNoWorkspaceLeft(clean, [])).toEqual([expect.stringMatching(/failed/)]);
        expect(checkNoWorkspaceLeft(`${clean}\n./files/socio/${'ab'.repeat(32)}/cache.db`, [0])).toEqual([
            expect.stringMatching(/left/),
        ]);
    });

    it("fails --no-workspace-left on a WebView's stored data, not on Chromium's empty bookkeeping", () => {
        // What Android's WebView writes with nothing kept, as the editor leaves it (incognito, storage off).
        const bookkeeping = [
            '.',
            './files/socio/registry.db',
            './app_webview/variations_seed',
            './app_webview/Default/Cookies',
            './app_webview/Default/Cookies-journal',
            './app_webview/Default/Local Storage/leveldb/000003.log',
            './app_webview/Default/Session Storage/000003.log',
            './app_webview/Default/Preferences',
            './app_webview/Default/databases/Databases.db',
        ].join('\n');
        expect(webViewStorage(bookkeeping)).toEqual([]);
        expect(checkNoWorkspaceLeft(bookkeeping, [0])).toEqual([]);
        const kept = [
            './app_webview/Default/IndexedDB/file__0.indexeddb.leveldb/000003.log',
            './app_webview/Default/Local Storage/leveldb/000005.ldb',
            `./app_webview/Default/Cache/Cache_Data/${'a1'.repeat(8)}_0`,
            './app_webview/Default/databases/file__0/1',
            '/c/Library/WebKit/com.ingenioventures.socio/WebsiteData/LocalStorage/file__0.localstorage',
            '/c/Library/Caches/com.ingenioventures.socio/WebKit/WebsiteData/IndexedDB/v1/x.sqlite3',
            '/c/Library/Cookies/Cookies.binarycookies',
        ];
        expect(webViewStorage(`${bookkeeping}\n${kept.join('\n')}`)).toEqual(kept.slice(0, 6));
        expect(checkNoWorkspaceLeft(`${bookkeeping}\n${kept[0]}`, [0])).toEqual([
            expect.stringMatching(/a WebView kept data/),
        ]);
    });

    it('fails --no-workspace-left on an iOS app-switcher snapshot left (CB-356)', () => {
        const app = '/c/Data/Application/AD441FCB-D141-44DD-AD55-A9C80AD95A90';
        // What the iOS 27 simulator holds after a sign-out: the folders, no file.
        const clean = [
            app,
            `${app}/Documents/socio/registry.db`,
            `${app}/Library/SplashBoard`,
            `${app}/Library/SplashBoard/Snapshots`,
            `${app}/Library/Caches/Snapshots`,
        ].join('\n');
        expect(appSnapshots(clean)).toEqual([]);
        expect(checkNoWorkspaceLeft(clean, [0, 0])).toEqual([]);
        const left = [
            `${app}/Library/SplashBoard/Snapshots/sceneID:com.ingenioventures.socio.dev-default/A03FB020-7D34-4BA9-8C95-620C4D8CA525@3x.ktx`,
            `${app}/Library/SplashBoard/Snapshots/com.ingenioventures.socio.dev - {DEFAULT GROUP}/234FDDEA-053A-4103-B788-08F014084875@3x.ktx`,
            `${app}/Library/Caches/Snapshots/com.ingenioventures.socio.dev/main/UIApplicationAutomaticSnapshotDefault-Portrait@3x.png`,
        ];
        expect(appSnapshots(`${clean}\n${left.join('\n')}`)).toEqual(left);
        expect(checkNoWorkspaceLeft(`${clean}\n${left[0]}`, [0, 0])).toEqual([
            expect.stringMatching(/the app switcher's snapshots are left/),
        ]);
    });

    it("fails --no-workspace-left on an answer left in the system's HTTP cache (CB-356)", () => {
        const clean = '.\n./files/socio/registry.db\n./cache/http-cache\n./cache/http-cache/journal';
        expect(httpCacheEntries(clean)).toEqual([]);
        const entry = `./cache/http-cache/${'0f'.repeat(16)}`;
        const android = `${clean}\n${entry}.0\n${entry}.1`;
        expect(httpCacheEntries(android)).toEqual([
            `cache/http-cache/${'0f'.repeat(16)}.0`,
            `cache/http-cache/${'0f'.repeat(16)}.1`,
        ]);
        expect(checkNoWorkspaceLeft(android, [0])).toEqual([expect.stringMatching(/HTTP cache holds 2 entries/)]);

        const keys = [
            'http://localhost:4351/api/state',
            'http://localhost:4352/api/workspace',
            'http://localhost:8105/index.bundle?platform=ios',
            'not a url',
        ];
        expect(workspaceCacheUrls(keys, ['http://localhost:4351', 'http://localhost:4353'])).toEqual([
            'http://localhost:4351/api/state',
        ]);
        expect(workspaceCacheUrls(keys, [])).toEqual([
            'http://localhost:4351/api/state',
            'http://localhost:4352/api/workspace',
        ]);
        const ios = '/x/Documents/socio/registry.db';
        expect(checkNoWorkspaceLeft(ios, [0, 0, 0], [])).toEqual([]);
        expect(checkNoWorkspaceLeft(ios, [0, 0, 0], ['http://localhost:4351/api/state'])).toEqual([
            expect.stringMatching(/Cache\.db holds a workspace's answers: http:\/\/localhost:4351\/api\/state/),
        ]);
    });

    it('runs chat-tour.yaml only against servers without rooms (a room has no Archive)', () => {
        const tour = join(FLOWS, 'chat-tour.yaml');
        const withRoom = { rooms: true, servers: [{ room: { id: 'r-1' } }] };
        const without = { rooms: false, servers: [{ room: null }] };
        expect(roomsRefusal([join(FLOWS, 'chat-open.yaml'), tour], withRoom)).toBe(
            "chat-tour.yaml archives every chat, and the app can't archive a room: start servers.mjs with --no-rooms.",
        );
        // An older credentials file: no flag, but a room listed.
        expect(roomsRefusal([tour], { servers: [{ room: { id: 'r-1' } }] })).not.toBeNull();
        expect(roomsRefusal([tour], without)).toBeNull();
        expect(roomsRefusal([join(FLOWS, 'chat-open.yaml')], withRoom)).toBeNull();
        expect(roomsRefusal([tour], undefined)).toBeNull();
    });

    it("finds an origin's port still carried by adb reverse", () => {
        const origins = ['http://localhost:4351', 'http://localhost:4352', 'http://localhost:4353'];
        const list = 'emulator-5554 tcp:8104 tcp:8104\nemulator-5554 tcp:4352 tcp:4352\n';
        expect(reversedOrigins(list, origins)).toEqual(['http://localhost:4352']);
        expect(reversedOrigins('emulator-5554 tcp:8104 tcp:8104\n', origins)).toEqual([]);
        expect(reversedOrigins('', origins)).toEqual([]);
        // The host side alone doesn't count: the device reaches the port it lists first.
        expect(reversedOrigins('emulator-5554 tcp:9000 tcp:4351', origins)).toEqual([]);
    });

    it('has every launch, store, sign-in and switch flow', () => {
        for (const flow of [
            'launch',
            'store-encrypted',
            'sign-in',
            'switch-three',
            'switch-three-offline',
            'sign-out',
        ]) {
            expect(existsSync(join(FLOWS, `${flow}.yaml`)), flow).toBe(true);
        }
    });
});

describe('the issue chaos flows', () => {
    it('after Clear cache, checks exactly five writes wait, then reopens cold and checks again', () => {
        const flow = readFileSync(join(FLOWS, 'chaos-issues-queue.yaml'), 'utf8');
        const afterClear = flow.slice(flow.lastIndexOf('id: settings-clear-cache'));
        const steps = [...afterClear.matchAll(/^- runFlow: common\/open\.yaml$|^\s+OUTBOX: '(.*)'$/gm)].map(
            (match) => match[1] ?? 'reopen',
        );
        expect(steps.map((step) => (step === 'reopen' ? step : 'check'))).toEqual(['check', 'reopen', 'check']);
        const line = (queued: number, unknown: number) =>
            outboxTallyLine({ queued, inflight: 0, unknown, held: 0, sent: 0, unsent: 0 });
        for (const check of steps.filter((step) => step !== 'reopen')) {
            // Maestro matches an element's whole text.
            const exact = new RegExp(`^(?:${check})$`);
            for (let queued = 0; queued <= 6; queued += 1) {
                for (let unknown = 0; unknown <= 6; unknown += 1) {
                    expect(exact.test(line(queued, unknown)), `queued ${queued}, unknown ${unknown}`).toBe(
                        queued + unknown === 5,
                    );
                }
            }
            expect(
                exact.test(outboxTallyLine({ queued: 4, inflight: 0, unknown: 0, held: 1, sent: 0, unsent: 0 })),
            ).toBe(false);
            expect(
                exact.test(outboxTallyLine({ queued: 5, inflight: 0, unknown: 0, held: 0, sent: 0, unsent: 1 })),
            ).toBe(false);
        }
    });
});

describe('chaos-proxy.mjs', () => {
    it('reads its arguments and takes the device or leaves adb alone', async () => {
        const { parseProxyArgs, DEFAULT_PROXY } = await import('../e2e/chaos-proxy.mjs');
        expect(parseProxyArgs([], { ANDROID_SERIAL: 'emulator-5554' })).toEqual({
            ...DEFAULT_PROXY,
            device: 'emulator-5554',
            adb: true,
        });
        expect(parseProxyArgs(['--no-adb', '--port', '4352', '--listen', '4452'])).toMatchObject({
            port: 4352,
            listen: 4452,
            adb: false,
        });
        expect(parseProxyArgs(['--help'])).toHaveProperty('help');
        expect(() => parseProxyArgs([])).toThrow(/--no-adb/);
        expect(() => parseProxyArgs(['--no-adb', '--listen', '4351'])).toThrow(/different/);
        expect(() => parseProxyArgs(['--no-adb', '--port', '80'])).toThrow(/1024/);
    });

    it('spots a chat follow stream by its request line only', async () => {
        const { isStreamRequest } = await import('../e2e/chaos-proxy.mjs');
        expect(isStreamRequest('GET /api/conversations/c-1/stream?after=3 HTTP/1.1\r\n')).toBe(true);
        expect(isStreamRequest('GET /api/conversations/c-1/stream HTTP/1.1\r\n')).toBe(true);
        expect(isStreamRequest('GET /api/conversations/c-1/history?after=0 HTTP/1.1\r\n')).toBe(false);
        expect(isStreamRequest('POST /api/copilotkit/agent/d/run HTTP/1.1\r\n')).toBe(false);
    });
});

describe('two devices, offline typing and the page chaos', () => {
    it('counts requests by method and path, ids as :id, with the query dropped', async () => {
        const { requestKey, requestLines } = await import('../e2e/chaos-proxy.mjs');
        expect(requestKey('PATCH', '/api/spaces/s-1/pages/p-2?x=1')).toBe('PATCH /api/spaces/:id/pages/:id');
        expect(requestKey('GET', '/api/spaces/s-1/pages')).toBe('GET /api/spaces/:id/pages');
        expect(requestKey('GET', '/api/spaces/search?q=x')).toBe('GET /api/spaces/search');
        expect(requestKey('GET', '/api/pages/p-2/location')).toBe('GET /api/pages/:id/location');
        expect(requestKey('GET', '/api/workspace')).toBe('GET /api/workspace');
        // Two requests on one kept-alive connection in one chunk: after a CRLF, and right after a JSON body.
        const chunk =
            'PATCH /api/spaces/s/pages/p HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"content":"GET /x HTTP/1.1"}' +
            'GET /api/spaces/s/pages/p HTTP/1.1\r\nHost: localhost\r\n\r\n';
        expect(requestLines(chunk)).toEqual(['PATCH /api/spaces/:id/pages/:id', 'GET /api/spaces/:id/pages/:id']);
        // A chunk that is only a body, or a request line cut short, counts nothing.
        expect(requestLines('{"content":"Line one."}')).toEqual([]);
        expect(requestLines('PATCH /api/spaces/s/pa')).toEqual([]);
    });

    it('hands flows more variables with run.mjs --env, never the ones it sets itself', () => {
        expect(parseRunArgs(['--env', 'LINE=Line two\\.', '--env', 'TEXT=Both phones']).env).toEqual({
            LINE: 'Line two\\.',
            TEXT: 'Both phones',
        });
        expect(parseRunArgs([]).env).toEqual({});
        expect(() => parseRunArgs(['--env', 'line=x'])).toThrow(/NAME=value/);
        expect(() => parseRunArgs(['--env', 'NOVALUE'])).toThrow(/NAME=value/);
        for (const name of RESERVED_ENV) {
            expect(() => parseRunArgs(['--env', `${name}=x`])).toThrow(/run.mjs sets it/);
        }
    });

    it("reads, writes, deletes and moves a page as Ada on the web, by the page's title", () => {
        expect(parseActAsArgs(['--credentials', 'c', 'web-page', '--page', 'A: first week'])).toMatchObject({
            command: 'web-page',
            page: 'A: first week',
        });
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-page', '--page', 'p', '--expect', 'x', '--expect', 'y']).expect,
        ).toEqual(['x', 'y']);
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-page-write', '--page', 'p', '--text', '# T\n\nLine one.']),
        ).toMatchObject({ command: 'web-page-write', text: '# T\n\nLine one.' });
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-page-move', '--page', 'p', '--to', 'Elsewhere']),
        ).toMatchObject({ command: 'web-page-move', to: 'Elsewhere' });
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-page'])).toThrow(/needs --page/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-page-write', '--page', 'p'])).toThrow(/needs --text/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-page-move', '--page', 'p'])).toThrow(/needs --to/);
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-delete', '--text', 'x', '--page', 'p'])).toThrow(
            /--page goes/,
        );
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-page-delete', '--page', 'p', '--expect', 'x'])).toThrow(
            /--expect goes/,
        );
    });

    it('finds each line typed on a phone in the page exactly once', () => {
        const page = '# T\n\nLine one.\n\nFrom Android\n\nLine two. From the iPhone';
        expect(occurrences(page, 'From Android')).toBe(1);
        expect(occurrences(page, 'Line')).toBe(2);
        expect(occurrences(page, '')).toBe(0);
        expect(expectProblems(page, ['From Android', 'From the iPhone'])).toEqual([]);
        expect(expectProblems(page + '\n\nFrom Android', ['From Android', 'Lost'])).toEqual([
            '"From Android" is in the page 2 times, not once',
            '"Lost" is in the page 0 times, not once',
        ]);
    });

    it('has the flows, each typing only before it hides the keyboard', () => {
        for (const flow of [
            'page-two-offline',
            'page-two-settle',
            'page-offline-typing',
            'page-kill-save',
            'page-clear-cache',
            'page-gone',
            'pages-tour',
            'pages-large-text',
            'page-webview-killed',
            'page-hostile',
            'page-paste-webview',
        ]) {
            const path = join(FLOWS, `${flow}.yaml`);
            expect(existsSync(path), flow).toBe(true);
            const steps = readFileSync(path, 'utf8').split('\n');
            const hide = steps.findIndex((line) => line.trim() === '- hideKeyboard');
            if (hide >= 0) {
                expect(
                    steps.slice(0, hide).some((line) => /^\s*- inputText:/.test(line)),
                    `${flow} hides the keyboard before typing`,
                ).toBe(true);
            }
        }
    });

    it('counts saves and page reads through the proxy, and holds answers for the kill mid-save', () => {
        const requests = readFileSync(join(FLOWS, 'common', 'requests.js'), 'utf8');
        expect(requests).toContain("'http://localhost:' + PROXY_CONTROL + '/requests'");
        expect(requests).toContain("counts['PATCH /api/spaces/:id/pages/:id']");
        expect(requests).toContain("counts['GET /api/spaces/:id/pages/:id']");
        const typing = readFileSync(join(FLOWS, 'page-offline-typing.yaml'), 'utf8');
        expect(typing).toMatch(/ACTION: reset[\s\S]*ACTION: up[\s\S]*MAX_SAVES: 2\s+MAX_READS: 0/);
        expect(typing).toMatch(/repeat:\s+times: 24[\s\S]*MS: 5000/);
        const kill = readFileSync(join(FLOWS, 'page-kill-save.yaml'), 'utf8');
        expect(kill).toMatch(/ACTION: stall[\s\S]*- stopApp[\s\S]*ACTION: up/);
    });
});

describe('getting in: servers.mjs --codes, web-side.mjs and act-as.mjs web-invite', () => {
    it('reads --codes and gives each workspace SMTP and Telegram only with it', () => {
        expect(parseServerArgs([]).codes).toBe(false);
        expect(parseServerArgs(['--codes']).codes).toBe(true);
        const plain = serverEnv({ port: 4351, home: '/tmp/h', modelPort: 4550 });
        expect(plain.SMTP_URL).toBeUndefined();
        expect(plain.TELEGRAM_BOT_TOKEN).toBe('');
        expect(plain.TELEGRAM_API_ROOT).toBeUndefined();
        const channels = serverEnv({
            port: 4351,
            home: '/tmp/h',
            modelPort: 4550,
            channels: { smtpPort: 2525, telegramRoot: 'http://127.0.0.1:9999' },
        });
        expect(channels).toMatchObject({
            SMTP_URL: 'smtp://127.0.0.1:2525',
            SMTP_FROM: 'socio@example.test',
            TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
            TELEGRAM_POLLING: 'true',
            TELEGRAM_API_ROOT: 'http://127.0.0.1:9999',
        });
        // The server refuses a token that doesn't look like the Bot API's.
        expect(FAKE_BOT_TOKEN).toMatch(/^\d+:[A-Za-z0-9_-]{30,}$/);
        const plan = seedPlan({
            ports: [4351, 4352],
            modelPort: 4550,
            dir: '/tmp/x',
            channels: [
                { smtpPort: 1, telegramRoot: 'http://127.0.0.1:2' },
                { smtpPort: 3, telegramRoot: 'http://127.0.0.1:4' },
            ],
        });
        expect(plan.map((server) => server.env.SMTP_URL)).toEqual(['smtp://127.0.0.1:1', 'smtp://127.0.0.1:3']);
    });

    it('reads a quoted-printable email back, and the code in a message', () => {
        expect(
            decodeQuotedPrintable('Sign in: https://link.example.test/dev/c#code=3DAB=\r\nCD-EFGH&ws=3Dx\r\nCaf=C3=A9'),
        ).toBe('Sign in: https://link.example.test/dev/c#code=ABCD-EFGH&ws=x\r\nCafé');
        const mail = readMail(
            'To: ada@example.test\r\nSubject: Your code\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nYour code: =\r\nABCD-EFGH\r\n',
        );
        expect(mail).toEqual({ to: 'ada@example.test', subject: 'Your code', text: 'Your code: ABCD-EFGH' });
        expect(
            readMail(
                `To: a@example.test\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('Hi').toString('base64')}`,
            ).text,
        ).toBe('Hi');
        expect(codeIn('Open https://link-staging.socio.sh/dev/c#code=WXYZ-2345&ws=localhost%3A4381')).toBe('WXYZ-2345');
        expect(codeIn('Your sign-in code is QRST-6789. It works for 15 minutes.')).toBe('QRST-6789');
        expect(codeIn('Linked. You can message me here.')).toBeNull();
    });

    it('keeps what the SMTP sink receives, and lists the codes sent', async () => {
        const sink = await smtpSink();
        try {
            const { connect: dial } = await import('node:net');
            const socket = dial(sink.port, '127.0.0.1');
            socket.setEncoding('utf8');
            const said: string[] = [];
            const next = () =>
                new Promise<string>((done) => socket.once('data', (chunk: string) => (said.push(chunk), done(chunk))));
            await next();
            for (const line of ['EHLO x', 'MAIL FROM:<socio@example.test>', 'RCPT TO:<ada@example.test>', 'DATA']) {
                socket.write(`${line}\r\n`);
                await next();
            }
            socket.write(
                'To: ada@example.test\r\nSubject: Code\r\n\r\n..dot\r\nhttps://l.example.test/dev/c#code=ABCD-EFGH&ws=h\r\n.\r\n',
            );
            await next();
            socket.end('QUIT\r\n');
            expect(said.at(-1)).toMatch(/^250/);
            expect(sink.mail).toHaveLength(1);
            expect(sink.mail[0]).toMatchObject({
                to: 'ada@example.test',
                text: '.dot\r\nhttps://l.example.test/dev/c#code=ABCD-EFGH&ws=h',
            });
            const telegram = {
                calls: [
                    { method: 'getMe', body: {} },
                    { method: 'sendMessage', body: { chat_id: 900001, text: 'Your code: JKLM-NPQR' } },
                ],
            };
            expect(outbox(sink, telegram)).toEqual({
                mail: [expect.objectContaining({ code: 'ABCD-EFGH' })],
                telegram: [{ chat: 900001, text: 'Your code: JKLM-NPQR', code: 'JKLM-NPQR' }],
            });
        } finally {
            await sink.close();
        }
    });

    it('makes PKCE pairs the server takes', async () => {
        const { createHash } = await import('node:crypto');
        const { verifier, challenge } = pkce();
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(challenge).toHaveLength(43);
        expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    });

    it('reads web-invite and builds the development build’s invite link from the web’s', async () => {
        expect(COMMANDS).toContain('web-invite');
        expect(parseActAsArgs(['--credentials', 'c', 'web-invite'])).toMatchObject({
            command: 'web-invite',
            linkHost: DEV_LINK_HOST,
        });
        expect(
            parseActAsArgs(['--credentials', 'c', 'web-invite', '--link-host', 'abc.trycloudflare.com']).linkHost,
        ).toBe('abc.trycloudflare.com');
        expect(parseActAsArgs(['--credentials', 'c', 'web-sign-out']).linkHost).toBeUndefined();
        expect(() => parseActAsArgs(['--credentials', 'c', 'web-sign-out', '--link-host', 'x'])).toThrow(
            /web-invite only/,
        );
        expect(DEV_LINK_HOST).toBe('link-staging.socio.sh');
        await expect(
            devInviteLink(
                'http://localhost:4381/reset-password?token=tok_en-1',
                'http://localhost:4381',
                DEV_LINK_HOST,
            ),
        ).resolves.toBe('https://link-staging.socio.sh/dev/i/localhost:4381#t=tok_en-1');
        await expect(
            devInviteLink('https://link.socio.sh/dev/i/localhost:4381#t=x', 'http://localhost:4381', DEV_LINK_HOST),
        ).rejects.toThrow(/no token/);
    });

    it('has every getting-in flow', () => {
        for (const flow of [
            'getting-in-invite',
            'getting-in-workspace-link',
            'getting-in-sheet',
            'getting-in-email',
            'getting-in-telegram',
            'add-device',
            'add-device-race',
            'add-device-wrong-digits',
            'device-erased',
        ]) {
            expect(existsSync(join(FLOWS, `${flow}.yaml`)), flow).toBe(true);
        }
    });
});
