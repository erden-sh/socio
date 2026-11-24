// The Grok Build source pin of the socio-coding image (CB-326;
// built from source since the owner's decision of 2026-11-01):
// deployment/coding/grok.pin names one commit of xAI's Apache-2.0 source
// (github.com/xai-org/grok-build), which coding.Dockerfile's `grok-build`
// stage fetches by that commit, checks and compiles; only the binary goes
// into the image. xAI's downloadable binary (x.ai/cli), which comes with no
// checksum, is no longer used. scripts/build-images.mjs passes the pin to
// coding.Dockerfile and refuses to build without a well-formed pin that
// matches the Dockerfile's defaults; tests/integration/build-images.test.ts checks the
// checked-in file.
//
// The file is `key=value` lines; blank lines and `#` comments are ignored:
//
//   version=<x.y.z>              crates/codegen/xai-grok-version's version at
//                                that commit (the binary's `--version`)
//   repository=https://github.com/xai-org/grok-build
//   tag=<release tag>            optional: xAI's release tag for the commit;
//                                the build checks it names the commit
//   commit=<40 lowercase hex>    the source commit, fetched by its id
//   source_rev=<40 lowercase hex>
//                                the tree's SOURCE_REV file (the xAI monorepo
//                                commit it was synced from), checked too
//   fetched=<YYYY-MM-DD>         when the pin was taken
//   verified=<one line>          how it was checked
//
// Every key but `tag` is required once; any other key is refused.

export const GROK_PIN = {
    id: 'grok',
    label: 'Grok Build',
    path: 'deployment/coding/grok.pin',
    arg: 'GROK',
};
export const GROK_REPOSITORY = 'https://github.com/xai-org/grok-build';
const REQUIRED = ['version', 'repository', 'commit', 'source_rev', 'fetched', 'verified'];
const KEYS = [...REQUIRED, 'tag'];
const SHA1 = /^[0-9a-f]{40}$/;

/** The pin as data, or an Error naming what is wrong. */
export function parseGrokPin(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('the Grok Build pin is empty');
    }
    const pin = {};
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const at = line.indexOf('=');
        if (at <= 0) {
            throw new Error(`the Grok Build pin has a bad line: ${line}`);
        }
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (!KEYS.includes(key)) {
            throw new Error(`the Grok Build pin has an unknown key: ${key}`);
        }
        if (Object.hasOwn(pin, key)) {
            throw new Error(`the Grok Build pin repeats ${key}`);
        }
        pin[key] = value;
    }
    for (const key of REQUIRED) {
        if (!pin[key]) {
            throw new Error(`the Grok Build pin has no ${key}`);
        }
    }
    if (!/^\d+\.\d+\.\d+$/.test(pin.version)) {
        throw new Error('the Grok Build pin version must be x.y.z');
    }
    if (pin.repository !== GROK_REPOSITORY) {
        throw new Error(`the Grok Build pin repository must be ${GROK_REPOSITORY}`);
    }
    if (Object.hasOwn(pin, 'tag') && !/^v?\d+\.\d+\.\d+$/.test(pin.tag)) {
        throw new Error('the Grok Build pin tag, when set, must be a release tag (x.y.z or vx.y.z)');
    }
    if (pin.tag && pin.tag.replace(/^v/, '') !== pin.version) {
        throw new Error(`the Grok Build pin tag must be for ${pin.version}`);
    }
    if (!SHA1.test(pin.commit)) {
        throw new Error('the Grok Build pin commit must be 40 lowercase hex digits');
    }
    if (!SHA1.test(pin.source_rev)) {
        throw new Error('the Grok Build pin source_rev must be 40 lowercase hex digits');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pin.fetched)) {
        throw new Error('the Grok Build pin fetched date must be YYYY-MM-DD');
    }
    return { tag: '', ...pin };
}

/** The coding Dockerfile's defaults: `ARG GROK_VERSION=…` and `ARG GROK_REPOSITORY=…`. */
export function dockerfileGrok(dockerfile) {
    const version = /^ARG GROK_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    const repository = /^ARG GROK_REPOSITORY=(\S+)$/m.exec(dockerfile)?.[1];
    if (!version || !repository) {
        throw new Error('coding.Dockerfile has no ARG GROK_VERSION or GROK_REPOSITORY default');
    }
    return { version, repository };
}

/** The pin, checked against the Dockerfile it is for. */
export function checkGrokPin(pinText, dockerfile) {
    const pin = parseGrokPin(pinText);
    const image = dockerfileGrok(dockerfile);
    if (pin.version !== image.version) {
        throw new Error(`the Grok Build pin is for ${pin.version}, coding.Dockerfile builds ${image.version}`);
    }
    if (pin.repository !== image.repository) {
        throw new Error('the Grok Build pin repository is not coding.Dockerfile’s');
    }
    return pin;
}
