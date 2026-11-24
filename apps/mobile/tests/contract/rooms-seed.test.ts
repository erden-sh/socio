import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { actAs } from '../../e2e/act-as.mjs';
import { a2Seeds, seedRoom, signedIn } from '../../e2e/servers.mjs';

// The room seed's contract test: servers.mjs's room seed is idempotent,
// and act-as.mjs works as Ben against the same server. It needs `pnpm run
// build` and `node apps/mobile/e2e/servers.mjs`, and runs only when
// SOCIO_CONTRACT_CREDENTIALS names the credentials file servers.mjs wrote; CI
// skips it. Each run signs in six times (sign-in allows 30 a minute).

const CREDENTIALS = process.env.SOCIO_CONTRACT_CREDENTIALS;

interface Credentials {
    password: string;
    accounts: { email: string; name: string }[];
    servers: {
        letter: string;
        origin: string;
        room: { id: string; socios: Record<string, string>; people: Record<string, string> };
    }[];
}

/** A presence report every 3 s as Ada on Home: a notice then comes as an in-app one, kept in /api/state. */
async function presentAda(credentials: Credentials) {
    const server = credentials.servers[0]!;
    const base = `http://127.0.0.1:${new URL(server.origin).port}`;
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { Origin: server.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: credentials.accounts[0]!.email, password: credentials.password }),
    });
    const cookie = signIn.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0])
        .join('; ');
    const state = async () =>
        (await (
            await fetch(`${base}/api/state`, {
                headers: { Origin: server.origin, Cookie: cookie, 'X-CB-Presence': 'f2contract0123456789ab /' },
            })
        ).json()) as { notices: { title: string; body: string; link: string }[] };
    await state();
    const timer = setInterval(() => void state(), 3_000);
    return { state, stop: () => clearInterval(timer) };
}

describe.skipIf(!CREDENTIALS)('the room seed and act-as against a local server', () => {
    it('seeds the room once: a second run finds it and adds nothing', { timeout: 120_000 }, async () => {
        const credentials = JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;
        const server = credentials.servers[0]!;
        const target = { letter: server.letter, port: Number(new URL(server.origin).port), origin: server.origin };
        const ada = await signedIn(target, credentials.accounts[0]!.email, credentials.password);
        const ben = await signedIn(target, credentials.accounts[1]!.email, credentials.password);
        const history = async () =>
            ((await (await ada('GET', `/api/conversations/${server.room.id}/history`)).json()) as { runs: unknown[] })
                .runs.length;
        const before = await history();
        const again = await seedRoom({ ...target, ...a2Seeds(server.letter) }, ada, ben);
        expect(again).toEqual(expect.objectContaining({ id: server.room.id, socios: server.room.socios }));
        expect(await history()).toBe(before);
    });

    it('mentions Ada as Ben, then invites her to his room and takes it back', { timeout: 120_000 }, async () => {
        const credentials = JSON.parse(readFileSync(CREDENTIALS!, 'utf8')) as Credentials;
        const ada = await presentAda(credentials);
        try {
            const sent = await actAs(
                { command: 'message', letter: 'A', wait: true, text: 'F2 contract check' },
                credentials,
            );
            expect(sent).toMatchObject({ command: 'message', roomId: credentials.servers[0]!.room.id, waited: true });
            await new Promise((done) => setTimeout(done, 1_000));
            expect((await ada.state()).notices).toContainEqual(
                expect.objectContaining({
                    title: 'A: launch room: Ben mentioned you',
                    body: '@Ada F2 contract check',
                    link: `/chats/${credentials.servers[0]!.room.id}`,
                }),
            );
            // A cancel first, so an invite left by an earlier run doesn't count.
            await actAs({ command: 'cancel', letter: 'A', wait: true }, credentials);
            const invited = await actAs({ command: 'invite', letter: 'A', wait: true }, credentials);
            expect(invited).toMatchObject({ command: 'invite', adaWas: 'none' });
            const cancelled = await actAs({ command: 'cancel', letter: 'A', wait: true }, credentials);
            expect(cancelled).toMatchObject({ command: 'cancel', roomId: invited.roomId, adaWas: 'invited' });
        } finally {
            ada.stop();
        }
    });
});
