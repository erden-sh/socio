import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { checkKey, checkPrefix, StorageUnavailableError, type ListedObject } from '@socio/data/object-store';

import type { LocalObjectStoreShape } from './contract.js';

const PAGE = 1000;
const TMP = /\.[0-9a-f-]{36}\.tmp$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const unavailable = (error: unknown): never => {
    throw new StorageUnavailableError(
        `Local file storage failed (${(error as NodeJS.ErrnoException)?.code ?? 'error'}).`,
    );
};

/**
 * Objects as files under `root` (USER_DATA_DIR): a key's segments are
 * directories, so `<user>/files/<id>.bin` is exactly the data space's
 * layout before CB-54 and dev installs need no migration. Writes are
 * atomic (a temporary file, then a rename) and private (0600).
 */
export class LocalObjectStore implements LocalObjectStoreShape {
    readonly driver = 'local' as const;
    constructor(readonly root: string) {}
    private path(key: string) {
        return join(this.root, ...checkKey(key).split('/'));
    }
    async put(key: string, body: Uint8Array) {
        const path = this.path(key);
        const tmp = `${path}.${randomUUID()}.tmp`;
        try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(tmp, body, { mode: 0o600 });
            await rename(tmp, path);
        } catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined);
            unavailable(error);
        }
    }
    async get(key: string) {
        const path = this.path(key);
        try {
            return new Uint8Array(await readFile(path));
        } catch (error) {
            if (missing(error)) {
                return undefined;
            }
            return unavailable(error);
        }
    }
    async head(key: string) {
        const path = this.path(key);
        try {
            const info = await stat(path);
            return info.isFile() ? { size: info.size } : undefined;
        } catch (error) {
            if (missing(error)) {
                return undefined;
            }
            return unavailable(error);
        }
    }
    async delete(key: string) {
        const path = this.path(key);
        await rm(path, { force: true }).catch(unavailable);
    }
    async list(prefix: string, cursor?: string) {
        checkPrefix(prefix);
        // Walk only the directory the prefix names; filter the rest by key.
        const base = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
        const keys: ListedObject[] = [];
        const walk = async (dir: string) => {
            let entries;
            try {
                entries = await readdir(join(this.root, ...dir.split('/')), {
                    withFileTypes: true,
                });
            } catch (error) {
                if (missing(error)) {
                    return;
                }
                return unavailable(error);
            }
            for (const entry of entries) {
                const key = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    await walk(key);
                } else if (
                    entry.isFile() &&
                    !TMP.test(entry.name) &&
                    key.startsWith(prefix) &&
                    (!cursor || key > cursor)
                ) {
                    const info = await stat(join(this.root, key));
                    keys.push({ key, size: info.size, modified: info.mtimeMs });
                }
            }
        };
        await walk(base);
        keys.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const page = keys.slice(0, PAGE);
        return keys.length > PAGE ? { keys: page, next: page[page.length - 1].key } : { keys: page };
    }
    async ensureReady() {
        try {
            await mkdir(this.root, { recursive: true });
            await access(this.root, constants.W_OK);
        } catch (error) {
            unavailable(error);
        }
    }
}
