import { accessSync, constants, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

let root: string | undefined;

/**
 * A temporary directory in memory where there is a tmpfs (`/dev/shm`, as on
 * Linux), otherwise the system's. SQLite commits and the atomic replace of a
 * file (write, then rename over it) wait for the disk on ext4; on a busy
 * host that wait, not the test's work, decides how long a test with many
 * writes takes. In memory, the same files and statements run without it.
 */
export function memoryTmpdir() {
    if (root === undefined) {
        try {
            accessSync('/dev/shm', constants.W_OK);
            root = statSync('/dev/shm').isDirectory() ? '/dev/shm' : tmpdir();
        } catch {
            root = tmpdir();
        }
    }
    return root;
}
