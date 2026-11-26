// @vitest-environment jsdom
// jsdom: the client registry reaches api.ts, which reads sessionStorage.
import { expect, it } from 'vitest';

import { MODULE_IDS } from '@socio/shared/modules';

import { clientModules } from '../../packages/client/src/modules/registry';
import { serverModules } from '../../src/server/modules/index.js';

/**
 * Server modules without a client module of their own: `computers` and `web`
 * give Dots tools (the computer pane is part of the chat, web reads have no
 * UI); `domains` is a card on the Platform page (the operator client
 * module); `notifications` is a Settings section and the shell's toasts
 * (CB-114); `chat-skills` is a Settings section and the composer's `/`
 * menu (CB-143); `updates` is a card on the Platform page (CB-259);
 * `rooms` is a Settings card for now (CB-207); `cycles` has no screen of
 * its own: its limits are a Settings card and its stops the chat's
 * messages (CB-211).
 */
const SERVER_ONLY: string[] = [
    'computers',
    'web',
    'github', // The GitHub App (CB-325): a card in Settings → General.
    'domains',
    'notifications',
    'chat-skills',
    'mcp-connections', // Personal connection controls live in Account settings.
    'updates', // The Updates card on the Platform page (CB-259).
    'cloud', // The cloud connection: no screen yet; Settings → Cloud connection comes later.
    'flags', // Settings → Optional features, Early access and In development (CB-169, CB-503).
    'rooms', // A Settings card until the room screens (CB-212) land.
    'cycles',
    'classify', // Its settings are an Operations card; its labels are in Reliability (CB-198).
    'actors', // Socio access (CB-232): its screens come with the consent cards.
    'gateway', // The coding gateway (CB-239): Settings → Coding comes with the coding model gateway and coding-git.
    'workspace-secrets', // Socio Secrets, phase 1: Settings → Secrets (admins); its workload routes take data tokens.
    'souls', // A socio's own Soul edit tool (CB-330); the Soul page is the chat module's.
    'chat-names', // CB-292: name suggestions are server-side; the card is in the chat view.
];

/** Client page admin-only; server routes guarded per path (see below). */
const PER_ROUTE_ADMIN = ['plugins'];

it('gives every module a shared id, unique on each side', () => {
    const known = new Set<string>(Object.values(MODULE_IDS));
    const client = clientModules.map((module) => module.id);
    const server = serverModules.map((module) => module.id);
    for (const id of [...client, ...server]) {
        expect(known, id).toContain(id);
    }
    expect(new Set(client).size).toBe(client.length);
    expect(new Set(server).size).toBe(server.length);
});

it('matches client and server modules by id and access', () => {
    const client = new Map(clientModules.map((module) => [module.id, module]));
    const missing: string[] = [];
    for (const server of serverModules) {
        const match = client.get(server.id as never);
        if (!match) {
            missing.push(server.id);
            continue;
        }
        // Admin-only on one side means admin-only on the other, but for a
        // module whose server routes guard admin paths one by one because some
        // are for everyone (the plugins page is the admin's; using an
        // installed plugin is for its audience, CB-254).
        if (PER_ROUTE_ADMIN.includes(server.id)) {
            expect(match.access, server.id).toBe('admin');
            expect(server.access, server.id).toBeUndefined();
            continue;
        }
        expect(match.access === 'admin', server.id).toBe(server.access === 'admin');
    }
    expect(missing).toEqual(SERVER_ONLY);
    // The features both sides have today.
    for (const id of ['telegram', 'learning', 'runs', 'issues', 'media']) {
        expect(client.has(id as never), id).toBe(true);
    }
});
