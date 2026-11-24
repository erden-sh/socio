import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FileSystem, joinPath } from '../../src/data/layout';

// What every binding of the store's FileSystem must do (src/data/layout.ts).
// The node:fs binding runs it under Node (tests/data/file-system.test.ts); the
// expo-file-system binding must pass it too, on a device. Launch
// decides deletions from these answers (store.ts), so a binding that answers
// "nothing there" for a read it couldn't do, or answers for one kind of entry
// only, can make it delete what is still in use.

export interface FileSystemSubject {
    readonly fs: FileSystem;
    /** An empty directory the cases may fill. */
    readonly root: string;
    /** Writes a file with some bytes. */
    writeFile(path: string): Promise<void>;
    /**
     * Makes the directory unreadable and resolves what undoes it, or null
     * where the platform can't (an app's own sandbox, or running as root).
     */
    lock(path: string): Promise<(() => Promise<void>) | null>;
    /** Removes everything the cases made. */
    dispose(): Promise<void>;
}

export function describeFileSystemContract(name: string, make: () => Promise<FileSystemSubject>): void {
    describe(`the FileSystem contract: ${name}`, () => {
        let subject: FileSystemSubject;
        const at = (...names: string[]) => names.reduce(joinPath, subject.root);
        beforeEach(async () => {
            subject = await make();
        });
        afterEach(async () => {
            await subject.dispose();
        });

        it('exists answers true for a file and for a directory, in one call, and false when nothing is there', async () => {
            const { fs } = subject;
            await fs.mkdir(at('folder'));
            await subject.writeFile(at('folder', 'registry.db'));
            expect(await fs.exists(at('folder'))).toBe(true);
            expect(await fs.exists(at('folder', 'registry.db'))).toBe(true);
            expect(await fs.exists(at('folder', 'missing.db'))).toBe(false);
            expect(await fs.exists(at('missing', 'registry.db'))).toBe(false);
        });

        it('list names the entries directly in a directory, files and directories alike, and [] for a missing one', async () => {
            const { fs } = subject;
            await fs.mkdir(at('folder', 'images'));
            await subject.writeFile(at('folder', 'images', 'logo.png'));
            await subject.writeFile(at('folder', 'user.db'));
            expect((await fs.list(at('folder'))).sort()).toEqual(['images', 'user.db']);
            expect(await fs.list(at('missing'))).toEqual([]);
        });

        it('remove deletes a file, a directory and all in it, and is quiet when nothing is there', async () => {
            const { fs } = subject;
            await fs.mkdir(at('folder', 'images'));
            await subject.writeFile(at('folder', 'images', 'logo.png'));
            await subject.writeFile(at('folder', 'user.db'));
            await fs.remove(at('folder', 'user.db'));
            expect(await fs.list(at('folder'))).toEqual(['images']);
            await fs.remove(at('folder'));
            expect(await fs.exists(at('folder'))).toBe(false);
            await expect(fs.remove(at('folder'))).resolves.toBeUndefined();
        });

        it('mkdir makes missing parents and is quiet when the directory is there', async () => {
            const { fs } = subject;
            await fs.mkdir(at('a', 'b', 'c'));
            await fs.mkdir(at('a', 'b', 'c'));
            expect(await fs.exists(at('a', 'b', 'c'))).toBe(true);
        });

        it('throws when it can’t read, never answering “nothing there”', async ({ skip }) => {
            const { fs } = subject;
            await fs.mkdir(at('folder', 'workspace'));
            await subject.writeFile(at('folder', 'registry.db'));
            const unlock = await subject.lock(at('folder'));
            if (unlock === null) {
                skip('this platform can’t make a directory unreadable here');
                return;
            }
            try {
                await expect(fs.list(at('folder'))).rejects.toThrow();
                await expect(fs.exists(at('folder', 'registry.db'))).rejects.toThrow();
                await expect(fs.exists(at('folder', 'workspace'))).rejects.toThrow();
            } finally {
                await unlock();
            }
        });
    });
}
