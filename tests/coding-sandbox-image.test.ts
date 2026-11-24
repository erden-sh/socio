import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// CB-239: the coding sandbox image's managed configuration and the
// stack additions, read as files (nothing is built or started here).

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('the socio-coding image', () => {
    const dockerfile = read('deployment/coding/coding.Dockerfile');

    it('pins OpenCode by checksum, runs as uid 1000 and never serves OpenCode', () => {
        expect(dockerfile).toMatch(/^ARG OPENCODE_SHA256=$/m);
        expect(dockerfile).toContain('test -n "$OPENCODE_SHA256"');
        expect(dockerfile).toContain('sha256sum -c -');
        expect(dockerfile).toMatch(/^USER 1000:1000$/m);
        expect(dockerfile).not.toMatch(/opencode serve/);
        expect(dockerfile).not.toMatch(/docker\.sock/);
        // The managed files are root-owned; the agent can't edit them.
        expect(dockerfile).toContain('chown -R root:root /etc/socio /etc/gitconfig');
        expect(dockerfile).toContain('find / -xdev -perm /6000 -type f -exec chmod a-s');
    });
    it('installs Codex, Claude Code and Gemini CLI from pinned, checksummed files, with no package scripts (CB-326)', () => {
        for (const arg of ['CODEX', 'CLAUDE_CODE', 'GEMINI_CLI']) {
            expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}_SHA512=$`, 'm'));
            expect(dockerfile).toContain(`test -n "$${arg}_SHA512"`);
            expect(dockerfile).toMatch(new RegExp(`^ARG ${arg}_URL=https://registry\\.npmjs\\.org/`, 'm'));
        }
        expect(dockerfile.match(/sha512sum -c -/g)).toHaveLength(3);
        // Unpacked, never `npm install`ed: no install script runs.
        expect(dockerfile).not.toMatch(/npm (install|i) [^\n]*(codex|claude|gemini)/);
        expect(dockerfile).toContain('ln -s /opt/gemini-cli/bundle/gemini.js /usr/local/bin/gemini');
        expect(dockerfile).toContain('COPY deployment/coding/gemini-settings.json /etc/gemini-cli/settings.json');
        expect(dockerfile).toContain('/usr/local/lib/socio/grok-socio');
        expect(dockerfile).toContain('ln -s /opt/codex/codex /usr/local/bin/codex');
        expect(dockerfile).toContain('chown root:root /usr/local/bin/claude');
        // with-token is the managed launcher the supervisor names.
        expect(dockerfile).toContain('deployment/coding/with-token');
        expect(dockerfile).toContain('/usr/local/lib/socio/with-token');
        expect(dockerfile).toContain('DISABLE_AUTOUPDATER=1');
    });

    it('builds Grok Build from its source at the pinned commit, never from xAI’s binary (CB-326, owner decision)', () => {
        // The Dockerfile may carry unrelated stages (CB-326 session-host:
        // host-build, host-deps, tsx-deps); scope to the grok-build builder
        // and the final (runtime) stage instead of assuming the whole file
        // is two stages. 4bd9ab67 added those stages without updating this.
        const stages = dockerfile.split(/^FROM /m).slice(1);
        const build = stages.find((s) => /^rust:1\.94\.0-bookworm@sha256:[0-9a-f]{64} AS grok-build\n/.test(s))!;
        const image = stages.at(-1)!;
        expect(build).toBeDefined();
        expect(image).toBeDefined();
        // The builder: Rust's image by digest, the toolchain the source pins.
        expect(build).toMatch(/^rust:1\.94\.0-bookworm@sha256:[0-9a-f]{64} AS grok-build\n/);
        expect(build).toContain('RUSTUP_TOOLCHAIN=1.94.0');
        expect(build).toMatch(/^ARG GROK_COMMIT=$/m);
        expect(build).toMatch(/^ARG GROK_SOURCE_REV=$/m);
        expect(build).toContain(`grep -Eqx '[0-9a-f]{40}'`);
        // Fetched by commit id and checked, with SOURCE_REV and the version.
        expect(build).toContain('git fetch -q --depth 1 origin "$GROK_COMMIT"');
        expect(build).toContain('test "$(git rev-parse HEAD)" = "$GROK_COMMIT"');
        expect(build).toContain('test "$(cat SOURCE_REV)" = "$GROK_SOURCE_REV"');
        expect(build).toContain('crates/codegen/xai-grok-version/Cargo.toml');
        // A tag, when the pin has one, must name the commit.
        expect(build).toContain('test "$(git rev-parse "refs/tags/$GROK_TAG^{commit}")" = "$GROK_COMMIT"');
        // Its build tools by checksum; nothing fetched unchecked while compiling.
        expect(build).toMatch(/^ARG PROTOC_SHA256=[0-9a-f]{64}$/m);
        expect(build).toMatch(/^ARG RIPGREP_SHA256=[0-9a-f]{64}$/m);
        expect(build.match(/sha256sum -c -/g)).toHaveLength(2);
        expect(build).toContain('GROK_TOOLS_BUNDLE_RG_PATH=/opt/rg/rg GROK_SHELL_BUNDLE_RG_PATH=/opt/rg/rg');
        expect(build).toContain('cargo fetch --locked');
        expect(build).toContain('cargo build --frozen --profile release-dist -p xai-grok-pager-bin');
        expect(build).toContain('env -u GROK_VERSION');
        // The image takes only the binary, root-owned, and checks its version.
        expect(image).toContain('COPY --from=grok-build /out/grok /usr/local/bin/grok');
        expect(image).toContain('chown root:root /usr/local/bin/grok && chmod 0755 /usr/local/bin/grok');
        expect(image).toContain('grok --version </dev/null | grep -F "$GROK_VERSION"');
        expect(image).not.toMatch(/cargo|rustc|\/src\/grok-build/);
        expect(dockerfile).not.toMatch(/x\.ai\/cli|install\.sh|GROK_SHA512|GROK_URL/);
    });

    it('points OpenCode at the gateway only, with sharing, updates, plugins and MCP off', () => {
        const config = JSON.parse(read('deployment/coding/opencode.json'));
        // OpenCode 2's native config shape: none of the V1 keys it still reads
        // (provider, enabled_providers, autoupdate, plugin, tools, permission).
        for (const legacy of ['provider', 'enabled_providers', 'autoupdate', 'plugin', 'tools', 'permission']) {
            expect(config, legacy).not.toHaveProperty(legacy);
        }
        // Chat Completions for listed models; Responses for a session on
        // the person's own plan. Both only to the gateway, with the token.
        expect(Object.keys(config.providers)).toEqual(['socio', 'socio-responses']);
        expect(config.policies).toEqual([
            { action: 'provider.use', resource: '*', effect: 'deny' },
            { action: 'provider.use', resource: 'socio', effect: 'allow' },
            { action: 'provider.use', resource: 'socio-responses', effect: 'allow' },
        ]);
        expect(config.providers.socio).toMatchObject({
            package: 'aisdk:@ai-sdk/openai-compatible',
            settings: {
                baseURL: 'http://gateway.socio.internal/v1',
                apiKey: '{file:/run/socio/token}',
            },
        });
        expect(config.providers['socio-responses']).toMatchObject({
            package: 'aisdk:@ai-sdk/openai',
            settings: {
                baseURL: 'http://gateway.socio.internal/v1',
                apiKey: '{file:/run/socio/token}',
            },
        });
        expect(config.share).toBe('disabled');
        expect(config.update).toBe('disable');
        expect(config.plugins).toEqual([]);
        expect(config.mcp).toEqual({ servers: {} });
        expect(config.permissions).toContainEqual({ action: 'webfetch', resource: '*', effect: 'deny' });
    });

    it('sends Git to the gateway and package managers to the read-only registry hosts', () => {
        const git = read('deployment/coding/gitconfig');
        expect(git).toContain('[url "http://gateway.socio.internal/git/"]');
        expect(git).toContain('insteadOf = https://github.com/');
        expect(git).toMatch(/\[protocol\]\n\tallow = never/);
        expect(git).toMatch(/\[protocol "http"\]\n\tallow = always/);
        expect(git).toContain('helper = /usr/local/lib/socio/git-credential-socio');
        expect(read('deployment/coding/npmrc')).toMatch(/^registry=http:\/\/npm\.registry\.socio\.internal\/$/m);
        const pip = read('deployment/coding/pip.conf');
        expect(pip).toContain('index-url = http://pypi.registry.socio.internal/simple/');
        expect(pip).toContain('pypi-files.registry.socio.internal');
        const helper = read('deployment/coding/git-credential-socio');
        expect(helper).toContain("printf 'username=\\npassword=%s\\n'");
    });

    it('writes the token only in its own shape, and sets up without planted config', () => {
        const token = read('deployment/coding/write-token');
        expect(token).toMatch(/^set -eu$/m);
        expect(token).toContain('cbgw_*)');
        expect(token).toContain('chmod 0400');
        const setup = read('deployment/coding/setup');
        expect(setup).toMatch(/^set -eu$/m);
        expect(setup).toContain('rm -rf "$dir/.git/hooks"');
        // Planted attributes (`* -diff`) would hide content in later diffs;
        // every Git command ignores an attributes file.
        expect(setup).toContain('rm -rf "$dir/.git/hooks" "$dir/.git/info"');
        expect(setup).toContain('-c core.attributesFile=/dev/null');
        // Never the agent-writable global config; the managed /etc/gitconfig
        // (URL rewrite, credential helper) stays.
        expect(setup).toMatch(/^export GIT_CONFIG_GLOBAL=\/dev\/null$/m);
        expect(setup).not.toContain('GIT_CONFIG_NOSYSTEM');
        expect(setup.indexOf('export GIT_CONFIG_GLOBAL')).toBeLessThan(setup.indexOf('git_safe -C "$dir" fetch'));
        expect(setup).toContain('cat > "$dir/.git/config"');
        expect(setup).toContain('-c core.hooksPath=/dev/null -c core.fsmonitor=false');
        expect(setup).not.toMatch(/\beval\b/);
        // The replaced config comes before the first Git command on the old tree.
        expect(setup.indexOf('cat > "$dir/.git/config"')).toBeLessThan(setup.indexOf('git_safe -C "$dir" fetch'));
    });

    it('settles Gemini CLI’s system settings: no telemetry, updates, MCP, extensions or web tools, helpers on the session’s model (CB-326)', () => {
        const settings = JSON.parse(read('deployment/coding/gemini-settings.json'));
        expect(settings.privacy).toEqual({ usageStatisticsEnabled: false });
        expect(settings.telemetry).toMatchObject({ enabled: false, logPrompts: false });
        expect(settings.general).toMatchObject({ enableAutoUpdate: false, enableAutoUpdateNotification: false });
        expect(settings.admin).toEqual({ mcp: { enabled: false }, extensions: { enabled: false } });
        expect(settings.tools.exclude).toEqual(['google_web_search', 'web_fetch']);
        // The repository's .env files don't reach the CLI; folder trust is off so
        // yolo stands (the sandbox is the boundary).
        expect(settings.advanced).toEqual({ ignoreLocalEnv: true });
        expect(settings.security).toEqual({ folderTrust: { enabled: false } });
        // Every helper model alias names the session's model, the only one the
        // gateway serves; none names a Google model.
        expect(settings.model.name).toBe('$SOCIO_GEMINI_MODEL');
        const aliases = Object.entries(settings.modelConfigs.customAliases) as [
            string,
            { modelConfig: { model: string } },
        ][];
        expect(aliases.length).toBeGreaterThan(10);
        for (const [name, alias] of aliases) {
            expect(alias.modelConfig.model, name).toBe('$SOCIO_GEMINI_MODEL');
        }
        expect(aliases.map(([name]) => name)).toEqual(
            expect.arrayContaining(['chat-compression-default', 'loop-detection', 'llm-edit-fixer', 'classifier']),
        );
        expect(JSON.stringify(settings)).not.toMatch(/gemini-\d|googleapis|apiKey|selectedType/);
    });

    describe('with-token and grok-socio, run with stand-ins for the agents', () => {
        // The scripts hard-code /run/socio/token and /usr/local/lib/socio;
        // copies pointed at a scratch directory run them as they are.
        const scratch = () => {
            const dir = mkdtempSync(join(tmpdir(), 'socio-with-token-'));
            const tools = join(dir, 'lib');
            const bin = join(dir, 'bin');
            spawnSync('mkdir', ['-p', tools, bin]);
            writeFileSync(join(dir, 'token'), `cbgw_${'Q'.repeat(43)}`);
            writeFileSync(
                join(tools, 'with-token'),
                read('deployment/coding/with-token')
                    .replace('/run/socio/token', join(dir, 'token'))
                    .replace('/usr/local/lib/socio/grok-socio', join(tools, 'grok-socio')),
            );
            writeFileSync(join(tools, 'grok-socio'), read('deployment/coding/grok-socio'));
            // The stand-in agent prints its argv and the token variable it got.
            const agent =
                '#!/bin/sh\nprintf "%s\\n" "$0" "$@"; echo "key=${SOCIO_GATEWAY_TOKEN:-}${GEMINI_API_KEY:-}"\n';
            for (const name of ['gemini', 'grok', 'codex']) {
                writeFileSync(join(bin, name), agent);
            }
            spawnSync('chmod', [
                '0755',
                join(tools, 'with-token'),
                join(tools, 'grok-socio'),
                ...['gemini', 'grok', 'codex'].map((n) => join(bin, n)),
            ]);
            const run = (args: string[], env: Record<string, string> = {}) =>
                spawnSync(join(tools, 'with-token'), args, {
                    encoding: 'utf8',
                    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
                });
            return { dir, tools, run };
        };

        it('passes Gemini CLI its key in GEMINI_API_KEY, and nothing to an agent it doesn’t know', () => {
            const { dir, run } = scratch();
            try {
                const ok = run(['GEMINI_API_KEY', 'gemini', '--output-format', 'stream-json']);
                expect(ok.status).toBe(0);
                expect(ok.stdout).toContain(`key=cbgw_${'Q'.repeat(43)}`);
                expect(run(['GEMINI_API_KEY', 'sh', '-c', 'env']).status).toBe(2);
                expect(run(['XAI_API_KEY', 'gemini']).status).toBe(2);
                expect(run(['GEMINI_API_KEY', 'grok']).status).toBe(2);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        it('writes Grok Build’s config.toml afresh for the run, then runs grok with its own arguments', () => {
            const { dir, tools, run } = scratch();
            const home = join(dir, 'grok-home');
            try {
                spawnSync('mkdir', ['-p', home]);
                writeFileSync(join(home, 'config.toml'), '[model.socio]\nbase_url = "https://api.x.ai/v1"\n');
                const ok = run(
                    [
                        'SOCIO_GATEWAY_TOKEN',
                        join(tools, 'grok-socio'),
                        'qwen3.8:flash',
                        '--model',
                        'socio',
                        '--resume',
                        'x',
                    ],
                    { GROK_HOME: home },
                );
                expect(ok.stderr).toBe('');
                expect(ok.status).toBe(0);
                expect(ok.stdout.split('\n').slice(1, 5)).toEqual(['--model', 'socio', '--resume', 'x']);
                expect(ok.stdout).toContain(`key=cbgw_${'Q'.repeat(43)}`);
                const config = readFileSync(join(home, 'config.toml'), 'utf8');
                expect(config).toContain('[model.socio]\nmodel = "qwen3.8:flash"');
                expect(config).toContain('base_url = "http://gateway.socio.internal/v1"');
                // Grok Build's own wire API for xAI's models: Responses.
                expect(config).toContain('api_backend = "responses"');
                expect(config).not.toContain('chat_completions');
                expect(config).toContain('remote_fetch = false');
                expect(config).toContain('env_key = "SOCIO_GATEWAY_TOKEN"');
                expect(config).toContain('telemetry = "off"');
                expect(config).toContain('auto_update = false');
                expect(config).not.toContain('api.x.ai');
                expect(config).not.toContain('cbgw_');
                // A model that could break out of the TOML string, or pass an
                // option, is refused before anything is written or run.
                for (const bad of ['', '-x', 'a"b', 'a\nb', 'a b', 'x'.repeat(101)]) {
                    const refused = run(['SOCIO_GATEWAY_TOKEN', join(tools, 'grok-socio'), bad], { GROK_HOME: home });
                    expect(refused.status, bad).toBe(2);
                    expect(refused.stdout).toBe('');
                }
                expect(run(['SOCIO_GATEWAY_TOKEN', join(tools, 'grok-socio'), 'qwen38']).status).not.toBe(0);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});

describe('the stack additions (not deployed)', () => {
    it('keeps sandboxes off until an image digest is set', () => {
        const compose = parse(read('.docker/compose.computers.yml'));
        const supervisor = compose.services['computer-supervisor'];
        expect(supervisor.environment.CODING_SANDBOX_IMAGE).toBe('${CODING_SANDBOX_IMAGE:-}');
        expect(supervisor.environment.CODING_EGRESS_MODE).toBe('virtual-hosts');
    });

    it('runs the coding egress proxy unprivileged, labelled, with nothing published', () => {
        const compose = parse(read('.docker/compose.computers.yml'));
        for (const service of [compose.services['coding-egress']]) {
            expect(service.cap_drop).toEqual(['ALL']);
            expect(service.read_only).toBe(true);
            expect(service.user).toBe('node');
            expect(service.ports).toBeUndefined();
            expect(service.volumes).toBeUndefined();
            expect(service.privileged).toBeUndefined();
            expect(service.labels['socio.coding-egress']).toMatch(/company-brain/);
            expect(service.sysctls['net.ipv4.ip_forward']).toBe('0');
            expect(service.environment.CODING_EGRESS_MODE).toBe('virtual-hosts');
        }
        expect(compose.networks['coding-gateway'].internal).toBe(true);
        const dockerfile = read('Dockerfile');
        const stage = dockerfile.slice(dockerfile.indexOf(' AS coding-egress'));
        expect(stage).toContain('CMD ["node", "dist/server/coding-egress/main.js"]');
        expect(stage).toMatch(/^USER node$/m);
        expect(stage).not.toContain('node_modules');
    });
});

describe('the setup script against a real Git remote', () => {
    // The script as shipped, with only its workspace path and the remote's
    // transport (a local bare repository instead of the Git proxy) changed.
    const run = (dir: string, branch: string) => {
        const script = read('deployment/coding/setup')
            .replace('dir=/work/repo', `dir=${join(dir, 'work')}`)
            .replace('-c protocol.http.allow=always', '-c protocol.http.allow=always -c protocol.file.allow=always');
        writeFileSync(join(dir, 'setup'), script);
        writeFileSync(join(dir, 'gitconfig'), `[url "file://${dir}/remotes/"]\n\tinsteadOf = https://github.com/\n`);
        return spawnSync('sh', [join(dir, 'setup'), 'acme/app', 'main', branch], {
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: join(dir, 'home'),
                GIT_CONFIG_SYSTEM: join(dir, 'gitconfig'),
            },
            encoding: 'utf8',
        });
    };

    it('refuses a session branch the remote already has, and sets up a new one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cb-setup-'));
        try {
            const git = (...args: string[]) =>
                execFileSync('git', args, {
                    cwd: dir,
                    env: {
                        PATH: process.env.PATH ?? '/usr/bin:/bin',
                        HOME: dir,
                        GIT_CONFIG_GLOBAL: '/dev/null',
                        GIT_CONFIG_NOSYSTEM: '1',
                        GIT_AUTHOR_NAME: 'Test',
                        GIT_AUTHOR_EMAIL: 'test@example.invalid',
                        GIT_COMMITTER_NAME: 'Test',
                        GIT_COMMITTER_EMAIL: 'test@example.invalid',
                    },
                });
            git('init', '--quiet', '--bare', '-b', 'main', 'remotes/acme/app.git');
            git('init', '--quiet', '-b', 'main', 'seed');
            writeFileSync(join(dir, 'seed', 'README.md'), 'Seed\n');
            git('-C', 'seed', 'add', 'README.md');
            git('-C', 'seed', 'commit', '--quiet', '-m', 'Seed');
            git('-C', 'seed', 'branch', 'socio/rulo/abcd1234');
            git('-C', 'seed', 'push', '--quiet', `${dir}/remotes/acme/app.git`, 'main', 'socio/rulo/abcd1234');
            const taken = run(dir, 'socio/rulo/abcd1234');
            expect(taken.status).toBe(3);
            expect(taken.stderr).toContain('already exists on the remote');
            // Its workspace stays on the base: nothing checked out as the branch.
            expect(
                execFileSync('git', ['-C', join(dir, 'work'), 'branch', '--list'], {
                    encoding: 'utf8',
                }),
            ).not.toContain('abcd1234');
            // A new short id sets up (the same volume, fetched again).
            const fresh = run(dir, 'socio/rulo/0123abcd');
            expect(fresh.status).toBe(0);
            expect(fresh.stdout).toMatch(/^[0-9a-f]{40}$/m);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
