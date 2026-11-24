// The server bucket's runtime guard for files read by path, which no import
// shows: a test that reads or walks the client's source fails here. Child
// processes are out of its sight; scripts/check-test-buckets.mjs reads their
// paths statically.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isClientSide, reachMessage } from './no-client-paths.ts';

type Patched = Record<string, (...args: unknown[]) => unknown>;

const refuse = (target: unknown) => {
    const path = target instanceof URL ? fileURLToPath(target) : target;
    if (typeof path === 'string' && isClientSide(path)) {
        throw new Error(reachMessage(path));
    }
};

const patch = (object: Patched, names: string[]) => {
    for (const name of names) {
        const original = object[name];
        object[name] = function (this: unknown, ...args: unknown[]) {
            refuse(args[0]);
            return original.apply(this, args);
        };
    }
};

patch(fs as unknown as Patched, [
    'readFileSync',
    'readdirSync',
    'opendirSync',
    'readFile',
    'readdir',
    'opendir',
    'createReadStream',
]);
patch(fs.promises as unknown as Patched, ['readFile', 'readdir', 'opendir']);
syncBuiltinESMExports();
