import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { openFile, sealFile, writeAll } from '@socio/foundation/keys/sealed-files';
import { SecretBox } from '@socio/foundation/keys/secret-box';

import { memoryTmpdir } from './helpers/memory-tmpdir.js';

// CB-378: files sealed and opened a chunk at a time are the bytes
// `sealBytes` and `openBytes` make and read, so backups sealed either way
// open either way.
const SECRET = 'sealed-files-test-secret-0123456789';
const KEY = randomBytes(32);
const CONTEXT = 'company-brain backup';

const cleanup: Array<() => unknown> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0)) {
        fn();
    }
});
const scratch = () => {
    const dir = mkdtempSync(join(memoryTmpdir(), 'sealed-files-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

it.each([
    ['a data key', new SecretBox({ current: KEY, legacy: SECRET }, 'backups')],
    ['the legacy key', new SecretBox({ legacy: SECRET }, 'backups')],
])('seals and opens files in the format of sealBytes, under %s', async (_name, box) => {
    const dir = scratch();
    for (const size of [0, 1, 1024 * 1024, 2 * 1024 * 1024 + 5]) {
        const plain = randomBytes(size);
        writeFileSync(join(dir, 'plain'), plain);
        const sealedSize = await sealFile(box, join(dir, 'plain'), join(dir, 'sealed'), CONTEXT);
        const sealed = readFileSync(join(dir, 'sealed'));
        expect(sealed.length).toBe(sealedSize);
        expect(sealed.length).toBe(box.sealBytes(plain, CONTEXT).length);
        expect(statSync(join(dir, 'sealed')).mode & 0o777).toBe(0o600);
        expect(box.bytesKey(sealed)).toBe(box.currentKey);
        // New files open as before, and files sealed before open the new way.
        expect(box.openBytes(sealed, CONTEXT).equals(plain)).toBe(true);
        writeFileSync(join(dir, 'old'), box.sealBytes(plain, CONTEXT));
        for (const input of ['sealed', 'old']) {
            await openFile(box, join(dir, input), join(dir, 'opened'), CONTEXT);
            expect(readFileSync(join(dir, 'opened')).equals(plain)).toBe(true);
            expect(statSync(join(dir, 'opened')).mode & 0o777).toBe(0o600);
        }
    }
});

it('opens nothing from a damaged file, another context or plaintext', async () => {
    const dir = scratch();
    const box = new SecretBox({ current: KEY, legacy: SECRET }, 'backups');
    writeFileSync(join(dir, 'plain'), randomBytes(3 * 1024 * 1024));
    await sealFile(box, join(dir, 'plain'), join(dir, 'sealed'), CONTEXT);
    const damaged = readFileSync(join(dir, 'sealed'));
    damaged[damaged.length - 10] ^= 1;
    writeFileSync(join(dir, 'damaged'), damaged);
    const out = join(dir, 'out');
    await expect(openFile(box, join(dir, 'damaged'), out, CONTEXT)).rejects.toThrow();
    await expect(openFile(box, join(dir, 'sealed'), out, 'another context')).rejects.toThrow();
    await expect(openFile(box, join(dir, 'plain'), out, CONTEXT)).rejects.toThrow('Unknown sealed file format.');
    await expect(
        openFile(
            new SecretBox({ current: randomBytes(32), legacy: SECRET }, 'backups'),
            join(dir, 'sealed'),
            out,
            CONTEXT,
        ),
    ).rejects.toThrow('Sealed under a data key this server doesn’t have.');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
});

it('writes every byte through short writes, and fails when a write takes none', async () => {
    const written: Array<[number, number | null]> = [];
    let room = 10;
    // A handle that takes at most 3 bytes a write, and none once `room` is used.
    const handle = {
        write: async (_data: Uint8Array, offset: number, length: number, position: number | null) => {
            const bytesWritten = Math.min(3, length, room);
            room -= bytesWritten;
            written.push([offset, position]);
            return { bytesWritten };
        },
    } as unknown as FileHandle;
    await writeAll(handle, Buffer.alloc(7), 100);
    expect(written).toEqual([
        [0, 100],
        [3, 103],
        [6, 106],
    ]);
    await expect(writeAll(handle, Buffer.alloc(7))).rejects.toThrow('A write stopped short.');
});

it.skipIf(process.platform !== 'linux')(
    'fails instead of writing a short file when the disk takes no more',
    () => {
        const dir = scratch();
        writeFileSync(join(dir, 'plain'), randomBytes(64 * 1024));
        const box = new SecretBox({ current: KEY, legacy: SECRET }, 'backups');
        writeFileSync(join(dir, 'sealed'), box.sealBytes(readFileSync(join(dir, 'plain')), CONTEXT));
        // A process whose files may not pass 16 KiB (`ulimit -f`, in KiB in bash).
        const limited = (step: string) =>
            spawnSync(
                'bash',
                ['-c', `ulimit -f 16; exec "${process.execPath}" --import tsx --input-type=module -e "${step}"`],
                {
                    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
                    encoding: 'utf8',
                },
            );
        const prelude = `import { sealFile, openFile } from '@socio/foundation/keys/sealed-files'; import { SecretBox } from '@socio/foundation/keys/secret-box'; const box = new SecretBox({ current: Buffer.from('${KEY.toString('base64')}', 'base64'), legacy: '${SECRET}' }, 'backups');`;
        const seal = limited(
            `${prelude} await sealFile(box, '${join(dir, 'plain')}', '${join(dir, 'resealed')}', '${CONTEXT}');`,
        );
        expect(seal.status).not.toBe(0);
        const open = limited(
            `${prelude} await openFile(box, '${join(dir, 'sealed')}', '${join(dir, 'opened')}', '${CONTEXT}');`,
        );
        expect(open.status).not.toBe(0);
        // Nothing that looks complete: the opened file never got its name.
        expect(existsSync(join(dir, 'opened'))).toBe(false);
        expect(existsSync(join(dir, 'opened.partial'))).toBe(false);
    },
    60_000,
);
