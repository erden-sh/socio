#!/usr/bin/env node
// Builds Socio's images with BuildKit on the Docker host (no registry push):
//
//   node scripts/build-images.mjs [--only app,apps,computer,supervisor,updater]
//
// A plain run builds app, apps, plugin-social-strategy, computer and
// supervisor. The opt-in targets below are built only when named in
// --only: the updater, and the dark features of CB-232 and CB-239
// (app-browser, socio-coding, coding-egress, coding-git), which no default
// stack runs until an operator turns them on (deployment/actors/README.md).
//
// - app: target `app`, tagged company-brain:<short-sha>, :latest, and
//   :<release> (v0.6.1) when HEAD is a release's tag (CB-165).
//   The build gets the commit as APP_COMMIT, for the version the app shows.
// - apps: target `apps-runtime` (the workspace app runtime and the apps'
//   egress proxy), tagged company-brain-apps:<short-sha> and :latest;
//   the stack runs it with APPS_IMAGE_TAG.
// - plugin-social-strategy: target `plugin-social-strategy`, tagged
//   company-brain-plugin-social-strategy.
// - computer / supervisor: the pinned OpenBot revision, from a local clone
//   (OPENBOT_REPO), tagged as in .docker/compose.computers.yml. The computer is built
//   twice: upstream as is, then deployment/computers/computer.Dockerfile on top.
// - updater (opt-in): target `updater`, tagged company-brain-updater (CB-259).
// - app-browser (opt-in, CB-232): target `app-browser`, tagged
//   company-brain-app-browser (APP_BROWSER_IMAGE_TAG in a swarm overlay).
// - coding-egress and coding-git (opt-in, CB-239): targets `coding-egress` and
//   `coding-git`, tagged company-brain-coding-egress and company-brain-coding-git.
// - socio-coding (opt-in, CB-239): deployment/coding/coding.Dockerfile
//   on a curated context of HEAD (the list where it is built),
//   with OPENCODE_VERSION and OPENCODE_SHA256 from HEAD's
//   deployment/coding/opencode.pin, tagged socio-coding:<OpenCode version>
//   (as .docker/compose.computers.yml) and socio-coding:<short-sha> and :latest. It
//   refuses before any request when the pin is missing, malformed or not
//   coding.Dockerfile's version and asset (scripts/lib/opencode-pin.mjs).
//   Codex and Claude Code (CB-326) come the same way: CODEX_VERSION,
//   CODEX_URL, CODEX_SHA512, CLAUDE_CODE_VERSION, CLAUDE_CODE_URL and
//   CLAUDE_CODE_SHA512 from HEAD's deployment/coding/codex.pin and
//   claude-code.pin, and (CB-326) GEMINI_CLI_* from gemini-cli.pin,
//   each checked against coding.Dockerfile's defaults (scripts/lib/
//   npm-pin.mjs); Grok Build, built from source in the image, gets
//   GROK_VERSION, GROK_TAG, GROK_COMMIT and GROK_SOURCE_REV from grok.pin
//   (scripts/lib/grok-pin.mjs).
//
// BuildKit is used (CB-330): the Dockerfile's --mount=type=cache directives
// need it, and the docker-container builder is CPU-limited so a build on a
// host that also runs Socio doesn't starve it. The builder is created on
// first use and its CPU limit is enforced on every run.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GROK_PIN, checkGrokPin } from './lib/grok-pin.mjs';
import { NPM_PINS, checkNpmPin } from './lib/npm-pin.mjs';
import { OPENCODE_PIN_PATH, checkOpencodePin } from './lib/opencode-pin.mjs';

const OPENBOT_REV = 'b6932d31a8d6e7896c15139dfc27a6c6911deb27';
// The BuildKit builder: a docker-container driver so its CPU can be limited
// independently of the dockerd. Images are loaded into the local daemon
// (never pushed; release images are built by .github/workflows/release-images.yml).
const builderName = process.env.BUILDX_BUILDER ?? 'socio';
// Hard CPU limit on the builder container so a build can't monopolize the
// host's CPUs (CB-330). Set BUILD_CPUS to fit your machine.
const buildCpus = process.env.BUILD_CPUS ?? '8';
// A local checkout of OpenBot (https://github.com/CopilotKit/OpenBot) at
// OPENBOT_REV, for the supervisor and computer images.
const openbot = process.env.OPENBOT_REPO ?? '../OpenBot';
const only = process.argv
    .join(' ')
    .match(/--only\s+(\S+)/)?.[1]
    ?.split(',');
const step = (text) => console.log(`[build-images] ${text}`);

/** The build configuration for one target (pure data, testable). */
export function buildConfig(name, { tags, target, dockerfile, buildargs, context, buildContexts }) {
    return { name, tags, target, dockerfile, buildargs, context, buildContexts };
}

/** Ensure the BuildKit builder exists, is bootstrapped, and is CPU-limited. */
function ensureBuilder() {
    // In test mode (BUILD_SKIP_DOCKER=1), skip builder creation entirely.
    // The pin-check tests fail before this runs; the build tests expect the
    // script to proceed past config and fail at the build step.
    if (process.env.BUILD_SKIP_DOCKER === '1') {
        step('build: BUILD_SKIP_DOCKER=1, skipping builder setup');
        return;
    }
    // Create the builder if it doesn't exist.
    try {
        execFileSync('docker', ['buildx', 'inspect', builderName], { stdio: 'ignore' });
    } catch {
        step(`creating BuildKit builder '${builderName}'`);
        execFileSync(
            'docker',
            [
                'buildx',
                'create',
                '--name',
                builderName,
                '--driver',
                'docker-container',
                '--driver-opt',
                'network=host',
                '--buildkitd-flags',
                '--allow-insecure-entitlement=network.host',
                '--use',
            ],
            { stdio: 'inherit' },
        );
    }
    // Bootstrap (starts the container if not running).
    execFileSync('docker', ['buildx', 'inspect', builderName, '--bootstrap'], { stdio: 'ignore' });
    // Enforce the CPU limit on the builder container (idempotent: docker
    // update --cpus on an already-limited container is a no-op). The limit
    // is lost when the container is recreated, so we set it every run.
    const ctr = execFileSync(
        'docker',
        ['ps', '--filter', `name=buildx_buildkit_${builderName}`, '--format', '{{.Names}}'],
        { encoding: 'utf8' },
    ).trim();
    if (ctr) {
        execFileSync('docker', ['update', '--cpus', buildCpus, ctr], { stdio: 'ignore' });
        step(`builder '${builderName}' CPU limit: ${buildCpus} cores (${ctr})`);
    }
}

/** Run a BuildKit build via `docker buildx build`. */
function build(name, config) {
    step(`${name}: building ${config.tags.join(', ')} with BuildKit`);
    if (process.env.BUILD_SKIP_DOCKER === '1') {
        step(`${name}: BUILD_SKIP_DOCKER=1, skipping actual build`);
        return;
    }
    const args = ['buildx', 'build', '--builder', builderName, '--progress', 'plain', '--load'];
    if (config.target) {
        args.push('--target', config.target);
    }
    args.push('--file', config.dockerfile);
    for (const tag of config.tags) {
        args.push('--tag', tag);
    }
    if (config.buildargs) {
        const parsed = JSON.parse(config.buildargs);
        for (const [key, value] of Object.entries(parsed)) {
            args.push('--build-arg', `${key}=${value}`);
        }
    }
    if (process.env.BUILD_NOCACHE === '1') {
        args.push('--no-cache');
    }
    // Named build contexts (e.g. openbot=<path> for the supervisor).
    if (config.buildContexts) {
        for (const [name_, path] of Object.entries(config.buildContexts)) {
            args.push('--build-context', `${name_}=${path}`);
        }
    }
    args.push(config.context);
    // Stream output to stdout; buildx --progress=plain emits step lines.
    execFileSync('docker', args, { stdio: 'inherit' });
    step(`${name}: done`);
}

const archive = (cwd, rev, paths = []) =>
    execFileSync('git', ['archive', '--format=tar', rev, ...(paths.length ? ['--', ...paths] : [])], {
        cwd,
        maxBuffer: 1 << 30,
    });

const sha = (() => {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
    } catch {
        // Not a git repo (e.g. CI strips .git for security). The sha is only
        // needed for the CLI build path; tests call rootTargetConfigs with
        // their own sha. Use a placeholder so the module loads.
        return 'unknown';
    }
})();
// The release tag on HEAD (`pnpm run release`), if there is one: the app
// and apps images get it as a tag too.
let release = null;
try {
    release = execFileSync('git', ['describe', '--tags', '--exact-match', '--match', 'v[0-9]*', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
    })
        .toString()
        .trim();
} catch {
    step('HEAD has no release tag: images get the commit tag only');
}
const tagsOf = (image) => [`${image}:${sha}`, `${image}:latest`, ...(release ? [`${image}:${release}`] : [])];
// The same for the three targets, so they share the build stage's cache.
const buildargs = JSON.stringify({ APP_COMMIT: sha });
const dirty = (() => {
    try {
        return execFileSync('git', ['status', '--porcelain']).toString().trim();
    } catch {
        return '';
    }
})();
if (dirty) {
    step('warning: uncommitted changes are not included (git archive HEAD)');
}

// The build context is the working directory (not a git archive tar), so
// .dockerignore applies: tests/, docs/, marketing/, .git/ are stripped,
// shrinking the context from ~34 MB to ~5 MB. The Dockerfile's COPY . .
// still gets what it needs.
const rootContext = '.';

/**
 * Compute the pure build configs for the root-Dockerfile targets (those that
 * share the same context and Dockerfile, differing only in --target). The
 * computer and supervisor targets need staging (OpenBot tree) and are built
 * inline; socio-coding needs a curated context and pin validation. Exported
 * for tests (tests/integration/build-images.test.ts) to assert tags, targets, and args
 * without running Docker.
 */
export function rootTargetConfigs({ sha, release, opencode, npmPins, grok }) {
    const tags = (image) => [`${image}:${sha}`, `${image}:latest`, ...(release ? [`${image}:${release}`] : [])];
    const args = JSON.stringify({ APP_COMMIT: sha });
    const base = { dockerfile: 'Dockerfile', buildargs: args, context: '.' };
    const configs = {
        app: buildConfig('app', { ...base, tags: tags('company-brain'), target: 'app' }),
        apps: buildConfig('apps', { ...base, tags: tags('company-brain-apps'), target: 'apps-runtime' }),
        'plugin-social-strategy': buildConfig('plugin-social-strategy', {
            ...base,
            tags: tags('company-brain-plugin-social-strategy'),
            target: 'plugin-social-strategy',
        }),
    };
    // Opt-in root-Dockerfile targets.
    if (opencode) {
        configs['socio-coding'] = buildConfig('socio-coding', {
            tags: [`socio-coding:${opencode.version}`, ...tags('socio-coding')],
            dockerfile: 'deployment/coding/coding.Dockerfile',
            buildargs: JSON.stringify({
                OPENCODE_VERSION: opencode.version,
                OPENCODE_SHA256: opencode.sha256,
                ...Object.fromEntries(
                    Object.entries(npmPins).flatMap(([arg, pin]) => [
                        [`${arg}_VERSION`, pin.version],
                        [`${arg}_URL`, pin.url],
                        [`${arg}_SHA512`, pin.sha512],
                    ]),
                ),
                GROK_VERSION: grok.version,
                GROK_TAG: grok.tag,
                GROK_COMMIT: grok.commit,
                GROK_SOURCE_REV: grok.source_rev,
            }),
            // socio-coding uses a curated minimal context, not the full tree.
            context: null, // set at build time from a temp dir
        });
    }
    return configs;
}

const targets = {
    app: () => {
        build(
            'app',
            buildConfig('app', {
                tags: tagsOf('company-brain'),
                target: 'app',
                dockerfile: 'Dockerfile',
                buildargs,
                context: rootContext,
            }),
        );
    },
    // The workspace app runtime and the apps' egress proxy.
    apps: () => {
        build(
            'apps',
            buildConfig('apps', {
                tags: tagsOf('company-brain-apps'),
                target: 'apps-runtime',
                dockerfile: 'Dockerfile',
                buildargs,
                context: rootContext,
            }),
        );
    },
    'plugin-social-strategy': () => {
        build(
            'plugin-social-strategy',
            buildConfig('plugin-social-strategy', {
                tags: tagsOf('company-brain-plugin-social-strategy'),
                target: 'plugin-social-strategy',
                dockerfile: 'Dockerfile',
                buildargs,
                context: rootContext,
            }),
        );
    },
    computer: async () => {
        // Stage the OpenBot tree as a build context.
        const openbotDir = mkdtempSync(join(tmpdir(), 'brain-openbot-'));
        try {
            execFileSync('tar', ['-x', '-C', openbotDir], {
                input: archive(openbot, OPENBOT_REV),
                maxBuffer: 1 << 30,
            });
            build(
                'computer',
                buildConfig('computer', {
                    tags: ['company-brain-computer:b6932d3'],
                    dockerfile: 'agent-computer/Dockerfile',
                    context: openbotDir,
                }),
            );
            // The browser time limits (CB-125), on top of the image just built.
            const limitsDir = mkdtempSync(join(tmpdir(), 'brain-computer-'));
            try {
                cpSync('deployment/computers', join(limitsDir, 'deployment/computers'), {
                    recursive: true,
                });
                build(
                    'computer limits',
                    buildConfig('computer limits', {
                        tags: ['company-brain-computer:b6932d3-isolated-v2'],
                        dockerfile: 'deployment/computers/computer.Dockerfile',
                        context: limitsDir,
                    }),
                );
            } finally {
                rmSync(limitsDir, { recursive: true, force: true });
            }
        } finally {
            rmSync(openbotDir, { recursive: true, force: true });
        }
    },
    supervisor: () => {
        // Stage the OpenBot tree as a named build context. BuildKit supports
        // COPY --from=openbot via --build-context, so the Dockerfile is used
        // as-is (no rewriting hack needed, unlike the classic builder).
        const openbotDir = mkdtempSync(join(tmpdir(), 'brain-openbot-'));
        try {
            execFileSync('tar', ['-x', '-C', openbotDir], {
                input: archive(openbot, OPENBOT_REV),
                maxBuffer: 1 << 30,
            });
            // The supervisor Dockerfile COPYs from deployment/computers/ too,
            // so the context is the repo root and openbot is a named context.
            build(
                'supervisor',
                buildConfig('supervisor', {
                    tags: ['company-brain-supervisor:b6932d3-dot-auth-isolated-v2'],
                    dockerfile: 'deployment/computers/supervisor.Dockerfile',
                    context: rootContext,
                    buildContexts: { openbot: openbotDir },
                }),
            );
        } finally {
            rmSync(openbotDir, { recursive: true, force: true });
        }
    },
};
// Opt-in targets are built only when asked for by name (`--only <name>`),
// never by a plain build: the updater sidecar (CB-259) and the dark
// features of CB-232 and CB-239.
const optIn = new Set(['updater', 'app-browser', 'socio-coding', 'coding-egress', 'coding-git']);
targets.updater = () => {
    const config = buildConfig('updater', {
        tags: tagsOf('company-brain-updater'),
        target: 'updater',
        dockerfile: 'Dockerfile',
        buildargs,
        context: rootContext,
    });
    build('updater', config);
};
// The app browser (CB-232): delegated app sessions in sandboxed Chromium.
targets['app-browser'] = () => {
    const config = buildConfig('app-browser', {
        tags: tagsOf('company-brain-app-browser'),
        target: 'app-browser',
        dockerfile: 'Dockerfile',
        buildargs,
        context: rootContext,
    });
    build('app-browser', config);
};
// The coding sandboxes' egress proxy (CB-239).
targets['coding-egress'] = () => {
    const config = buildConfig('coding-egress', {
        tags: tagsOf('company-brain-coding-egress'),
        target: 'coding-egress',
        dockerfile: 'Dockerfile',
        buildargs,
        context: rootContext,
    });
    build('coding-egress', config);
};
// Push inspection and extraction (CB-239, CB-267).
targets['coding-git'] = () => {
    const config = buildConfig('coding-git', {
        tags: tagsOf('company-brain-coding-git'),
        target: 'coding-git',
        dockerfile: 'Dockerfile',
        buildargs,
        context: rootContext,
    });
    build('coding-git', config);
};
// The coding sandbox image (CB-239), from the pin read below.
let opencode;
/** The other harnesses' pins (CB-326), by Dockerfile ARG prefix. */
const npmPins = {};
/** Grok Build's source pin (CB-326, built from source). */
let grok;
targets['socio-coding'] = () => {
    // socio-coding uses a curated minimal context (package.json +
    // deployment/coding), not the full tree. Build it from a temp dir so
    // .dockerignore doesn't strip the coding files.
    // CB-326 step 7: the context also carries the session-host entry's
    // build inputs (src/, vendor/t3code/, tsconfig*, pnpm-lock.yaml, .npmrc)
    // so the Dockerfile's host-build stage can compile the entry and the
    // host-deps stage can install its runtime node_modules, plus patches/,
    // which pnpm-workspace.yaml's patchedDependencies names.
    const dir = mkdtempSync(join(tmpdir(), 'brain-coding-'));
    try {
        // Extract only what coding.Dockerfile needs from HEAD.
        const tar = archive('.', 'HEAD', [
            'package.json',
            'deployment/coding',
            'packages',
            'src',
            'vendor',
            'pnpm-lock.yaml',
            'pnpm-workspace.yaml',
            'patches',
            '.npmrc',
            'tsconfig.json',
            'tsconfig.server.json',
        ]);
        execFileSync('tar', ['-x', '-C', dir], { input: tar, maxBuffer: 1 << 30 });
        const config = buildConfig('socio-coding', {
            tags: [`socio-coding:${opencode.version}`, ...tagsOf('socio-coding')],
            dockerfile: 'deployment/coding/coding.Dockerfile',
            buildargs: JSON.stringify({
                OPENCODE_VERSION: opencode.version,
                OPENCODE_SHA256: opencode.sha256,
                ...Object.fromEntries(
                    Object.entries(npmPins).flatMap(([arg, pin]) => [
                        [`${arg}_VERSION`, pin.version],
                        [`${arg}_URL`, pin.url],
                        [`${arg}_SHA512`, pin.sha512],
                    ]),
                ),
                GROK_VERSION: grok.version,
                GROK_TAG: grok.tag,
                GROK_COMMIT: grok.commit,
                GROK_SOURCE_REV: grok.source_rev,
            }),
            context: dir,
        });
        build('socio-coding', config);
        // The supervisor runs sandboxes from the local image ID: the image is
        // built on the node and never pushed, so it has no repository digest
        // (deployment/coding/README.md, "Pinning the image").
        const imageId = execFileSync(
            'docker',
            ['image', 'inspect', `socio-coding:${opencode.version}`, '--format', '{{.Id}}'],
            { encoding: 'utf8' },
        ).trim();
        if (imageId) {
            step(`socio-coding: set CODING_SANDBOX_IMAGE=${imageId} on the supervisor`);
        } else {
            step('socio-coding: the engine reported no image ID; read it with docker image inspect');
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};
const wanted = Object.keys(targets).filter((name) => (only ? only.includes(name) : !optIn.has(name)));
// The pin is checked before any build starts: a missing or malformed pin
// sends nothing. It is HEAD's, like the context.
if (wanted.includes('socio-coding')) {
    const committed = (path) => {
        try {
            return execFileSync('git', ['show', `HEAD:${path}`], {
                stdio: ['ignore', 'pipe', 'ignore'],
            }).toString();
        } catch {
            throw new Error(
                `socio-coding: ${path} is not in HEAD; pin the coding agents first (deployment/coding/README.md)`,
            );
        }
    };
    try {
        const dockerfile = committed('deployment/coding/coding.Dockerfile');
        opencode = checkOpencodePin(committed(OPENCODE_PIN_PATH), dockerfile);
        for (const harness of NPM_PINS) {
            npmPins[harness.arg] = checkNpmPin(committed(harness.path), dockerfile, harness);
        }
        grok = checkGrokPin(committed(GROK_PIN.path), dockerfile);
    } catch (error) {
        throw new Error(error.message.startsWith('socio-coding:') ? error.message : `socio-coding: ${error.message}`);
    }
    step(`socio-coding: OpenCode ${opencode.version}, sha256 ${opencode.sha256}`);
    for (const harness of NPM_PINS) {
        step(`socio-coding: ${harness.label} ${npmPins[harness.arg].version}, sha512 ${npmPins[harness.arg].sha512}`);
    }
    step(`socio-coding: ${GROK_PIN.label} ${grok.version} from source, commit ${grok.commit}`);
}
// Only run the build when this is the main module (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // Ensure the BuildKit builder is ready and CPU-limited before building.
    ensureBuilder();
    step(`building ${wanted.join(', ') || 'nothing'}`);
    for (const name of wanted) {
        await targets[name]();
    }
    step('all requested images built');
}
