import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeFileSystemContract } from '../helpers/file-system-contract';
import { createNodeFileSystem } from '../helpers/node-fs';

// The node:fs binding the store's tests use holds to the FileSystem contract
// (src/data/layout.ts), so what the tests show holds for a binding that does.

describeFileSystemContract('node:fs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'socio-fs-'));
    return {
        fs: createNodeFileSystem(),
        root,
        writeFile: (path) => writeFile(path, 'bytes'),
        lock: async (path) => {
            // Root reads any directory, whatever its mode.
            if (process.getuid?.() === 0) {
                return null;
            }
            await chmod(path, 0o000);
            return () => chmod(path, 0o755);
        },
        dispose: () => rm(root, { recursive: true, force: true }),
    };
});
