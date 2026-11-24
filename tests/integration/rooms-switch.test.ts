import { afterEach, expect, it } from 'vitest';

import { roomsSettingsFromEnv } from '@socio/foundation/rooms/settings';
import { roomsOn } from '@socio/shared/rooms/room-view';
import type { State } from '@socio/shared/types';

import { userServices } from '../../src/server/web/services.js';
import { ROOM_PEOPLE, roomsFixture } from '../fixtures/rooms.js';
import { testPageViews } from '../helpers/page-views.js';

// CB-212 follow-up (found by CB-217): the Rooms switch in force is the
// admin's (Settings → General → Rooms) over the environment's
// (`ROOMS_ENABLED`), and the server's rule, `/api/state` and the first
// page's state (server-rendered, `userServices`) must all say the same:
// with ROOMS_ENABLED=true and nothing saved, the room screen once said
// "Rooms are turned off" while the server allowed changes.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const CASES: Array<{
    env: string | undefined;
    saved: boolean | undefined;
    on: boolean;
}> = [
    { env: 'true', saved: undefined, on: true },
    { env: 'true', saved: false, on: false },
    { env: 'true', saved: true, on: true },
    { env: 'false', saved: true, on: true },
    { env: 'false', saved: undefined, on: false },
    { env: undefined, saved: undefined, on: false },
    { env: undefined, saved: true, on: true },
    { env: undefined, saved: false, on: false },
];

it.each(CASES)(
    'ROOMS_ENABLED=$env with the setting $saved: on is $on, for the server, the API and the first page alike',
    async ({ env, saved, on }) => {
        const f = await roomsFixture(cleanup);
        // As the server starts: the environment's switch, then an admin's.
        f.platform.config.rooms = roomsSettingsFromEnv({ ROOMS_ENABLED: env });
        if (saved !== undefined) {
            await f.store.updateSettings({ rooms: { enabled: saved } });
        }

        // The server's rule.
        expect(f.workspace.roomsEnabled()).toBe(on);
        const made = await f.as('ada')('/rooms', 'POST', {
            dotId: f.company.id,
            title: 'Switch',
        });
        expect(made.status).toBe(on ? 201 : 409);

        // `/api/state`, as the shell reads it.
        const api = (await (await f.as('ada')('/state')).json()) as State;
        expect(api.settings.rooms?.enabled).toBe(on);
        expect(roomsOn(api)).toBe(on);

        // The first page's state, rendered on the server.
        const ada = ROOM_PEOPLE.find((person) => person.id === 'ada')!;
        const page = userServices(
            {
                store: f.store,
                config: { mode: 'live', baseUrl: '' },
                platform: f.platform,
                views: testPageViews(f.platform),
                auth: { provider: undefined as never, secureCookies: false },
            },
            async () => ada,
        );
        const first = (await page.state()) as State;
        expect(first.settings.rooms?.enabled).toBe(on);
        expect(roomsOn(first)).toBe(on);
    },
);
