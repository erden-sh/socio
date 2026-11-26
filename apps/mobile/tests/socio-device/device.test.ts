import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wrapper against a fake SocioDevice module: Node has no native side, so
// `expo`'s requireNativeModule hands back this object instead.
const mocks = vi.hoisted(() => {
    type Change = (event: never) => void;
    const listeners = new Map<string, Set<Change>>();
    const native = {
        excludeFromBackup: vi.fn(async (_path: string) => {}),
        isExcludedFromBackup: vi.fn(async (_path: string): Promise<boolean | null> => true),
        setFileProtection: vi.fn(async (_path: string, _level: string) => {}),
        getFileProtection: vi.fn(async (_path: string): Promise<string | null> => 'complete'),
        isProtectedDataAvailable: vi.fn(async () => false),
        holdBackgroundGrace: vi.fn(async (_hold: boolean) => {}),
        processStartTime: vi.fn(() => 1_762_520_000_123.25),
        wasPrewarmed: vi.fn(() => false),
        reportFullyDrawn: vi.fn(async () => true),
        appBuild: vi.fn(() => ({ version: '0.1.0', build: '2829' })),
        openAuthTab: vi.fn(async (_url: string, _host: string, _path: string) => ({
            type: 'unavailable',
            reason: 'no-auth-tab',
        })),
        previewFile: vi.fn(
            async (_path: string, _mimeType: string, _name: string, _contentUri: string | null) => 'shown',
        ),
        saveFile: vi.fn(async (_path: string, _mimeType: string, _name: string) => 'saved'),
        addListener: vi.fn((event: string, listener: Change) => {
            const set = listeners.get(event) ?? new Set();
            listeners.set(event, set.add(listener));
            return { remove: () => set.delete(listener) };
        }),
    };
    const requireNativeModule = vi.fn((_name: string): typeof native => native);
    return { listeners, native, requireNativeModule };
});

vi.mock('expo', () => ({ requireNativeModule: mocks.requireNativeModule }));
// The module's index also exports the protected-data wait, which reads AppState.
vi.mock('react-native', () => ({ AppState: {} }));

const load = () => import('../../modules/socio-device');

const send = (event: string, payload: unknown) => {
    for (const listener of mocks.listeners.get(event) ?? []) {
        (listener as (payload: unknown) => void)(payload);
    }
};
const emit = (available: boolean) => send('onProtectedDataChange', { available });

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.requireNativeModule.mockImplementation(() => mocks.native);
});

describe('loading the native module', () => {
    it('asks for SocioDevice on first use, not at import, and only once', async () => {
        const device = await load();
        expect(mocks.requireNativeModule).not.toHaveBeenCalled();
        device.processStartTime();
        await device.reportFullyDrawn();
        expect(mocks.requireNativeModule).toHaveBeenCalledOnce();
        expect(mocks.requireNativeModule).toHaveBeenCalledWith('SocioDevice');
    });

    it('fails the call that needs it when the build lacks it, not the import', async () => {
        mocks.requireNativeModule.mockImplementation(() => {
            throw new Error("Cannot find native module 'SocioDevice'");
        });
        const device = await load();
        await expect(device.excludeFromBackup('/tmp/x')).rejects.toThrow(/Cannot find native module/);
        expect(() => device.processStartTime()).toThrow(/Cannot find native module/);
    });
});

describe('paths', () => {
    it.each([
        [
            '/var/mobile/Containers/Data/Application/A1/Documents/socio',
            '/var/mobile/Containers/Data/Application/A1/Documents/socio',
        ],
        [
            'file:///var/mobile/Containers/Data/Application/A1/Documents/socio/',
            '/var/mobile/Containers/Data/Application/A1/Documents/socio/',
        ],
        [
            'file:///data/user/0/com.ingenioventures.socio.dev/files/socio%20one/%25',
            '/data/user/0/com.ingenioventures.socio.dev/files/socio one/%',
        ],
        ['file://localhost/tmp/socio', '/tmp/socio'],
        // A plain path is never decoded.
        ['/tmp/50%25', '/tmp/50%25'],
    ])('hands the native side %s as %s', async (given, path) => {
        const device = await load();
        expect(device.toFilePath(given)).toBe(path);
        await device.excludeFromBackup(given);
        expect(mocks.native.excludeFromBackup).toHaveBeenCalledWith(path);
    });

    it.each([
        '',
        'socio/abc',
        './socio',
        'content://media/external/1',
        'https://example.test/x',
        'file://host/x',
        'file:/tmp/x',
    ])('refuses %j before the native side sees it', async (given) => {
        const device = await load();
        await expect(device.excludeFromBackup(given)).rejects.toThrow(TypeError);
        await expect(device.isExcludedFromBackup(given)).rejects.toThrow(/absolute path or a file:\/\/ URI/);
        await expect(device.setFileProtection(given, 'complete')).rejects.toThrow(TypeError);
        await expect(device.getFileProtection(given)).rejects.toThrow(TypeError);
        expect(mocks.requireNativeModule).not.toHaveBeenCalled();
    });
});

describe('each call', () => {
    it('reads backup exclusion back as the native side reports it, null included', async () => {
        const device = await load();
        expect(await device.isExcludedFromBackup('file:///tmp/a')).toBe(true);
        mocks.native.isExcludedFromBackup.mockResolvedValueOnce(null);
        expect(await device.isExcludedFromBackup('/tmp/a')).toBeNull();
        expect(mocks.native.isExcludedFromBackup).toHaveBeenLastCalledWith('/tmp/a');
    });

    it('passes the protection class through and reads it back', async () => {
        const device = await load();
        await device.setFileProtection('file:///tmp/images', 'completeUntilFirstUserAuthentication');
        expect(mocks.native.setFileProtection).toHaveBeenCalledWith(
            '/tmp/images',
            'completeUntilFirstUserAuthentication',
        );
        expect(await device.getFileProtection('/tmp/images')).toBe('complete');
        mocks.native.getFileProtection.mockResolvedValueOnce(null);
        expect(await device.getFileProtection('/tmp/images')).toBeNull();
    });

    it('rejects with the native error', async () => {
        mocks.native.excludeFromBackup.mockRejectedValueOnce(new Error('No file or directory at /tmp/gone'));
        const device = await load();
        await expect(device.excludeFromBackup('/tmp/gone')).rejects.toThrow('No file or directory at /tmp/gone');
    });

    it('returns the process start time, protected-data state and fully-drawn answer as they are', async () => {
        const device = await load();
        expect(device.processStartTime()).toBe(1_762_520_000_123.25);
        expect(device.wasPrewarmed()).toBe(false);
        mocks.native.wasPrewarmed.mockReturnValueOnce(true);
        expect(device.wasPrewarmed()).toBe(true);
        expect(await device.isProtectedDataAvailable()).toBe(false);
        expect(await device.reportFullyDrawn()).toBe(true);
        mocks.native.reportFullyDrawn.mockResolvedValueOnce(false);
        expect(await device.reportFullyDrawn()).toBe(false);
    });

    it('returns the installed binary’s version and build as the native side reports them', async () => {
        const device = await load();
        expect(device.appBuild()).toEqual({ version: '0.1.0', build: '2829' });
    });

    it("hands the Auth Tab the sheet's URL, host and path, and its answer back as is", async () => {
        const device = await load();
        await expect(device.openAuthTab('https://acme.example/start', 'link.socio.sh', '/app/cb')).resolves.toEqual({
            type: 'unavailable',
            reason: 'no-auth-tab',
        });
        expect(mocks.native.openAuthTab).toHaveBeenCalledWith('https://acme.example/start', 'link.socio.sh', '/app/cb');
    });

    it('hands a downloaded file to the system by its path: a preview (with Android’s content URI) and a save (CB-558)', async () => {
        const device = await load();
        const uri = 'file:///data/files/socio/ab/files/att-1.abc/Q3%20plan.pdf';
        const path = '/data/files/socio/ab/files/att-1.abc/Q3 plan.pdf';
        await expect(device.previewFile(uri, 'application/pdf', 'Q3 plan.pdf')).resolves.toBe('shown');
        expect(mocks.native.previewFile).toHaveBeenLastCalledWith(path, 'application/pdf', 'Q3 plan.pdf', null);
        mocks.native.previewFile.mockResolvedValueOnce('no-app');
        await expect(
            device.previewFile(
                uri,
                'application/zip',
                'a.zip',
                'content://app.FileSystemFileProvider/expo_files/a.zip',
            ),
        ).resolves.toBe('no-app');
        expect(mocks.native.previewFile).toHaveBeenLastCalledWith(
            path,
            'application/zip',
            'a.zip',
            'content://app.FileSystemFileProvider/expo_files/a.zip',
        );
        await expect(device.saveFile(uri, 'application/pdf', 'Q3 plan.pdf')).resolves.toBe('saved');
        expect(mocks.native.saveFile).toHaveBeenCalledWith(path, 'application/pdf', 'Q3 plan.pdf');
        // Never a web address: only a file of the app's.
        expect(() => device.previewFile('https://example.test/a.pdf', 'application/pdf', 'a.pdf')).toThrow(TypeError);
    });
});

describe('protected-data changes', () => {
    it('reach the listener as a boolean until it is removed', async () => {
        const device = await load();
        const seen: boolean[] = [];
        const subscription = device.addProtectedDataListener((available) => seen.push(available));
        expect(mocks.native.addListener).toHaveBeenCalledWith('onProtectedDataChange', expect.any(Function));
        emit(false);
        emit(true);
        subscription.remove();
        emit(false);
        expect(seen).toEqual([false, true]);
    });
});

describe('the background grace', () => {
    it('passes hold and let go through, and rejects with the native error', async () => {
        const device = await load();
        await device.holdBackgroundGrace(true);
        await device.holdBackgroundGrace(false);
        expect(mocks.native.holdBackgroundGrace.mock.calls).toEqual([[true], [false]]);
        mocks.native.holdBackgroundGrace.mockRejectedValueOnce(new Error('main queue gone'));
        await expect(device.holdBackgroundGrace(true)).rejects.toThrow('main queue gone');
    });

    it('fails the call, not the import, on a build without the module', async () => {
        mocks.requireNativeModule.mockImplementation(() => {
            throw new Error("Cannot find native module 'SocioDevice'");
        });
        const device = await load();
        await expect(device.holdBackgroundGrace(true)).rejects.toThrow('Cannot find native module');
        expect(() => device.addBackgroundGraceListener(() => {})).toThrow('Cannot find native module');
    });

    it('hands the seconds left to the listener until it is removed', async () => {
        const device = await load();
        const seen: number[] = [];
        const subscription = device.addBackgroundGraceListener((secondsLeft) => seen.push(secondsLeft));
        expect(mocks.native.addListener).toHaveBeenCalledWith('onBackgroundGraceExpiring', expect.any(Function));
        send('onBackgroundGraceExpiring', { secondsLeft: 4.5 });
        emit(true);
        subscription.remove();
        send('onBackgroundGraceExpiring', { secondsLeft: 0 });
        expect(seen).toEqual([4.5]);
    });
});
