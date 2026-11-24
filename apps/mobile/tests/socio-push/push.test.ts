import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wrapper against a fake SocioPush module: Node has no native side, so
// `expo`'s requireNativeModule hands back this object instead. The Swift side
// has its own XCTest (modules/socio-push/ios/Tests, the README's Tests).
const mocks = vi.hoisted(() => {
    const native = {
        storage: vi.fn(async () => ({ keychainGroup: 'TEAM.com.example.socio.shared', shared: true, inbox: true })),
        createKeys: vi.fn(async (_workspaceId: string) => ({ p256dh: 'BPub', auth: 'auth' })),
        getKeys: vi.fn(async (_workspaceId: string): Promise<{ p256dh: string; auth: string } | null> => null),
        deleteKeys: vi.fn(async (_workspaceId: string) => {}),
        setRegistration: vi.fn(async (_registrationId: string, _workspaceId: string, _name: string) => {}),
        deleteRegistration: vi.fn(async (_registrationId: string) => {}),
        getState: vi.fn(async (_workspaceId: string) => ({ locked: false, leaseLockAt: null, showText: true })),
        setLocked: vi.fn(async (_workspaceId: string, _locked: boolean) => {}),
        setLeaseLockAt: vi.fn(async (_workspaceId: string, _at: number | null) => {}),
        setShowText: vi.fn(async (_show: boolean) => {}),
        decrypt: vi.fn(async (_workspaceId: string, _body: string) => '{"title":"Hi"}'),
        listInbox: vi.fn(async (): Promise<{ id: string; json: string }[]> => []),
        deleteInbox: vi.fn(async (_ids: string[]) => {}),
    };
    const requireNativeModule = vi.fn((_name: string): typeof native => native);
    return { native, requireNativeModule };
});

vi.mock('expo', () => ({ requireNativeModule: mocks.requireNativeModule }));

const load = () => import('../../modules/socio-push');

const WORKSPACE = 'a'.repeat(64);
const UUID_1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UUID_2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.requireNativeModule.mockImplementation(() => mocks.native);
});

describe('loading the native module', () => {
    it('asks for SocioPush on first use, not at import, and only once', async () => {
        const push = await load();
        expect(mocks.requireNativeModule).not.toHaveBeenCalled();
        await push.getKeys(WORKSPACE);
        await push.pushStorage();
        expect(mocks.requireNativeModule).toHaveBeenCalledOnce();
        expect(mocks.requireNativeModule).toHaveBeenCalledWith('SocioPush');
    });

    it('fails the call that needs it when the build lacks it, not the import', async () => {
        mocks.requireNativeModule.mockImplementation(() => {
            throw new Error("Cannot find native module 'SocioPush'");
        });
        const push = await load();
        await expect(push.createKeys(WORKSPACE)).rejects.toThrow(/SocioPush/);
    });
});

describe('keys', () => {
    it('hands JavaScript only the public key and the auth secret', async () => {
        const push = await load();
        await expect(push.createKeys(WORKSPACE)).resolves.toEqual({ p256dh: 'BPub', auth: 'auth' });
        expect(mocks.native.createKeys).toHaveBeenCalledWith(WORKSPACE);
        await expect(push.getKeys(WORKSPACE)).resolves.toBeNull();
        await push.deleteKeys(WORKSPACE);
        expect(mocks.native.deleteKeys).toHaveBeenCalledWith(WORKSPACE);
    });

    it('refuses an id that could leave its keychain account or file name, before the native side sees it', async () => {
        const push = await load();
        for (const id of ['', '../x', 'a b', 'a/b', 'é', 'x'.repeat(129)]) {
            await expect(push.createKeys(id)).rejects.toThrow(TypeError);
            await expect(push.deleteKeys(id)).rejects.toThrow(TypeError);
            await expect(push.setRegistration(id, WORKSPACE, 'Acme')).rejects.toThrow(TypeError);
            await expect(push.setRegistration('reg_1', id, 'Acme')).rejects.toThrow(TypeError);
        }
        expect(mocks.native.createKeys).not.toHaveBeenCalled();
        expect(mocks.native.deleteKeys).not.toHaveBeenCalled();
        expect(mocks.native.setRegistration).not.toHaveBeenCalled();
    });
});

describe('the index and the flags', () => {
    it('indexes a registration by workspace, its name cut to a subtitle', async () => {
        const push = await load();
        await push.setRegistration('Reg-1_x', WORKSPACE, 'Acme');
        await push.setRegistration('reg2', WORKSPACE, 'n'.repeat(500));
        expect(mocks.native.setRegistration.mock.calls).toEqual([
            ['Reg-1_x', WORKSPACE, 'Acme'],
            ['reg2', WORKSPACE, 'n'.repeat(push.NAME_MAX)],
        ]);
        await push.deleteRegistration('reg2');
        expect(mocks.native.deleteRegistration).toHaveBeenCalledWith('reg2');
    });

    it('passes the locked flag, the lease deadline and show-text through', async () => {
        const push = await load();
        await push.setLocked(WORKSPACE, true);
        await push.setLeaseLockAt(WORKSPACE, 1_765_000_000_000);
        await push.setLeaseLockAt(WORKSPACE, null);
        await push.setShowText(false);
        expect(mocks.native.setLocked).toHaveBeenCalledWith(WORKSPACE, true);
        expect(mocks.native.setLeaseLockAt.mock.calls).toEqual([
            [WORKSPACE, 1_765_000_000_000],
            [WORKSPACE, null],
        ]);
        expect(mocks.native.setShowText).toHaveBeenCalledWith(false);
        await expect(push.getState(WORKSPACE)).resolves.toEqual({ locked: false, leaseLockAt: null, showText: true });
    });

    it('refuses a deadline that is no time', async () => {
        const push = await load();
        await expect(push.setLeaseLockAt(WORKSPACE, Number.NaN)).rejects.toThrow(TypeError);
        await expect(push.setLeaseLockAt(WORKSPACE, Number.POSITIVE_INFINITY)).rejects.toThrow(TypeError);
        expect(mocks.native.setLeaseLockAt).not.toHaveBeenCalled();
    });
});

describe('decrypt', () => {
    it('sends base64url to the native decryptor and returns its text', async () => {
        const push = await load();
        await expect(push.decrypt(WORKSPACE, 'DGv6ra1n-_')).resolves.toBe('{"title":"Hi"}');
        expect(mocks.native.decrypt).toHaveBeenCalledWith(WORKSPACE, 'DGv6ra1n-_');
    });

    it('refuses anything else before the native side sees it', async () => {
        const push = await load();
        for (const body of ['', 'abc=', 'a+b/', 'a b']) {
            await expect(push.decrypt(WORKSPACE, body)).rejects.toThrow(TypeError);
        }
        expect(mocks.native.decrypt).not.toHaveBeenCalled();
    });

    it('passes the native refusal on', async () => {
        mocks.native.decrypt.mockRejectedValueOnce(new Error("Couldn't decrypt the push: moreThanOneRecord"));
        const push = await load();
        await expect(push.decrypt(WORKSPACE, 'abc')).rejects.toThrow(/moreThanOneRecord/);
    });
});

describe('the inbox', () => {
    const entry = (fields: Record<string, unknown>) =>
        JSON.stringify({
            workspaceId: WORKSPACE,
            link: '/chats/1',
            tag: 'room-1',
            receivedAt: 1_765_000_000_000,
            ...fields,
        });

    it('parses each file into the link, tag and workspace, never more', async () => {
        mocks.native.listInbox.mockResolvedValueOnce([
            { id: UUID_1, json: entry({ title: 'never read', body: 'never read' }) },
            { id: UUID_2, json: entry({ tag: undefined, link: '/' }) },
        ]);
        const push = await load();
        await expect(push.readInbox()).resolves.toEqual({
            entries: [
                { id: UUID_1, workspaceId: WORKSPACE, link: '/chats/1', tag: 'room-1', receivedAt: 1_765_000_000_000 },
                { id: UUID_2, workspaceId: WORKSPACE, link: '/', tag: null, receivedAt: 1_765_000_000_000 },
            ],
            unreadable: [],
        });
    });

    it('lists a file that is no entry as unreadable, and skips a name that is no UUID', async () => {
        mocks.native.listInbox.mockResolvedValueOnce([
            { id: UUID_1, json: '{' },
            { id: UUID_2, json: entry({ link: 'https://elsewhere.example/' }) },
            { id: 'not-a-uuid', json: entry({}) },
        ]);
        const push = await load();
        await expect(push.readInbox()).resolves.toEqual({ entries: [], unreadable: [UUID_1, UUID_2] });
    });

    it.each([
        ['an array', '[]'],
        ['null', 'null'],
        ['no workspace', entry({ workspaceId: undefined })],
        ['a bad workspace id', entry({ workspaceId: '../x' })],
        ['no link', entry({ link: undefined })],
        ['a tag that is no string', entry({ tag: 3 })],
        ['no time', entry({ receivedAt: undefined })],
        ['a time that is no number', entry({ receivedAt: '1' })],
    ])('refuses %s', async (_name, json) => {
        const push = await load();
        expect(push.parseInboxEntry(UUID_1, json)).toBeNull();
    });

    it('deletes only UUIDs, and asks nothing for none', async () => {
        const push = await load();
        await push.deleteInbox([]);
        expect(mocks.native.deleteInbox).not.toHaveBeenCalled();
        await push.deleteInbox([UUID_1, UUID_2]);
        expect(mocks.native.deleteInbox).toHaveBeenCalledWith([UUID_1, UUID_2]);
        await expect(push.deleteInbox(['../x'])).rejects.toThrow(TypeError);
        expect(mocks.native.deleteInbox).toHaveBeenCalledOnce();
    });
});

describe("Android's taps and screen", () => {
    const tap = { workspaceId: WORKSPACE, link: '/chats/room-1', tag: 'room-1' };
    const android = () => {
        const listeners: ((value: unknown) => void)[] = [];
        const extra = {
            setScreen: vi.fn((_workspaceId: string | null, _path: string | null) => {}),
            takeLaunchTap: vi.fn(async (): Promise<unknown> => tap),
            addListener: vi.fn((_event: string, listener: (value: unknown) => void) => {
                listeners.push(listener);
                return { remove: vi.fn() };
            }),
        };
        mocks.requireNativeModule.mockImplementation(() => ({ ...mocks.native, ...extra }));
        return { extra, emit: (value: unknown) => listeners.forEach((listener) => listener(value)) };
    };

    it('passes the chat on screen, checking the workspace id', async () => {
        const { extra } = android();
        const push = await load();
        push.setScreen(WORKSPACE, '/chats/room-1');
        push.setScreen(null, null);
        expect(extra.setScreen.mock.calls).toEqual([
            [WORKSPACE, '/chats/room-1'],
            [null, null],
        ]);
        expect(() => push.setScreen('../x', '/')).toThrow(TypeError);
    });

    it('takes the launch tap, parsed', async () => {
        const { extra } = android();
        const push = await load();
        expect(await push.takeLaunchTap()).toEqual(tap);
        extra.takeLaunchTap.mockResolvedValueOnce(null);
        expect(await push.takeLaunchTap()).toBeNull();
        extra.takeLaunchTap.mockResolvedValueOnce({ ...tap, link: 'https://evil.test/' });
        expect(await push.takeLaunchTap()).toBeNull();
    });

    it("hands the listener taps and drops what isn't one", async () => {
        const { emit } = android();
        const push = await load();
        const heard: unknown[] = [];
        push.addTapListener((value) => heard.push(value));
        emit(tap);
        emit({ ...tap, tag: undefined });
        emit({ ...tap, workspaceId: '../x' });
        emit({ ...tap, link: '//evil.test/x' });
        emit('nope');
        expect(heard).toEqual([tap, { ...tap, tag: null }]);
    });

    it('does nothing on iOS, whose module has none of them', async () => {
        const push = await load();
        push.setScreen(WORKSPACE, '/');
        expect(await push.takeLaunchTap()).toBeNull();
        const subscription = push.addTapListener(() => {});
        expect(() => subscription.remove()).not.toThrow();
    });
});

describe('the test vectors', () => {
    // The Swift test reads them (and a JVM test will): RFC 8291 Appendix A, web-push 3.6.7, two records.
    const vectors = JSON.parse(
        readFileSync(join(import.meta.dirname, '../../modules/socio-push/vectors.json'), 'utf8'),
    );

    it('hold the three cases, with test keys only', () => {
        expect(Object.keys(vectors).sort()).toEqual(['note', 'rfc8291', 'twoRecords', 'webPush367']);
        expect(vectors.note).toMatch(/Test keys only/);
        expect(vectors.rfc8291.plaintext).toBe('When I grow up, I want to be a watermelon');
        const two = Buffer.from(vectors.twoRecords.body, 'base64url');
        // Header, then more than one 4096-byte record.
        expect(two.readUInt32BE(16)).toBe(4096);
        expect(two.length - 86).toBeGreaterThan(4096);
    });
});
