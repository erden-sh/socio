import { createECDH, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    broadcastArgs,
    directoryId,
    encryptFor,
    parseDebugPushArgs,
    payloadOf,
    resultOf,
    roomTarget,
} from '../e2e/debug-push.mjs';

// e2e/debug-push.mjs: the emulator's push through the debug receiver.
describe('debug-push.mjs', () => {
    it('defaults to the development build on emulator-5554, with made-up ids', () => {
        const options = parseDebugPushArgs([]);
        expect(options).toMatchObject({
            package: 'com.ingenioventures.socio.dev',
            workspace: 'debug-workspace',
            registration: 'debug-registration',
            count: 1,
            generic: false,
        });
    });

    it.each([
        [['--workspace', '../x'], /--workspace/],
        [['--registration', ''], /--registration/],
        [['--link', 'https://evil.test/'], /--link/],
        [['--count', '0'], /--count/],
    ])('refuses %j', (argv, message) => {
        expect(() => parseDebugPushArgs(argv)).toThrow(message);
    });

    it("aims at Ada's copy of a seeded room from servers.mjs's credentials", () => {
        const credentials = {
            servers: [
                {
                    letter: 'A',
                    origin: 'http://localhost:4351',
                    workspaceName: 'Workspace A',
                    room: { id: 'room 1', title: 'A: launch room', people: { Ada: 'user-ada', Ben: 'user-ben' } },
                },
            ],
        };
        // The app's directory id: hex SHA-256 of the origin, a newline and the app user id (layout.ts).
        expect(directoryId('http://localhost:4351', 'user-ada')).toMatch(/^[0-9a-f]{64}$/);
        expect(roomTarget(credentials, 'A')).toEqual({
            workspace: directoryId('http://localhost:4351', 'user-ada'),
            name: 'Workspace A',
            title: 'Ben in A: launch room',
            link: '/chats/room%201',
            tag: 'room 1',
        });
        expect(() => roomTarget(credentials, 'B')).toThrow(/no room/);
        expect(() => roomTarget({ servers: [{ ...credentials.servers[0], room: null }] }, 'A')).toThrow(/no room/);
    });

    it("builds the server's payload, numbering several", () => {
        const options = parseDebugPushArgs(['--tag', 'room-1']);
        expect(JSON.parse(payloadOf(options))).toEqual({
            kind: 'message',
            title: options.title,
            body: options.body,
            link: options.link,
            tag: 'room-1',
        });
        expect(JSON.parse(payloadOf(options, 1, 3)).body).toBe(`${options.body} (2)`);
    });

    it('encrypts one aes128gcm record to the keys the phone gave', () => {
        const ecdh = createECDH('prime256v1');
        ecdh.generateKeys();
        const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
        const body = Buffer.from(encryptFor(keys, '{"kind":"message"}'), 'base64url');
        expect(body.readUInt32BE(16)).toBe(4096);
        expect(body[20]).toBe(65);
        expect(body[21]).toBe(4);
        expect(body.length).toBe(16 + 4 + 1 + 65 + '{"kind":"message"}'.length + 1 + 16);
    });

    it('quotes each extra for the device shell', () => {
        expect(broadcastArgs('com.example', 'SEED', { name: "Ada's team" })).toEqual([
            'shell',
            'am',
            'broadcast',
            '-a',
            'expo.modules.sociopush.debug.SEED',
            '-n',
            'com.example/expo.modules.sociopush.DebugPushReceiver',
            '--es',
            'name',
            "'Ada'\\''s team'",
        ]);
    });

    it("reads the receiver's answer, or says the build has none", () => {
        expect(
            resultOf('Broadcasting: Intent { … }\nBroadcast completed: result=1, data="{"p256dh":"B","auth":"a"}"\n'),
        ).toBe('{"p256dh":"B","auth":"a"}');
        expect(() => resultOf('Broadcast completed: result=0\n')).toThrow(/debug build/);
    });
});
