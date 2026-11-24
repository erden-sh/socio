// The OpenCode release pin for the socio-coding image (CB-239,
// security review "Before building", item 3): deployment/coding/opencode.pin.
// scripts/build-images.mjs passes its version and checksum to
// deployment/coding/coding.Dockerfile, and refuses to build without a
// well-formed pin; tests/integration/build-images.test.ts checks the checked-in file.
//
// The file is `key=value` lines; blank lines and `#` comments are ignored:
//
//   version=<x.y.z>              OpenCode's release, without the `v`
//   asset=opencode-linux-x64.tar.gz
//   sha256=<64 lowercase hex>    the archive's SHA-256
//   url=https://github.com/anomalyco/opencode/releases/download/v<version>/<asset>
//   fetched=<YYYY-MM-DD>         when the checksum was taken
//   verified=<one line>          how it was checked
//
// Every key is required once; any other key is refused.

export const OPENCODE_PIN_PATH = 'deployment/coding/opencode.pin';
export const OPENCODE_RELEASES = 'https://github.com/anomalyco/opencode/releases/download';
const KEYS = ['version', 'asset', 'sha256', 'url', 'fetched', 'verified'];

/** The pin as data, or an Error naming what is wrong. */
export function parseOpencodePin(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('the OpenCode pin is empty');
    }
    const pin = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const at = line.indexOf('=');
        if (at <= 0) {
            throw new Error(`the OpenCode pin has a bad line: ${line}`);
        }
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!KEYS.includes(key)) {
            throw new Error(`the OpenCode pin has an unknown key: ${key}`);
        }
        if (Object.hasOwn(pin, key)) {
            throw new Error(`the OpenCode pin repeats ${key}`);
        }
        pin[key] = value;
    }
    for (const key of KEYS) {
        if (!pin[key]) {
            throw new Error(`the OpenCode pin has no ${key}`);
        }
    }
    if (!/^\d+\.\d+\.\d+$/.test(pin.version)) {
        throw new Error('the OpenCode pin version must be x.y.z');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(pin.asset)) {
        throw new Error('the OpenCode pin asset must be a .tar.gz file name');
    }
    if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
        throw new Error('the OpenCode pin sha256 must be 64 lowercase hex digits');
    }
    const url = `${OPENCODE_RELEASES}/v${pin.version}/${pin.asset}`;
    if (pin.url !== url) {
        throw new Error(`the OpenCode pin url must be ${url}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pin.fetched)) {
        throw new Error('the OpenCode pin fetched date must be YYYY-MM-DD');
    }
    return pin;
}

/**
 * The coding Dockerfile's defaults: `ARG OPENCODE_VERSION=…` and the asset
 * named at the end of `ARG OPENCODE_URL=…`.
 */
export function dockerfileOpencode(dockerfile) {
    const version = /^ARG OPENCODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    const url = /^ARG OPENCODE_URL=(\S+)$/m.exec(dockerfile)?.[1];
    const asset = url?.split('/').pop();
    if (!version || !url || !asset) {
        throw new Error('coding.Dockerfile has no ARG OPENCODE_VERSION or OPENCODE_URL default');
    }
    return { version, url, asset };
}

/** The pin, checked against the Dockerfile it is for. */
export function checkOpencodePin(pinText, dockerfile) {
    const pin = parseOpencodePin(pinText);
    const image = dockerfileOpencode(dockerfile);
    if (pin.version !== image.version) {
        throw new Error(`the OpenCode pin is for ${pin.version}, coding.Dockerfile installs ${image.version}`);
    }
    if (pin.asset !== image.asset) {
        throw new Error(`the OpenCode pin is for ${pin.asset}, coding.Dockerfile downloads ${image.asset}`);
    }
    if (image.url.replace('${OPENCODE_VERSION}', image.version) !== pin.url) {
        throw new Error('the OpenCode pin url is not coding.Dockerfile’s');
    }
    return pin;
}
