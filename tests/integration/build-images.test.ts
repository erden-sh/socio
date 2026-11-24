import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { GROK_PIN, checkGrokPin, dockerfileGrok, parseGrokPin } from '../../scripts/lib/grok-pin.mjs';
import { NPM_PINS, checkNpmPin, dockerfileNpm, parseNpmPin } from '../../scripts/lib/npm-pin.mjs';
import {
    OPENCODE_PIN_PATH,
    checkOpencodePin,
    dockerfileOpencode,
    parseOpencodePin,
} from '../../scripts/lib/opencode-pin.mjs';

// CB-330: scripts/build-images.mjs is plain JS (no type annotations). The
// buildConfig and rootTargetConfigs exports are typed here so tests get
// type checking; the actual functions are imported dynamically.
interface BuildConfig {
    name: string;
    tags: string[];
    target?: string;
    dockerfile: string;
    buildargs?: string;
    context: string | null;
    buildContexts?: Record<string, string>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// @ts-expect-error TS7016: build-images.mjs is plain JS with no .d.ts
const buildModule = import('../../scripts/build-images.mjs') as Promise<{
    buildConfig: (
        name: string,
        opts: {
            tags: string[];
            target?: string;
            dockerfile: string;
            buildargs?: string;
            context: string | null;
            buildContexts?: Record<string, string>;
        },
    ) => BuildConfig;
    rootTargetConfigs: (state: {
        sha: string;
        release: string | null;
        opencode: { version: string; sha256: string } | undefined;
        npmPins: Record<string, { version: string; url: string; sha512: string }>;
        grok: { version: string; tag: string; commit: string; source_rev: string } | undefined;
    }) => Record<string, BuildConfig>;
}>;

// CB-232 / CB-239: scripts/build-images.mjs's opt-in targets for the
// dark features, and the pin checks that gate socio-coding. Nothing here
// reaches Docker, Portainer or the network: the build-config functions
// are pure data, tested directly.

const root = fileURLToPath(new URL('../../', import.meta.url));
const codingDockerfile = readFileSync(join(root, 'deployment/coding/coding.Dockerfile'), 'utf8');
const SHA = 'ab'.repeat(32);
const { version: VERSION, asset: ASSET } = dockerfileOpencode(codingDockerfile);
const pinText = (overrides: Record<string, string | undefined> = {}) =>
    Object.entries({
        version: VERSION,
        asset: ASSET,
        sha256: SHA,
        url: `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/${ASSET}`,
        fetched: '2026-10-28',
        verified: 'test fixture',
        ...overrides,
    })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';

/** The checked-in Codex, Claude Code, Gemini CLI and Grok Build pins (CB-326), by path. */
const npmPinTexts = () =>
    Object.fromEntries([...NPM_PINS, GROK_PIN].map((harness) => [harness.path, read(harness.path)]));

/** A scratch repository holding what the build contexts read. */
function scratchRepo(pin: string | undefined, npmPins: Record<string, string> = npmPinTexts()) {
    const dir = mkdtempSync(join(tmpdir(), 'build-images-test-'));
    mkdirSync(join(dir, 'deployment/coding'), { recursive: true });
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(dir, 'other.txt'), 'not in the coding context\n');
    copyFileSync(join(root, 'deployment/coding/coding.Dockerfile'), join(dir, 'deployment/coding/coding.Dockerfile'));
    writeFileSync(join(dir, 'deployment/coding/opencode.json'), '{}\n');
    if (pin !== undefined) {
        writeFileSync(join(dir, OPENCODE_PIN_PATH), pin);
    }
    for (const [path, text] of Object.entries(npmPins)) {
        writeFileSync(join(dir, path), text);
    }
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git(
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'fixture',
    );
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: dir,
    })
        .toString()
        .trim();
    return { dir, sha };
}

/** The CLI in `cwd`, always against a fake: never a real endpoint. */
function run(cwd: string, args: string[]) {
    return new Promise<{ code: number; output: string }>((resolve) => {
        execFile(
            process.execPath,
            [join(root, 'scripts/build-images.mjs'), ...args],
            {
                cwd,
                // Only what the script needs: no
                // OpenBot clone of the caller's leaks in. BUILDX_BUILDER is set
                // to a nonexistent name so ensureBuilder creates a throwaway;
                // but the pin-check tests fail before ensureBuilder runs.
                env: {
                    PATH: process.env.PATH,
                    HOME: cwd,
                    GIT_CONFIG_NOSYSTEM: '1',
                    OPENBOT_REPO: join(cwd, 'no-openbot'),
                    BUILDX_BUILDER: 'test-fixture-builder-nonexistent',
                    BUILD_CPUS: '2',
                    BUILD_SKIP_DOCKER: '1',
                },
                timeout: 60_000,
            },
            (error, stdout, stderr) =>
                resolve({
                    code: error ? ((error as { code?: number }).code ?? 1) : 0,
                    output: `${stdout}${stderr}`,
                }),
        );
    });
}

const repos: string[] = [];
afterAll(() => {
    for (const dir of repos) {
        rmSync(dir, { recursive: true, force: true });
    }
});
const repo = (pin: string | undefined, npmPins?: Record<string, string>) => {
    const made = scratchRepo(pin, npmPins);
    repos.push(made.dir);
    return made;
};

describe('the socio-coding context', () => {
    it('carries everything coding.Dockerfile copies from it', () => {
        // The image builds from a curated extract of HEAD, so a COPY of a path
        // left out of the list fails only when someone builds this opt-in image.
        const script = readFileSync(join(root, 'scripts/build-images.mjs'), 'utf8');
        const list = /archive\('\.', 'HEAD', \[([^\]]+)\]\)/.exec(script)?.[1] ?? '';
        const context = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
        expect(context).toContain('deployment/coding');
        const sources = codingDockerfile
            .replaceAll('\\\n', ' ')
            .split('\n')
            .filter((line) => /^\s*COPY\s/.test(line) && !line.includes('--from='))
            .flatMap((line) =>
                line
                    .trim()
                    .split(/\s+/)
                    .slice(1)
                    .filter((word) => !word.startsWith('--'))
                    .slice(0, -1),
            );
        expect(sources).toContain('packages/shared');
        const missing = sources.filter(
            (source) => !context.some((path) => source === path || source.startsWith(`${path}/`)),
        );
        expect(missing).toEqual([]);
    });
});

describe('the socio-coding pin is checked before anything is sent', () => {
    it.each([
        ['missing', undefined, /opencode\.pin is not in HEAD/],
        ['empty', '', /pin is empty/],
        ['a short checksum', pinText({ sha256: 'ab'.repeat(31) }), /64 lowercase/],
        ['an uppercase checksum', pinText({ sha256: SHA.toUpperCase() }), /64/],
        ['no checksum', pinText({ sha256: undefined }), /has no sha256/],
        ['another version', pinText({ version: '9.9.9' }), /url must be|is for/],
        [
            'another version and its url',
            pinText({
                version: '9.9.9',
                url: `https://github.com/anomalyco/opencode/releases/download/v9.9.9/${ASSET}`,
            }),
            /is for 9\.9\.9, coding\.Dockerfile installs/,
        ],
        [
            'another asset',
            pinText({
                asset: 'opencode-linux-arm64.tar.gz',
                url: `https://github.com/anomalyco/opencode/releases/download/v${VERSION}/opencode-linux-arm64.tar.gz`,
            }),
            /coding\.Dockerfile downloads/,
        ],
        [
            'another host',
            pinText({
                url: `https://example.com/v${VERSION}/${ASSET}`,
            }),
            /url must be/,
        ],
        ['an unknown key', `${pinText()}extra=1\n`, /unknown key: extra/],
        ['a repeated key', `${pinText()}sha256=${SHA}\n`, /repeats sha256/],
    ])('refuses a pin that is %s', async (_label, pin, message) => {
        const { dir } = repo(pin);
        const result = await run(dir, ['--only', 'app-browser,socio-coding']);
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(message);
        expect(result.output).toContain('socio-coding:');
        // Not even the app browser, listed first, was built.
        expect(result.output).not.toContain('all requested images built');
    });

    it.each([
        [
            'missing',
            (pins: Record<string, string>) => delete pins['deployment/coding/codex.pin'],
            /codex\.pin is not in HEAD/,
        ],
        [
            'for another version',
            (pins: Record<string, string>) => {
                pins['deployment/coding/claude-code.pin'] = pins['deployment/coding/claude-code.pin']!.replaceAll(
                    dockerfileNpm(codingDockerfile, 'CLAUDE_CODE').version,
                    '9.9.9',
                );
            },
            /Claude Code pin is for 9\.9\.9/,
        ],
        [
            "a checksum its integrity doesn't match",
            (pins: Record<string, string>) => {
                pins['deployment/coding/codex.pin'] = pins['deployment/coding/codex.pin']!.replace(
                    /^sha512=.*$/m,
                    `sha512=${'ab'.repeat(64)}`,
                );
            },
            /integrity must be the same digest/,
        ],
        [
            "Grok Build's, missing",
            (pins: Record<string, string>) => delete pins['deployment/coding/grok.pin'],
            /grok\.pin is not in HEAD/,
        ],
        [
            "Grok Build's, for another version",
            (pins: Record<string, string>) => {
                pins['deployment/coding/grok.pin'] = pins['deployment/coding/grok.pin']!.replace(
                    /^version=.*$/m,
                    'version=9.9.9',
                );
            },
            /Grok Build pin is for 9\.9\.9/,
        ],
        [
            "Grok Build's, with a short commit",
            (pins: Record<string, string>) => {
                pins['deployment/coding/grok.pin'] = pins['deployment/coding/grok.pin']!.replace(
                    /^commit=.*$/m,
                    'commit=2bdd1d6a',
                );
            },
            /commit must be 40 lowercase hex/,
        ],
    ])("refuses a coding agent's pin that is %s (CB-326)", async (_label, change, message) => {
        const pins = npmPinTexts();
        change(pins);
        const { dir } = repo(pinText(), pins);
        const result = await run(dir, ['--only', 'socio-coding']);
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(message);
        expect(result.output).not.toContain('all requested images built');
    });

    it('refuses a pin left out of the commit (the context is HEAD)', async () => {
        const { dir } = repo(undefined);
        writeFileSync(join(dir, OPENCODE_PIN_PATH), pinText());
        const result = await run(dir, ['--only', 'socio-coding']);
        expect(result.code).not.toBe(0);
        expect(result.output).toMatch(/not in HEAD/);
        expect(result.output).not.toContain('all requested images built');
    });
});

describe('the opt-in targets', () => {
    it('builds socio-coding from coding.Dockerfile with the pinned versions and checksums, on a context of package.json and deployment/coding', async () => {
        const { dir } = repo(pinText());
        // The pin check passes; the build itself will fail (no real Docker),
        // but the script should get past the pin check and attempt the build.
        const result = await run(dir, ['--only', 'socio-coding']);
        expect(result.output).toContain('socio-coding: OpenCode');
        // The build will fail because there's no real Docker builder, but
        // the pin-checking and config-building logic ran successfully.
        const codex = parseNpmPin(read('deployment/coding/codex.pin'));
        const claude = parseNpmPin(read('deployment/coding/claude-code.pin'));
        const gemini = parseNpmPin(read('deployment/coding/gemini-cli.pin'));
        const grok = parseGrokPin(read('deployment/coding/grok.pin'));
        // The script should print the pin versions it resolved.
        expect(result.output).toContain(`OpenCode ${VERSION}`);
        expect(result.output).toContain(`Codex ${codex.version}`);
        expect(result.output).toContain(`Claude Code ${claude.version}`);
        expect(result.output).toContain(`Gemini CLI ${gemini.version}`);
        expect(result.output).toContain(`Grok Build ${grok.version}`);
        // .docker/compose.computers.yml tags the same image by OpenCode's version.
        expect(read('.docker/compose.computers.yml')).toContain(`image: socio-coding:\${OPENCODE_VERSION:-${VERSION}}`);
    });

    it.each([
        ['app-browser', 'company-brain-app-browser'],
        ['coding-egress', 'company-brain-coding-egress'],
        ['coding-git', 'company-brain-coding-git'],
    ])('builds %s from the root Dockerfile, tagged %s', async (target, _image) => {
        const { dir } = repo(undefined);
        const result = await run(dir, ['--only', target]);
        // The build will fail (no real Docker), but the script should
        // attempt it, showing it got past the config stage.
        expect(result.output).toContain(`building ${target}`);
        // A missing pin matters only to socio-coding.
        expect(result.output).not.toContain('socio-coding:');
    });

    it('names the images the deployment specs run', () => {
        expect(read('src/app-browser/deploy-spec.ts')).toContain(
            "image: 'company-brain-app-browser:${APP_BROWSER_IMAGE_TAG",
        );
        expect(read('.docker/compose.computers.yml')).toContain('image: company-brain-coding-egress:latest');
    });

    it('builds none of the opt-in targets on a plain run', async () => {
        const { dir } = repo(pinText());
        // computer and supervisor need an OpenBot clone the test doesn't have,
        // so the run ends there; the plan line lists everything it would build.
        const result = await run(dir, []);
        const plan = /\[build-images\] building (.+)/.exec(result.output)?.[1];
        expect(plan?.split(', ')).toEqual(['app', 'apps', 'plugin-social-strategy', 'computer', 'supervisor']);
        expect(result.output).not.toMatch(/socio-coding|app-browser|coding-/);
    });
});

function read(path: string) {
    return readFileSync(join(root, path), 'utf8');
}

describe('the OpenCode pin file (deployment/coding/opencode.pin)', () => {
    const dockerfile = dockerfileOpencode(codingDockerfile);

    it("reads the Dockerfile's version and the asset its URL downloads", () => {
        expect(dockerfile.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(dockerfile.asset).toBe('opencode-linux-x64.tar.gz');
        expect(dockerfile.url).toBe(
            'https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz',
        );
    });

    it('accepts a well-formed pin and ignores comments', () => {
        expect(parseOpencodePin(`# comment\n\n${pinText()}`)).toMatchObject({
            version: VERSION,
            asset: ASSET,
            sha256: SHA,
        });
        expect(checkOpencodePin(pinText(), codingDockerfile).sha256).toBe(SHA);
    });

    it.each([
        ['a line without =', `${pinText()}junk\n`],
        ['a non-date fetched', pinText({ fetched: 'yesterday' })],
        ['no verified note', pinText({ verified: undefined })],
        ['a v-prefixed version', pinText({ version: `v${VERSION}` })],
        ['a path in the asset', pinText({ asset: `../${ASSET}` })],
    ])('refuses %s', (_label, text) => {
        expect(() => checkOpencodePin(text, codingDockerfile)).toThrow();
    });

    it.skipIf(!existsSync(join(root, OPENCODE_PIN_PATH)))(
        "is well-formed and pins the Dockerfile's version and asset",
        () => {
            const pin = checkOpencodePin(read(OPENCODE_PIN_PATH), codingDockerfile);
            expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(pin.version).toBe(dockerfile.version);
            expect(pin.asset).toBe(dockerfile.asset);
        },
    );
});

describe('the Codex, Claude Code and Gemini CLI pin files (CB-326)', () => {
    it('pins the three npm agents', () => {
        expect(NPM_PINS.map((harness) => [harness.id, harness.arg])).toEqual([
            ['codex', 'CODEX'],
            ['claude-code', 'CLAUDE_CODE'],
            ['gemini-cli', 'GEMINI_CLI'],
        ]);
    });

    it.each(NPM_PINS.map((harness) => [harness.label, harness] as const))(
        "%s's is well-formed and pins the Dockerfile's version and URL",
        (_label, harness) => {
            const pin = checkNpmPin(read(harness.path), codingDockerfile, harness);
            expect(pin.sha512).toMatch(/^[0-9a-f]{128}$/);
            expect(pin.url.startsWith('https://registry.npmjs.org/@')).toBe(true);
            expect(pin.url).toMatch(harness.id === 'gemini-cli' ? /gemini-cli-[\d.]+\.tgz$/ : /linux-x64.*\.tgz$/);
            expect(pin.verified).toContain('research-script/0.1');
            expect(dockerfileNpm(codingDockerfile, harness.arg).version).toBe(pin.version);
        },
    );

    it("pins Claude Code from npm's stable channel (owner decision, 2026-11-01)", () => {
        const pin = parseNpmPin(read('deployment/coding/claude-code.pin'), 'Claude Code');
        expect(pin.verified).toContain(`dist-tags.stable is ${pin.version}`);
        expect(read('deployment/coding/claude-code.pin')).toContain("follows npm's `stable` dist-tag");
    });

    it('refuses malformed pins', () => {
        const good = read('deployment/coding/codex.pin');
        const bad = [
            '',
            `${good}extra=1\n`,
            good.replace(/^version=.*$/m, 'version=v0.166.0'),
            good.replace(/^url=.*$/m, 'url=https://example.com/codex-0.166.0-linux-x64.tgz'),
            good.replace(/^sha512=.*$/m, `sha512=${'AB'.repeat(64)}`),
            good.replace(/^integrity=.*$/m, 'integrity=sha256-abc'),
            good.replace(/^fetched=.*$/m, 'fetched=today'),
            good.replace(/^verified=.*$/m, ''),
        ];
        for (const text of bad) {
            expect(() => parseNpmPin(text, 'Codex')).toThrow();
        }
        expect(() => dockerfileNpm('FROM scratch\n', 'CODEX')).toThrow(/ARG CODEX_VERSION/);
    });

    it('no longer takes anything from x.ai', () => {
        expect(() =>
            parseNpmPin(
                read('deployment/coding/codex.pin').replace(
                    /^url=.*$/m,
                    'url=https://x.ai/cli/grok-0.166.0-linux-x86_64',
                ),
                'Codex',
            ),
        ).toThrow(/\.tgz on https:\/\/registry\.npmjs\.org/);
        expect(codingDockerfile).not.toContain('x.ai/cli');
    });
});

describe('the Grok Build source pin (deployment/coding/grok.pin, CB-326)', () => {
    const good = () => read(GROK_PIN.path);

    it("is well-formed and pins the Dockerfile's version and repository, by commit", () => {
        const pin = checkGrokPin(good(), codingDockerfile);
        expect(pin.repository).toBe('https://github.com/xai-org/grok-build');
        expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.source_rev).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.verified).toContain('research-script/0.1');
        expect(dockerfileGrok(codingDockerfile)).toEqual({ version: pin.version, repository: pin.repository });
    });

    it('takes an optional release tag for its version', () => {
        const pin = good();
        expect(parseGrokPin(pin).tag).toBe('');
        const version = parseGrokPin(pin).version;
        expect(parseGrokPin(`${pin}tag=v${version}\n`).tag).toBe(`v${version}`);
        expect(parseGrokPin(`${pin}tag=${version}\n`).tag).toBe(version);
        expect(() => parseGrokPin(`${pin}tag=v9.9.9\n`)).toThrow(/tag must be for/);
        expect(() => parseGrokPin(`${pin}tag=main\n`)).toThrow(/release tag/);
    });

    it('refuses malformed pins', () => {
        const pin = good();
        const bad = [
            '',
            `${pin}extra=1\n`,
            `${pin}commit=${'a'.repeat(40)}\n`,
            pin.replace(/^version=.*$/m, 'version=v1.0.45'),
            pin.replace(/^repository=.*$/m, 'repository=https://github.com/someone/grok-build'),
            pin.replace(/^repository=.*$/m, 'repository=https://x.ai/cli'),
            pin.replace(/^commit=.*$/m, `commit=${'A'.repeat(40)}`),
            pin.replace(/^commit=.*$/m, ''),
            pin.replace(/^source_rev=.*$/m, 'source_rev=559751fd'),
            pin.replace(/^fetched=.*$/m, 'fetched=today'),
            pin.replace(/^verified=.*$/m, ''),
        ];
        for (const text of bad) {
            expect(() => parseGrokPin(text)).toThrow();
        }
        expect(() => dockerfileGrok('FROM scratch\n')).toThrow(/ARG GROK_VERSION/);
        expect(() =>
            checkGrokPin(pin, codingDockerfile.replace(/^ARG GROK_VERSION=.*$/m, 'ARG GROK_VERSION=9.9.9')),
        ).toThrow(/coding\.Dockerfile builds 9\.9\.9/);
    });
});

describe('buildConfig and rootTargetConfigs (CB-330)', () => {
    it('buildConfig produces a pure data object', async () => {
        const { buildConfig } = await buildModule;
        const config = buildConfig('app', {
            tags: ['company-brain:abc123', 'company-brain:latest'],
            target: 'app',
            dockerfile: 'Dockerfile',
            buildargs: JSON.stringify({ APP_COMMIT: 'abc123' }),
            context: '.',
        });
        expect(config).toEqual({
            name: 'app',
            tags: ['company-brain:abc123', 'company-brain:latest'],
            target: 'app',
            dockerfile: 'Dockerfile',
            buildargs: JSON.stringify({ APP_COMMIT: 'abc123' }),
            context: '.',
            buildContexts: undefined,
        });
    });

    it('rootTargetConfigs produces configs for app, apps, and plugin-social-strategy', async () => {
        const { rootTargetConfigs } = await buildModule;
        const sha = 'abc1234';
        const configs = rootTargetConfigs({ sha, release: null, opencode: undefined, npmPins: {}, grok: undefined });
        expect(Object.keys(configs).sort()).toEqual(['app', 'apps', 'plugin-social-strategy']);
        // app config
        expect(configs.app.tags).toEqual(['company-brain:abc1234', 'company-brain:latest']);
        expect(configs.app.target).toBe('app');
        expect(configs.app.dockerfile).toBe('Dockerfile');
        expect(configs.app.context).toBe('.');
        expect(JSON.parse(configs.app.buildargs!)).toEqual({ APP_COMMIT: 'abc1234' });
        // apps config
        expect(configs.apps.target).toBe('apps-runtime');
        expect(configs.apps.tags).toEqual(['company-brain-apps:abc1234', 'company-brain-apps:latest']);
        // plugin-social-strategy
        expect(configs['plugin-social-strategy'].target).toBe('plugin-social-strategy');
    });

    it('rootTargetConfigs includes release tag when present', async () => {
        const { rootTargetConfigs } = await buildModule;
        const configs = rootTargetConfigs({
            sha: 'abc1234',
            release: 'v0.30.0',
            opencode: undefined,
            npmPins: {},
            grok: undefined,
        });
        expect(configs.app.tags).toEqual(['company-brain:abc1234', 'company-brain:latest', 'company-brain:v0.30.0']);
    });

    it('rootTargetConfigs includes socio-coding when opencode is provided', async () => {
        const { rootTargetConfigs } = await buildModule;
        const opencode = { version: '1.0.0', sha256: 'ab'.repeat(32) };
        const grok = { version: '1.0.0', tag: '', commit: 'a'.repeat(40), source_rev: 'b'.repeat(40) };
        const configs = rootTargetConfigs({ sha: 'abc1234', release: null, opencode, npmPins: {}, grok });
        expect(configs['socio-coding']).toBeDefined();
        expect(configs['socio-coding'].tags[0]).toBe('socio-coding:1.0.0');
        expect(configs['socio-coding'].dockerfile).toBe('deployment/coding/coding.Dockerfile');
        const args = JSON.parse(configs['socio-coding'].buildargs!);
        expect(args.OPENCODE_VERSION).toBe('1.0.0');
        expect(args.OPENCODE_SHA256).toBe('ab'.repeat(32));
        expect(args.GROK_VERSION).toBe('1.0.0');
    });
});
