// The pins of the socio-coding image's other coding agents (CB-326
// and 4): deployment/coding/codex.pin, claude-code.pin and gemini-cli.pin
// each name one tarball on the npm registry (Codex's and Claude Code's the
// linux-x64 binary the package's launcher or install script would pick;
// Gemini CLI's the whole bundled CLI), installed without running any of
// the package's scripts. (Grok Build isn't on npm and is built from source:
// scripts/lib/grok-pin.mjs.) scripts/build-images.mjs passes its
// version, URL and checksum to deployment/coding/coding.Dockerfile, and
// refuses to build without a well-formed pin that matches the Dockerfile's
// defaults; tests/integration/build-images.test.ts checks the checked-in files.
//
// The file is `key=value` lines; blank lines and `#` comments are ignored:
//
//   version=<x.y.z>              the package's version
//   package=<name>@<version>…    the platform package, for people
//   url=https://registry.npmjs.org/<scope>/<name>/-/<file>.tgz
//   sha512=<128 lowercase hex>   the tarball's SHA-512
//   integrity=sha512-<base64>    the registry's dist.integrity (the same digest)
//   fetched=<YYYY-MM-DD>         when the checksum was taken
//   verified=<one line>          how it was checked
//
// Every key is required once; any other key is refused.

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** Where an npm pin's tarball is: the registry, a `.tgz`. */
const TARBALL = /^[A-Za-z0-9@%/._-]+\.tgz$/;
const KEYS = ['version', 'package', 'url', 'sha512', 'integrity', 'fetched', 'verified'];

/**
 * The harnesses pinned this way: their pin file and the Dockerfile's ARG
 * prefix (`ARG CODEX_VERSION`, `ARG CODEX_URL`, `ARG CODEX_SHA512`).
 */
export const NPM_PINS = [
    { id: 'codex', label: 'Codex', path: 'deployment/coding/codex.pin', arg: 'CODEX' },
    { id: 'claude-code', label: 'Claude Code', path: 'deployment/coding/claude-code.pin', arg: 'CLAUDE_CODE' },
    { id: 'gemini-cli', label: 'Gemini CLI', path: 'deployment/coding/gemini-cli.pin', arg: 'GEMINI_CLI' },
];

/** The pin as data, or an Error naming what is wrong. */
export function parseNpmPin(text, label = 'npm') {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error(`the ${label} pin is empty`);
    }
    const pin = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const at = line.indexOf('=');
        if (at <= 0) {
            throw new Error(`the ${label} pin has a bad line: ${line}`);
        }
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!KEYS.includes(key)) {
            throw new Error(`the ${label} pin has an unknown key: ${key}`);
        }
        if (Object.hasOwn(pin, key)) {
            throw new Error(`the ${label} pin repeats ${key}`);
        }
        pin[key] = value;
    }
    for (const key of KEYS) {
        if (!pin[key]) {
            throw new Error(`the ${label} pin has no ${key}`);
        }
    }
    if (!/^\d+\.\d+\.\d+$/.test(pin.version)) {
        throw new Error(`the ${label} pin version must be x.y.z`);
    }
    if (!pin.url.startsWith(NPM_REGISTRY) || !TARBALL.test(pin.url.slice(NPM_REGISTRY.length))) {
        throw new Error(`the ${label} pin url must be a .tgz on ${NPM_REGISTRY}`);
    }
    if (!pin.url.includes(pin.version)) {
        throw new Error(`the ${label} pin url must be for ${pin.version}`);
    }
    if (!/^[0-9a-f]{128}$/.test(pin.sha512)) {
        throw new Error(`the ${label} pin sha512 must be 128 lowercase hex digits`);
    }
    const integrity = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(pin.integrity)?.[1];
    if (!integrity || Buffer.from(integrity, 'base64').toString('hex') !== pin.sha512) {
        throw new Error(`the ${label} pin integrity must be the same digest as its sha512`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pin.fetched)) {
        throw new Error(`the ${label} pin fetched date must be YYYY-MM-DD`);
    }
    return pin;
}

/** The coding Dockerfile's defaults for one harness: `ARG <P>_VERSION=…` and `ARG <P>_URL=…`. */
export function dockerfileNpm(dockerfile, arg) {
    const version = new RegExp(`^ARG ${arg}_VERSION=(\\S+)$`, 'm').exec(dockerfile)?.[1];
    const url = new RegExp(`^ARG ${arg}_URL=(\\S+)$`, 'm').exec(dockerfile)?.[1];
    if (!version || !url) {
        throw new Error(`coding.Dockerfile has no ARG ${arg}_VERSION or ${arg}_URL default`);
    }
    return { version, url };
}

/** One pin, checked against the Dockerfile it is for. */
export function checkNpmPin(pinText, dockerfile, { label, arg }) {
    const pin = parseNpmPin(pinText, label);
    const image = dockerfileNpm(dockerfile, arg);
    if (pin.version !== image.version) {
        throw new Error(`the ${label} pin is for ${pin.version}, coding.Dockerfile installs ${image.version}`);
    }
    if (image.url.replaceAll(`\${${arg}_VERSION}`, image.version) !== pin.url) {
        throw new Error(`the ${label} pin url is not coding.Dockerfile’s`);
    }
    return pin;
}
