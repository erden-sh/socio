import { BRAND_LOGO_MAX_BYTES, DEFAULT_BRANDING } from '@socio/shared/branding';

import type { PublicFetch } from '../net/public-fetch';

import { type FileSystem, joinPath, storeDirectory } from './layout';

// A workspace's logo while it is being added. The probe's sign-in
// view gives `branding.logo`: the default `/favicon.svg`, another
// same-origin path, or an uploaded PNG, JPEG or WebP data URL
// (packages/shared/src/branding.ts).
//
// - The default, a missing logo and anything the app can't take (another
//   origin, another type, too big, a failed request) show the bundled mascot.
// - A data URL or a same-origin image is written to `socio/staging/`, so the
//   confirm screen shows it as a file:// image, never from the network, and
//   nothing of a workspace not yet added is left in the image cache.
// - The commit moves it into the workspace's directory (`commitLogo`), and the
//   registry keeps its file name. Cancel deletes the staging directory
//   (`discardStagedLogos`), and so does the next add, for what a kill left.
//
// Same-origin logos come through publicFetch: no cookies, no Origin, and a
// redirect is handed back, which counts as no logo.

/** The staging directory, in the store's folder. */
export const STAGING_DIR = 'staging';

/** The image types a logo may be, with the extension its file takes. */
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

type LogoType = keyof typeof TYPES;

/** What the store needs to stage a logo: the FileSystem's slice, plus writing bytes and moving a file. */
export interface LogoFiles extends Pick<FileSystem, 'mkdir' | 'remove'> {
    /** Writes `bytes` to a new file at `path`, whose directory exists. */
    write(path: string, bytes: Uint8Array): Promise<void>;
    /** Moves the file at `from` to `to`, replacing a file there; `to`'s directory exists. */
    move(from: string, to: string): Promise<void>;
}

/** Where a logo comes from, as the sign-in view names it. */
export type LogoSource =
    | { readonly kind: 'mascot' }
    | { readonly kind: 'data'; readonly type: LogoType; readonly base64: string }
    | { readonly kind: 'fetch'; readonly url: string };

/** A staged logo: the mascot, or a file in the staging directory. */
export type StagedLogo =
    | { readonly kind: 'mascot' }
    | { readonly kind: 'file'; readonly path: string; readonly extension: string };

const MASCOT = { kind: 'mascot' } as const;

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Where the sign-in view's `logo` leads, for a workspace at `origin`. */
export function logoSource(logo: string | null, origin: string): LogoSource {
    if (logo === null || logo === DEFAULT_BRANDING.logo) {
        return MASCOT;
    }
    const data = DATA_URL.exec(logo);
    if (data !== null) {
        return { kind: 'data', type: data[1] as LogoType, base64: data[2] };
    }
    if (!logo.startsWith('/') || logo.startsWith('//') || logo.startsWith('/\\')) {
        return MASCOT;
    }
    try {
        const url = new URL(logo, origin);
        return url.origin === origin && url.pathname !== DEFAULT_BRANDING.logo
            ? { kind: 'fetch', url: url.href }
            : MASCOT;
    } catch {
        return MASCOT;
    }
}

/** The staging directory under the app's document directory. */
export function stagingDirectory(root: string): string {
    return joinPath(storeDirectory(root), STAGING_DIR);
}

export interface StageLogoOptions {
    /** The app's document directory. */
    readonly root: string;
    readonly files: LogoFiles;
    /** publicFetch (`createPublicFetch`), for a same-origin logo. */
    readonly publicFetch: PublicFetch;
    /** A fresh random name part, so a new logo is never one an image cache already holds. */
    readonly randomName: () => string;
    readonly signal?: AbortSignal;
}

/**
 * Stages the logo of a workspace at `origin`: the bundled mascot, or a file in
 * the staging directory, which it empties first. It never fails over the logo
 * itself (that shows the mascot); it rejects when the staging directory can't
 * be written, and with what publicFetch rejects with once `signal` aborts.
 */
export async function stageLogo(logo: string | null, origin: string, options: StageLogoOptions): Promise<StagedLogo> {
    await discardStagedLogos(options.root, options.files);
    const source = logoSource(logo, origin);
    if (source.kind === 'mascot') {
        return MASCOT;
    }
    const image = source.kind === 'data' ? fromDataUrl(source) : await fromOrigin(source.url, options);
    if (image === null) {
        return MASCOT;
    }
    const directory = stagingDirectory(options.root);
    const extension = TYPES[image.type];
    const path = joinPath(directory, `logo-${options.randomName()}.${extension}`);
    await options.files.mkdir(directory);
    await options.files.write(path, image.bytes);
    return { kind: 'file', path, extension };
}

/**
 * Moves a staged logo into the workspace's directory (which exists) as
 * `logo.<ext>`, then empties the staging directory. Resolves with the file
 * name the registry keeps, or null for the mascot.
 */
export async function commitLogo(
    staged: StagedLogo,
    workspaceDirectory: string,
    root: string,
    files: LogoFiles,
): Promise<string | null> {
    let name: string | null = null;
    if (staged.kind === 'file') {
        name = `logo.${staged.extension}`;
        await files.move(staged.path, joinPath(workspaceDirectory, name));
    }
    await discardStagedLogos(root, files);
    return name;
}

/** Deletes the staging directory and everything in it: a cancel, or what a kill left. */
export async function discardStagedLogos(root: string, files: LogoFiles): Promise<void> {
    await files.remove(stagingDirectory(root));
}

interface Image {
    readonly type: LogoType;
    readonly bytes: Uint8Array;
}

function fromDataUrl(source: Extract<LogoSource, { kind: 'data' }>): Image | null {
    // Base64 is 4 characters per 3 bytes: a longer one is over the limit before decoding.
    if (source.base64.length > Math.ceil(BRAND_LOGO_MAX_BYTES / 3) * 4) {
        return null;
    }
    let binary: string;
    try {
        binary = atob(source.base64);
    } catch {
        return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return checked(source.type, bytes);
}

async function fromOrigin(url: string, { publicFetch, signal }: StageLogoOptions): Promise<Image | null> {
    let response: Response;
    try {
        response = await publicFetch(url, { headers: { accept: Object.keys(TYPES).join(', ') }, signal });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return null;
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const length = Number(response.headers.get('content-length') ?? '0');
    if (response.status !== 200 || !(type in TYPES) || length > BRAND_LOGO_MAX_BYTES) {
        return null;
    }
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        return null;
    }
    return checked(type as LogoType, bytes);
}

/** The image, when its bytes are what its type says and within the limit. */
function checked(type: LogoType, bytes: Uint8Array): Image | null {
    if (bytes.length === 0 || bytes.length > BRAND_LOGO_MAX_BYTES || sniff(bytes) !== type) {
        return null;
    }
    return { type, bytes };
}

/** The type the file's first bytes say it is. */
function sniff(bytes: Uint8Array): LogoType | null {
    const starts = (signature: readonly number[], at = 0) =>
        signature.every((byte, index) => bytes[at + index] === byte);
    if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return 'image/png';
    }
    if (starts([0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
        return 'image/webp';
    }
    return null;
}
