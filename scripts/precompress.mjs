// Writes a gzip copy (`<file>.gz`, level 9) next to each text file of the
// browser build, so the server sends build files compressed without
// compressing them on every request (src/server/web/mount.ts serves the
// `.gz` to a browser that takes gzip). Run by `pnpm run build`; the
// directory defaults to dist/web/client.
//
//   node scripts/precompress.mjs [dir]
//
// Skipped: files under 1 kB (as packages/foundation/src/http/compression.ts), types that are
// compressed already (images, woff and woff2 fonts), and files gzip
// shrinks by less than a tenth.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, gzipSync } from 'node:zlib';

const MIN_BYTES = 1024;
const TEXT = /\.(?:js|mjs|css|html|json|map|svg|txt|webmanifest|xml|ttf)$/i;

const dir = process.argv[2] ?? 'dist/web/client';
let files = 0;
let before = 0;
let after = 0;
const started = performance.now();
function walk(path) {
    for (const name of readdirSync(path)) {
        // Never served (`/.vite/manifest.json`).
        if (name.startsWith('.')) {
            continue;
        }
        const file = join(path, name);
        if (statSync(file).isDirectory()) {
            walk(file);
        } else if (TEXT.test(name)) {
            const raw = readFileSync(file);
            if (raw.byteLength < MIN_BYTES) {
                continue;
            }
            const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
            if (gz.byteLength > raw.byteLength * 0.9) {
                continue;
            }
            writeFileSync(`${file}.gz`, gz);
            files++;
            before += raw.byteLength;
            after += gz.byteLength;
        }
    }
}
walk(dir);
const mb = (bytes) => (bytes / 1e6).toFixed(1);
console.log(
    `Precompressed ${files} files in ${dir}: ${mb(before)} MB to ${mb(after)} MB gzip, in ${Math.round(performance.now() - started)} ms.`,
);
