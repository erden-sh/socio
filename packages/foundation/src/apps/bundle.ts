import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { parseAppManifest, type AppManifest } from '@socio/shared/apps/app-manifest';

/**
 * A mini app's bundle: its source and lockfile with the manifest, as
 * one gzipped JSON document. The platform stores it sealed in the owner's
 * data space; the runtime unpacks it into the app's working directory.
 */
export const BUNDLE_FORMAT = 'company-brain-app-bundle/1';

export interface BundleFile {
    path: string;
    data: Buffer;
    /** Executable bit only; everything else is the runtime's. */
    executable?: boolean;
}
export interface BundleEntry {
    path: string;
    size: number;
    sha256: string;
}
export interface Bundle {
    manifest: AppManifest;
    files: BundleFile[];
}
export interface BundleLimits {
    maxFiles: number;
    maxFileBytes: number;
    /** All files together, uncompressed. */
    maxBytes: number;
}
export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
    maxFiles: 400,
    maxFileBytes: 2 * 1048576,
    maxBytes: 8 * 1048576,
};

/** `APPS_BUNDLE_MAX_FILES`, `APPS_BUNDLE_MAX_FILE_MB`, `APPS_BUNDLE_MAX_MB`. */
export function bundleLimitsFromEnv(env: Record<string, string | undefined>): BundleLimits {
    const read = (name: string, fallback: number, max: number) => {
        const raw = env[name]?.trim();
        const value = raw ? Number(raw) : fallback;
        if (!Number.isFinite(value) || value <= 0 || value > max) {
            throw new Error(`${name} must be a number above 0, at most ${max}.`);
        }
        return value;
    };
    return {
        maxFiles: Math.floor(read('APPS_BUNDLE_MAX_FILES', 400, 5000)),
        maxFileBytes: Math.floor(read('APPS_BUNDLE_MAX_FILE_MB', 2, 50) * 1048576),
        maxBytes: Math.floor(read('APPS_BUNDLE_MAX_MB', 8, 100) * 1048576),
    };
}

export class BundleError extends Error {}

const SEGMENT = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]{0,127}$/;
/** Never in a bundle: dependencies, history, the platform's token files, secrets. */
const EXCLUDED = [/^node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /^\.socio(\/|$)/];
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|id_[a-z0-9]+|.*\.pem|.*\.key)$/i;

/** A file path inside a bundle, or why it can't be one. */
export function bundlePathProblem(path: string): string | undefined {
    if (!path || path.length > 255) {
        return `"${path.slice(0, 80)}": bad path length.`;
    }
    const segments = path.split('/');
    if (
        path.startsWith('/') ||
        segments.length > 20 ||
        segments.some((segment) => !SEGMENT.test(segment) || /^\.+$/.test(segment))
    ) {
        return `"${path.slice(0, 80)}" is not a plain relative path.`;
    }
    if (EXCLUDED.some((pattern) => pattern.test(path))) {
        return `"${path.slice(0, 80)}" is never packaged (node_modules, .git, .socio).`;
    }
    if (SECRET_FILE.test(path)) {
        return `"${path.slice(0, 80)}" looks like a secret (.env, keys, .npmrc); bundles hold no secrets.`;
    }
    return undefined;
}

/** Whether a path may be packaged at all (listing filters by this). */
export const packageable = (path: string) => !bundlePathProblem(path);

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Bundle files in plain code-unit order, never the server's locale (`LANG`
 * would change a bundle's bytes and checksum). Paths are ASCII, so this is
 * also byte order.
 */
export const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Checks files against the limits and paths; throws a BundleError. */
export function checkFiles(files: BundleFile[], limits: BundleLimits) {
    if (!files.length) {
        throw new BundleError('The bundle has no files.');
    }
    if (files.length > limits.maxFiles) {
        throw new BundleError(`At most ${limits.maxFiles} files in a bundle (${files.length} given).`);
    }
    let total = 0;
    const seen = new Set<string>();
    for (const file of files) {
        const problem = bundlePathProblem(file.path);
        if (problem) {
            throw new BundleError(problem);
        }
        if (seen.has(file.path)) {
            throw new BundleError(`"${file.path}" is in the bundle twice.`);
        }
        seen.add(file.path);
        if (file.data.length > limits.maxFileBytes) {
            throw new BundleError(
                `"${file.path}" is ${file.data.length} bytes; files are at most ${limits.maxFileBytes}.`,
            );
        }
        total += file.data.length;
    }
    if (total > limits.maxBytes) {
        throw new BundleError(`The bundle is ${total} bytes; at most ${limits.maxBytes}.`);
    }
    return total;
}

/** Packs files and the manifest; the entry must be among the files. */
export function encodeBundle(bundle: Bundle, limits = DEFAULT_BUNDLE_LIMITS) {
    checkFiles(bundle.files, limits);
    if (!bundle.files.some((file) => file.path === bundle.manifest.entry)) {
        throw new BundleError(`The entry ${bundle.manifest.entry} is not among the bundle's files.`);
    }
    const files = [...bundle.files].sort(byPath);
    const json = JSON.stringify({
        format: BUNDLE_FORMAT,
        manifest: bundle.manifest,
        files: files.map((file) => ({
            path: file.path,
            ...(file.executable ? { executable: true } : {}),
            sha256: sha(file.data),
            data: file.data.toString('base64'),
        })),
    });
    const bytes = gzipSync(json, { level: 9 });
    return {
        bytes,
        sha256: sha(bytes),
        entries: files.map((file): BundleEntry => ({
            path: file.path,
            size: file.data.length,
            sha256: sha(file.data),
        })),
        sizeBytes: files.reduce((sum, file) => sum + file.data.length, 0),
    };
}

/**
 * Unpacks a bundle, checking everything again: the runtime and the
 * platform never trust a bundle's bytes (a stored file can be replaced).
 */
export function decodeBundle(bytes: Buffer, limits = DEFAULT_BUNDLE_LIMITS): Bundle {
    let json: string;
    try {
        // Base64 inflates by 4/3; the JSON around it is small.
        json = gunzipSync(bytes, {
            maxOutputLength: Math.ceil(limits.maxBytes * 1.4) + 1048576,
        }).toString('utf8');
    } catch {
        throw new BundleError('The bundle is not readable (or too large).');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new BundleError('The bundle is not readable.');
    }
    const doc = parsed as {
        format?: unknown;
        manifest?: unknown;
        files?: unknown;
    };
    if (doc.format !== BUNDLE_FORMAT || !Array.isArray(doc.files)) {
        throw new BundleError('Not a Socio app bundle.');
    }
    const manifest = parseAppManifest(doc.manifest);
    if (!manifest.ok) {
        throw new BundleError(`Manifest: ${manifest.error}`);
    }
    const files = doc.files.map((raw: unknown): BundleFile => {
        const file = raw as {
            path?: unknown;
            data?: unknown;
            sha256?: unknown;
            executable?: unknown;
        };
        if (typeof file.path !== 'string' || typeof file.data !== 'string') {
            throw new BundleError('A bundle file is malformed.');
        }
        const data = Buffer.from(file.data, 'base64');
        if (typeof file.sha256 === 'string' && file.sha256 !== sha(data)) {
            throw new BundleError(`"${file.path}" doesn't match its checksum.`);
        }
        return { path: file.path, data, executable: file.executable === true };
    });
    checkFiles(files, limits);
    if (!files.some((file) => file.path === manifest.manifest.entry)) {
        throw new BundleError('The entry is not among the bundle files.');
    }
    return { manifest: manifest.manifest, files };
}

/**
 * Reads a gzipped ustar archive (GNU tar's `--format=ustar`, as the
 * packaging command in the Dot's computer writes it): regular files only,
 * directories skipped, links and anything else refused.
 */
export function readTarGz(bytes: Buffer, limits = DEFAULT_BUNDLE_LIMITS) {
    let tar: Buffer;
    try {
        tar = gunzipSync(bytes, {
            maxOutputLength: limits.maxBytes + limits.maxFiles * 1024 + 1048576,
        });
    } catch {
        throw new BundleError('The packaged files could not be read (or are larger than the bundle limit).');
    }
    const files: BundleFile[] = [];
    let offset = 0;
    const text = (start: number, length: number) => {
        const slice = tar.subarray(start, start + length);
        const end = slice.indexOf(0);
        return slice.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        const name = text(offset, 100);
        const mode = parseInt(text(offset + 100, 8).trim() || '0', 8);
        const size = parseInt(text(offset + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(header[156] || 48);
        const prefix = text(offset + 257, 6) === 'ustar' ? text(offset + 345, 155) : '';
        if (!Number.isFinite(size) || size < 0) {
            throw new BundleError('The packaged files are malformed.');
        }
        const path = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '').replace(/\/$/, '');
        const start = offset + 512;
        offset = start + Math.ceil(size / 512) * 512;
        if (type === '5' || !path || path === '.') {
            continue;
        }
        if (type !== '0' && type !== '\0') {
            throw new BundleError(`"${path.slice(0, 80)}" is not a regular file (links aren't packaged).`);
        }
        if (start + size > tar.length) {
            throw new BundleError('The packaged files are truncated.');
        }
        files.push({
            path,
            data: Buffer.from(tar.subarray(start, start + size)),
            ...(mode & 0o111 ? { executable: true } : {}),
        });
        if (files.length > limits.maxFiles) {
            throw new BundleError(`At most ${limits.maxFiles} files in a bundle.`);
        }
    }
    return files;
}

/**
 * `src/**`, `*.ts`, `package.json`: `*` and `?` within a path segment, `**`
 * across segments; a plain name also matches everything under it (`src`).
 */
export function globMatch(pattern: string, path: string) {
    let glob = pattern.trim().replace(/^\.\//, '');
    if (glob.endsWith('/')) {
        glob += '**';
    }
    if (!/[*?]/.test(glob)) {
        return path === glob || path.startsWith(`${glob}/`);
    }
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') {
                source += '(?:.*/)?';
                i += 2;
            } else {
                source += '.*';
                i += 1;
            }
        } else if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
        } else {
            source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}$`).test(path);
}

/** Lines for an approval: files added, removed and changed. */
export function fileChanges(before: BundleEntry[] | undefined, after: BundleEntry[]): string[] {
    if (!before) {
        return [`${after.length} file(s).`];
    }
    const was = new Map(before.map((entry) => [entry.path, entry]));
    const now = new Map(after.map((entry) => [entry.path, entry]));
    const added = after.filter((entry) => !was.has(entry.path));
    const removed = before.filter((entry) => !now.has(entry.path));
    const changed = after.filter((entry) => {
        const old = was.get(entry.path);
        return old && old.sha256 !== entry.sha256;
    });
    const list = (entries: BundleEntry[]) =>
        entries
            .slice(0, 6)
            .map((entry) => entry.path)
            .join(', ') + (entries.length > 6 ? `, +${entries.length - 6} more` : '');
    return [
        ...(changed.length ? [`Changed: ${list(changed)}`] : []),
        ...(added.length ? [`Added: ${list(added)}`] : []),
        ...(removed.length ? [`Removed: ${list(removed)}`] : []),
        ...(!changed.length && !added.length && !removed.length ? ['No file changes.'] : []),
    ];
}
