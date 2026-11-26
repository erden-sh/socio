import { describe, expect, it, vi } from 'vitest';

import { appLink, type AppVariant } from '@socio/shared/device-sign-in';

import { type AddDeps, addByAddress, addByLink } from '../src/data/first-screen';
import type { StagedLogo } from '../src/data/logo';
import { createExternalLinks, type LinkAction, type LinkNavigator } from '../src/navigation/links';
import { createWorkspaceLinkHold } from '../src/navigation/workspace-link';
import {
    ADDRESS_COPY,
    FIRST_SCREEN_COPY,
    firstScreenView,
    readWorkspaceLink,
    type WorkspaceLink,
} from '../src/net/first-screen';
import type { ProbeResult } from '../src/net/probe';
import { probeCopy } from '../src/net/probe-copy';

// Add workspace's first screen: its words, the Get the app link (`w`) read back for this
// build only, held until the gate shows the screen (a cold start included), then the host checked
// as a typed address and probed, landing on Confirm with the workspace filled in.

const LINK_HOST = 'link-staging.socio.sh';
const HOST = 'brain.example.test';
const LINKS = { variant: 'development' as const, linkHost: LINK_HOST };

const workspaceLinkFor = (host = HOST, variant: AppVariant = 'development', linkHost = LINK_HOST) =>
    appLink({ kind: 'w', variant, host, fields: {} }, linkHost);

const MASCOT: StagedLogo = { kind: 'mascot' };

/** A probe that finds `name` at whatever origin it is given. */
function deps(overrides: Partial<AddDeps> = {}) {
    const probe = vi.fn(async (text: string): Promise<ProbeResult> => {
        const url = new URL(text.includes('://') ? text : `https://${text}`);
        return {
            kind: 'found',
            address: { origin: url.origin, host: url.host },
            workspace: { provider: 'betterauth', name: 'Acme', logo: null, methods: null, manifest: null },
            redirectedFrom: null,
        };
    });
    const stage = vi.fn(async () => MASCOT);
    const openKnown = vi.fn(async () => undefined);
    return { probe, stage, openKnown, testBuild: false, report: vi.fn(), ...overrides } satisfies AddDeps;
}

const ALL_WORDS = [
    ...Object.values(ADDRESS_COPY),
    FIRST_SCREEN_COPY.title,
    FIRST_SCREEN_COPY.lead,
    FIRST_SCREEN_COPY.checking,
    FIRST_SCREEN_COPY.failure,
    ...FIRST_SCREEN_COPY.ways.flatMap((way) => [way.title, way.detail]),
];

describe('the first screen’s view model and words', () => {
    it('offers the invite, the QR code, then the address, and the QR code (the scanner) and the address are buttons', () => {
        const view = firstScreenView({ adding: false, testBuild: false, link: null });
        expect(view.title).toBe('Add a workspace');
        expect(view.ways.map((way) => way.id)).toEqual(['invite', 'qr', 'address']);
        expect(view.ways.map((way) => way.title)).toEqual([
            'Open your invite link',
            'Scan the QR code from Socio on a computer',
            'Enter your workspace address',
        ]);
        expect(view.ways[0]?.detail).toBe('Your admin sent it to you. Open it on this device.');
        expect(view.ways[1]?.detail).toBe('On Socio, choose Get the app, or Add a device to sign in at once.');
        expect(view.ways.map((way) => way.pressable)).toEqual([false, true, true]);
        expect(view.ways.map((way) => way.testID)).toEqual([
            'first-screen-invite',
            'first-screen-qr',
            'first-screen-address',
        ]);
        expect(view.link).toBeNull();
        expect(view.cancel).toBe(false);
        expect(view.diagnostics).toBe(false);
    });

    it('never lists workspaces: the view holds only its words, the ways and one link’s host', () => {
        const view = firstScreenView({ adding: true, testBuild: true, link: { step: 'checking', host: HOST } });
        expect(Object.keys(view).sort()).toEqual(['cancel', 'diagnostics', 'lead', 'link', 'title', 'ways']);
        expect(view.cancel).toBe(true);
        expect(view.diagnostics).toBe(true);
    });

    it('says “device”, never “phone”, and keeps every line short enough for a phone', () => {
        for (const words of ALL_WORDS) {
            expect(words).not.toMatch(/phone/i);
            expect(words.length).toBeLessThanOrEqual(90);
        }
        expect(FIRST_SCREEN_COPY.ways[0]?.detail).toMatch(/device/);
    });

    it('shows a link’s host while it is checked, then its refusal, with the detail in test builds only', () => {
        expect(
            firstScreenView({ adding: false, testBuild: false, link: { step: 'checking', host: HOST } }).link,
        ).toEqual({ host: HOST, busy: true, line: 'Finding your workspace…', detail: null });
        const refused = { step: 'refused', host: HOST, line: 'No.', detail: 'HTTP 404' } as const;
        expect(firstScreenView({ adding: false, testBuild: false, link: refused }).link).toEqual({
            host: HOST,
            busy: false,
            line: 'No.',
            detail: null,
        });
        expect(firstScreenView({ adding: false, testBuild: true, link: refused }).link?.detail).toBe('HTTP 404');
    });
});

describe('Get the app links', () => {
    it('reads only this build’s `w` links, the host in the path', () => {
        expect(workspaceLinkFor()).toBe(`https://${LINK_HOST}/dev/w/${HOST}`);
        expect(readWorkspaceLink(workspaceLinkFor(), LINKS)).toEqual({ host: HOST });
        expect(readWorkspaceLink(workspaceLinkFor('10.0.2.2:4351'), LINKS)).toEqual({ host: '10.0.2.2:4351' });
    });

    it.each([
        ['another variant', workspaceLinkFor(HOST, 'preview')],
        ['production’s path', workspaceLinkFor(HOST, 'production')],
        ['another link host', workspaceLinkFor(HOST, 'development', 'link.socio.sh')],
        ['a look-alike link host', workspaceLinkFor(HOST, 'development', 'link-staging.socio.sh.evil.test')],
        ['another kind', appLink({ kind: 'i', variant: 'development', host: HOST, fields: { t: 'x' } }, LINK_HOST)],
        ['a fragment', `${workspaceLinkFor()}#ws=other.example.test`],
        ['a query', `${workspaceLinkFor()}?next=/x`],
        ['the host in the fragment', `https://${LINK_HOST}/dev/w#ws=${HOST}`],
        ['plain http', workspaceLinkFor().replace('https://', 'http://')],
        ['a host links can’t carry', `https://${LINK_HOST}/dev/w/Brain.Example.Test`],
    ])('refuses %s', (_, url) => {
        expect(readWorkspaceLink(url, LINKS)).toBeNull();
    });
});

describe('adding by a link or an address', () => {
    it('a link’s host is probed as a typed address and lands on Confirm with the workspace filled in', async () => {
        const d = deps();
        const outcome = await addByLink({ host: HOST }, 'production', new AbortController().signal, d);
        expect(d.probe).toHaveBeenCalledWith('https://brain.example.test', expect.any(AbortSignal));
        expect(outcome).toEqual({
            kind: 'found',
            workspace: {
                origin: 'https://brain.example.test',
                host: HOST,
                name: 'Acme',
                logo: MASCOT,
                methods: null,
                manifest: null,
            },
        });
    });

    it('a development build’s local server is the plain http it already takes', async () => {
        const d = deps();
        await addByLink({ host: '10.0.2.2:4351' }, 'development', new AbortController().signal, d);
        expect(d.probe).toHaveBeenCalledWith('http://10.0.2.2:4351', expect.any(AbortSignal));
    });

    it('a host the build refuses is refused before any request, in the probe’s words', async () => {
        const d = deps();
        const outcome = await addByLink({ host: `${HOST}:8443` }, 'production', new AbortController().signal, d);
        expect(d.probe).not.toHaveBeenCalled();
        expect(outcome).toEqual({ kind: 'problem', problem: { line: probeCopy('port'), detail: null } });
        const test = await addByLink(
            { host: `${HOST}:8443` },
            'production',
            new AbortController().signal,
            deps({ testBuild: true }),
        );
        expect(test).toMatchObject({ problem: { detail: 'port' } });
    });

    it('a workspace already on the device opens; a probe that fails is worded, never the server’s text', async () => {
        const known = deps({
            probe: vi.fn(async () => ({ kind: 'known', address: { origin: `https://${HOST}`, host: HOST } }) as const),
        });
        expect(await addByLink({ host: HOST }, 'production', new AbortController().signal, known)).toEqual({
            kind: 'opened',
        });
        expect(known.openKnown).toHaveBeenCalledWith(`https://${HOST}`);

        const failed = deps({
            testBuild: true,
            probe: vi.fn(
                async () => ({ kind: 'failed', problem: 'not-socio', origin: `https://${HOST}`, status: 404 }) as const,
            ),
        });
        expect(await addByAddress(HOST, new AbortController().signal, failed)).toEqual({
            kind: 'problem',
            problem: { line: probeCopy('not-socio'), detail: `HTTP 404 · https://${HOST}` },
        });
    });

    it('a probe that throws is a failure; one aborted says nothing', async () => {
        const boom = deps({ probe: vi.fn(async () => Promise.reject(new Error('boom'))) });
        expect(await addByAddress(HOST, new AbortController().signal, boom)).toEqual({ kind: 'failure' });
        expect(boom.report).toHaveBeenCalledOnce();
        const controller = new AbortController();
        controller.abort();
        const aborted = deps({ probe: vi.fn(async () => Promise.reject(new Error('aborted'))) });
        expect(await addByAddress(HOST, controller.signal, aborted)).toEqual({ kind: 'aborted' });
    });
});

/** A container standing in for React Navigation's, with the root stack's current routes. */
function fakeContainer(routeNames: string[], ready = true) {
    const dispatched: LinkAction[] = [];
    const container = {
        ready,
        routeNames,
        isReady: () => container.ready,
        getRootState: () => ({ key: 'root-1', routeNames: container.routeNames }),
        dispatch: (action: LinkAction) => {
            dispatched.push(action);
        },
    };
    return { container: container satisfies LinkNavigator, dispatched };
}

/** The app's wiring: the link queue, the hold reading this build's links, the gate. */
function wiring(container: ReturnType<typeof fakeContainer>['container']) {
    const links = createExternalLinks({ resolve: () => undefined, report: vi.fn() });
    const overGate = vi.fn(() => {
        // The gate shows Add workspace over the shell.
        if (!container.routeNames.includes('AddWorkspace')) {
            container.routeNames = ['AddWorkspace', 'WorkspaceAddress', 'ConfirmWorkspace'];
        }
    });
    const hold = createWorkspaceLinkHold<WorkspaceLink>({
        read: (url) => readWorkspaceLink(url, LINKS),
        open: () => links.openRoute('AddWorkspace', 'popTo'),
        overGate,
    });
    return { links, hold, overGate };
}

describe('a Get the app link reaches the first screen', () => {
    it('at a cold start: held until the root stack is ready, then the screen takes it once and lands on Confirm', async () => {
        const { container, dispatched } = fakeContainer([], false);
        const { links, hold } = wiring(container);
        // The launch URL comes before the container is attached or ready.
        expect(hold.receive(workspaceLinkFor())).toBe(true);
        expect(links.pending()).toBe('route:AddWorkspace');

        links.attach(container);
        expect(dispatched).toEqual([]);
        // The store opened with no workspace: the gate shows Add workspace.
        container.ready = true;
        container.routeNames = ['AddWorkspace', 'WorkspaceAddress', 'ConfirmWorkspace'];
        links.flush();
        // Back to the gate's root, never a second copy over Confirm (React Navigation 7's navigate pushes one).
        expect(dispatched).toEqual([{ target: 'root-1', type: 'POP_TO', payload: { name: 'AddWorkspace' } }]);

        // The screen mounts and takes the link, once.
        const link = hold.take();
        expect(link).toEqual({ host: HOST });
        expect(hold.take()).toBeNull();
        const outcome = await addByLink(link!, 'development', new AbortController().signal, deps());
        expect(outcome).toMatchObject({ kind: 'found', workspace: { host: HOST, origin: `https://${HOST}` } });
    });

    it('over the shell: the gate shows Add workspace first, then the screen opens', () => {
        const { container, dispatched } = fakeContainer(['Tabs', 'Chat']);
        const { links, hold, overGate } = wiring(container);
        links.attach(container);
        hold.receive(workspaceLinkFor());
        expect(overGate).toHaveBeenCalledOnce();
        expect(dispatched.map((action) => [action.type, action.payload])).toEqual([
            ['POP_TO', { name: 'AddWorkspace' }],
        ]);
    });

    it('the screen showing hears a new link and takes the newest', () => {
        const { container } = fakeContainer(['AddWorkspace']);
        const { links, hold } = wiring(container);
        links.attach(container);
        const heard = vi.fn(() => hold.take());
        const stop = hold.listen(heard);
        hold.receive(workspaceLinkFor('one.example.test'));
        expect(heard).toHaveLastReturnedWith({ host: 'one.example.test' });
        stop();
        hold.receive(workspaceLinkFor('two.example.test'));
        expect(heard).toHaveBeenCalledOnce();
        expect(hold.take()).toEqual({ host: 'two.example.test' });
    });

    it.each([
        ['another variant', workspaceLinkFor(HOST, 'preview')],
        ['another link host', workspaceLinkFor(HOST, 'development', 'link.socio.sh')],
    ])('refuses %s: nothing held, nothing opened, the gate untouched', (_, url) => {
        const { container, dispatched } = fakeContainer(['Tabs']);
        const { links, hold, overGate } = wiring(container);
        links.attach(container);
        expect(hold.is(url)).toBe(false);
        expect(hold.receive(url)).toBe(false);
        expect(links.pending()).toBeNull();
        expect(dispatched).toEqual([]);
        expect(overGate).not.toHaveBeenCalled();
        expect(hold.take()).toBeNull();
    });
});
