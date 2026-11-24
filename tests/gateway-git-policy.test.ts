import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { contractViolations } from '@socio/data/contract';
import { pktLine } from '@socio/foundation/github/pkt-lines';

import { codingGitFromEnv } from '../src/coding-git/config.js';
import {
    AddedLineScanner,
    commitProblems,
    comparablePath,
    compileScope,
    isProtectedPath,
    parseCommit,
    parseRawDiff,
    pathProblem,
    scopePathProblem,
    scopeWithin,
} from '../src/coding-git/rules.js';
import { createCodingGitServer, codingGitKey } from '../src/coding-git/server.js';
import { CodingGit } from '../src/coding-git/service.js';
import { CodingGitClient, CodingGitUnavailable } from '../src/server/gateway/coding-git-client.js';
import { sessionBranchAllowed } from '../src/server/gateway/git-context.js';
import {
    checkPushCommands,
    parseGitPath,
    receiveAdvertisement,
    refusalReport,
} from '../src/server/gateway/git-policy.js';
import { gitCredential } from '../src/server/gateway/git.js';
import { parseUploadAdvertisement } from '../src/server/gateway/mirror.js';
import { socioCommitIdentity } from '../src/server/gateway/repos.js';
import { gatewaySchema } from '../src/server/gateway/schema.js';
import { GitHubApp } from '../src/server/github/api.js';

import { fakeGitHub } from './github-fake.js';
import { SOCIO, tempDir } from './support/git-repos.js';

// CB-239: coding-git's pure policy: paths, push commands, capabilities,
// commit identity and text, path normalization, extraction scopes; the
// GitHub App's permission sets; coding-git's own API key. Negative cases
// first.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BRANCH = 'socio/rulo/ab12cd34';

describe('Git paths', () => {
    const q = (text = '') => new URLSearchParams(text);
    it('refuses everything but the three smart-HTTP endpoints of owner/name', () => {
        for (const [method, path, query] of [
            ['GET', '/git/acme/app.git/info/refs', ''],
            ['GET', '/git/acme/app.git/info/refs', 'service=git-upload-archive'],
            ['GET', '/git/acme/app.git/info/refs', 'service=git-upload-pack&x=1'],
            ['POST', '/git/acme/app.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/git/acme/app.git/git-upload-pack', ''],
            ['POST', '/git/acme/app.git/git-upload-pack', 'x=1'],
            ['GET', '/git/acme/app.git/HEAD', ''],
            ['GET', '/git/acme/../app.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/git/ac..me/app.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/git/acme/a..pp.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/git/acme/app.git.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/git/a/b/c.git/info/refs', 'service=git-upload-pack'],
            ['GET', `/git/${'x'.repeat(40)}/app.git/info/refs`, 'service=git-upload-pack'],
            ['GET', '/git/acme/ap p.git/info/refs', 'service=git-upload-pack'],
            ['GET', '/v1/models', ''],
        ] as const) {
            expect(parseGitPath(method, path, q(query))).toBeUndefined();
        }
    });
    it('reads the repository and the service', () => {
        expect(parseGitPath('GET', '/git/acme/app.git/info/refs', q('service=git-receive-pack'))).toEqual({
            repository: 'acme/app',
            kind: 'advertise',
            service: 'git-receive-pack',
        });
        expect(parseGitPath('POST', '/git/Acme-1/my.repo_x.git/git-upload-pack', q())).toEqual({
            repository: 'Acme-1/my.repo_x',
            kind: 'rpc',
            service: 'git-upload-pack',
        });
    });
    it('reads the credential helper’s Basic auth (empty user) or a bearer token', () => {
        const token = `cbgw_${'x'.repeat(43)}`;
        expect(gitCredential(`Basic ${Buffer.from(`:${token}`).toString('base64')}`)).toBe(token);
        expect(gitCredential(`Bearer ${token}`)).toBe(token);
        expect(gitCredential(null)).toBeUndefined();
        expect(gitCredential('Digest x')).toBeUndefined();
    });
});

describe('push commands', () => {
    const line = (old: string, next: string, ref: string, caps?: string) =>
        `${old} ${next} ${ref}${caps === undefined ? '' : `\0${caps}`}\n`;
    it('refuses refs outside the session’s exact branch', () => {
        for (const ref of [
            'refs/heads/main',
            `refs/heads/${BRANCH}/below`,
            'refs/heads/socio/rulo/ffffffff',
            `refs/tags/${BRANCH}`,
            'refs/tags/v1',
            'refs/notes/commits',
            `refs/heads/${BRANCH.toUpperCase()}`,
            'HEAD',
        ]) {
            expect(checkPushCommands([line(ZERO, A, ref, 'report-status')], BRANCH)).toMatchObject({
                ok: false,
                reason: 'ref_outside_session',
            });
        }
    });
    it('refuses deletes, several commands, push options and certificates', () => {
        const ref = `refs/heads/${BRANCH}`;
        expect(checkPushCommands([line(A, ZERO, ref, 'report-status')], BRANCH)).toMatchObject({
            ok: false,
            reason: 'ref_delete',
        });
        expect(checkPushCommands([line(ZERO, A, ref, 'report-status'), line(ZERO, B, ref)], BRANCH)).toMatchObject({
            ok: false,
            reason: 'ref_outside_session',
        });
        for (const caps of [
            'report-status push-options',
            'report-status report-status-v2',
            'report-status object-format=sha256',
            'report-status agent=x y\u0001',
        ]) {
            expect(checkPushCommands([line(ZERO, A, ref, caps)], BRANCH)).toMatchObject({
                ok: false,
                reason: 'capability_refused',
            });
        }
        expect(checkPushCommands(['push-cert\0report-status\n'], BRANCH)).toMatchObject({
            ok: false,
            reason: 'capability_refused',
        });
        expect(checkPushCommands([line(ZERO, A, ref), line(ZERO, B, ref, 'report-status')], BRANCH)).toMatchObject({
            ok: false,
            reason: 'commands_malformed',
        });
        for (const bad of ['', 'x y z', `${ZERO} ${A}`, `${ZERO} ${A} ${ref} extra`, `${ZERO.slice(1)} ${A} ${ref}`]) {
            expect(checkPushCommands([bad], BRANCH)).toMatchObject({ ok: false });
        }
        expect(checkPushCommands([], BRANCH)).toMatchObject({ ok: false });
    });
    it('accepts a create or an update (force included) of exactly the branch', () => {
        const ref = `refs/heads/${BRANCH}`;
        expect(
            checkPushCommands(
                [line(ZERO, A, ref, 'report-status side-band-64k atomic quiet ofs-delta agent=git/2.43.0')],
                BRANCH,
            ),
        ).toMatchObject({ ok: true, commands: [{ old: ZERO, new: A, ref }] });
        expect(checkPushCommands([line(B, A, ref, 'report-status')], BRANCH)).toMatchObject({ ok: true });
    });
    it('answers a refusal as report-status, in side-band when asked', () => {
        const report = refusalReport(['refs/heads/main'], 'only xé\n', ['report-status']).toString();
        expect(report).toContain('unpack ok');
        expect(report).toContain('ng refs/heads/main refused by Socio: only x??');
        const banded = refusalReport(['refs/heads/main'], 'no', ['report-status', 'side-band-64k']);
        expect(banded[4]).toBe(1);
    });
    it('advertises only the allowed capabilities, from GitHub’s refs', () => {
        const advertised = receiveAdvertisement({
            'refs/heads/main': A,
        }).toString();
        expect(advertised).toContain('# service=git-receive-pack');
        expect(advertised).toContain(
            `${A} refs/heads/main\0report-status side-band-64k atomic quiet ofs-delta agent=socio-gateway`,
        );
        expect(advertised).not.toContain('push-options');
        expect(receiveAdvertisement({}).toString()).toContain(`${ZERO} capabilities^{}`);
    });
    it('keeps branches and tags of an upload-pack advertisement, peeled entries and pull refs out', () => {
        const body = Buffer.concat([
            pktLine('# service=git-upload-pack\n'),
            Buffer.from('0000'),
            pktLine(`${A} HEAD\0multi_ack side-band-64k\n`),
            pktLine(`${A} refs/heads/main\n`),
            pktLine(`${B} refs/tags/v1\n`),
            pktLine(`${A} refs/tags/v1^{}\n`),
            pktLine(`${B} refs/pull/1/head\n`),
            Buffer.from('0000'),
        ]);
        expect(parseUploadAdvertisement(body)).toEqual({
            'refs/heads/main': A,
            'refs/tags/v1': B,
        });
    });
});

// A grant's branch must have the session shape.
describe('session branches', () => {
    it('allows only <prefix>/<socio slug>/<short id>, never a base branch', () => {
        const repo = { branchPrefix: 'socio', baseBranches: [] as string[] };
        for (const branch of [
            undefined,
            '',
            'main',
            'socio',
            'socio/rulo',
            'socio/rulo/',
            'socio/rulo/ab12',
            'socio/rulo/ab12cd34/x',
            'socio/-rulo/ab12cd34',
            'socio/ru_lo/ab12cd34',
            'socio/rulo/AB12CD34',
            'socio/../ab12cd34',
            'bots/rulo/ab12cd34',
            'xsocio/rulo/ab12cd34',
            `socio/${'r'.repeat(65)}/ab12cd34`,
        ]) {
            expect(sessionBranchAllowed(repo, branch), String(branch)).toBe(false);
        }
        for (const branch of [BRANCH, 'socio/socio/eeeeeeee', 'socio/rulo-2/0123456789abcdef']) {
            expect(sessionBranchAllowed(repo, branch), branch).toBe(true);
        }
        expect(sessionBranchAllowed({ branchPrefix: 'bots', baseBranches: [] }, 'bots/rulo/ab12cd34')).toBe(true);
        // A base branch never, whatever its shape.
        expect(sessionBranchAllowed({ branchPrefix: 'socio', baseBranches: [BRANCH] }, BRANCH)).toBe(false);
        // A prefix that isn't one (a stored row edited by hand): nothing.
        expect(sessionBranchAllowed({ branchPrefix: '.*', baseBranches: [] }, 'x/rulo/ab12cd34')).toBe(false);
    });
});

describe('paths and commits', () => {
    it('protects .github/ and CODEOWNERS whatever their case or lookalike form', () => {
        for (const path of [
            '.github',
            '.github/workflows/ci.yml',
            '.GITHUB/x',
            '.GitHub/workflows/x.yml',
            '.ｇｉｔｈｕｂ/x',
            '.git\u200bhub/x',
            '.git\u00adhub/x',
            'CODEOWNERS',
            'docs/codeowners',
            'docs/CODEOWNERS',
            '.github/CODEOWNERS',
            'ＣＯＤＥＯＷＮＥＲＳ',
        ]) {
            expect(isProtectedPath(path), path).toBe(true);
        }
        for (const path of ['github/x', 'src/.github.ts', 'CODEOWNERS.md', 'docs/.githubx/y']) {
            expect(isProtectedPath(path), path).toBe(false);
        }
        expect(comparablePath('Ａ\u200bB')).toBe('ab');
    });
    it('parses raw diffs, merges included', () => {
        const output = Buffer.from(
            `:100644 100644 ${A} ${B} M\0src/a.ts\0::000000 100644 160000 ${ZERO} ${A} ${B} AM\0vendor/x\0`,
        );
        expect(parseRawDiff(output)).toEqual([
            { path: 'src/a.ts', modes: ['100644', '100644'], status: 'M' },
            { path: 'vendor/x', modes: ['000000', '100644', '160000'], status: 'AM' },
        ]);
    });
    it('requires the socio as author and committer, and inert messages', () => {
        const raw = (author: string, message: string, committer = author) =>
            `tree ${A}\nparent ${B}\nauthor ${author} 1700000000 +0000\ncommitter ${committer} 1700000000 +0000\ngpgsig -----BEGIN-----\n line\n -----END-----\n\n${message}`;
        const me = `${SOCIO.name} <${SOCIO.email}>`;
        expect(commitProblems(parseCommit(raw(me, 'Fine')), SOCIO)).toBeUndefined();
        expect(parseCommit(raw(me, 'x')).parents).toEqual([B]);
        expect(commitProblems(parseCommit(raw('Pat <pat@example.com>', 'x')), SOCIO)).toMatchObject({
            reason: 'foreign_identity',
        });
        expect(commitProblems(parseCommit(raw(me, 'x', 'Pat <pat@example.com>')), SOCIO)).toMatchObject({
            reason: 'foreign_identity',
        });
        expect(
            commitProblems(parseCommit(raw(`Rulo (Socio) <${SOCIO.email.toUpperCase()}>`, 'x')), SOCIO),
        ).toMatchObject({ reason: 'foreign_identity' });
        expect(commitProblems(parseCommit('garbage'), SOCIO)).toMatchObject({
            reason: 'foreign_identity',
        });
        for (const message of [
            'x\n\nCo-authored-by: Pat <pat@example.com>',
            'x\n\nco-authored-by:Pat',
            'x\n\nSIGNED-OFF-BY: someone',
            'mail me at a.b@c.io',
            'fix: #3',
            'Resolved acme/app#3',
            'closes https://github.com/acme/app/pull/7',
            '[ skip ci ]',
            '[actions skip]',
            '[no ci]',
            'skip-checks:true',
        ]) {
            expect(commitProblems(parseCommit(raw(me, message)), SOCIO), message).toBeDefined();
        }
        expect(commitProblems(parseCommit(raw(me, `x\n\nCo-authored-by: ${me}`)), SOCIO)).toBeUndefined();
        expect(commitProblems(parseCommit(raw(me, 'see issue #3, fixed the parser')), SOCIO)).toBeUndefined();
    });
    // A declared encoding other than UTF-8 is refused.
    it('refuses commits that declare an encoding other than UTF-8', () => {
        const me = `${SOCIO.name} <${SOCIO.email}>`;
        const raw = (encoding: string) =>
            `tree ${A}\nparent ${B}\nauthor ${me} 1700000000 +0000\ncommitter ${me} 1700000000 +0000\nencoding ${encoding}\n\nFine`;
        for (const encoding of ['ISO-8859-1', 'UTF-16', 'utf-7', 'ISO-2022-JP', '']) {
            expect(commitProblems(parseCommit(raw(encoding)), SOCIO), encoding).toMatchObject({
                reason: 'commit_text',
            });
        }
        for (const encoding of ['UTF-8', 'utf-8', 'utf8', 'UTF8']) {
            expect(commitProblems(parseCommit(raw(encoding)), SOCIO), encoding).toBeUndefined();
        }
        expect(parseCommit(raw('ISO-8859-1')).encoding).toBe('ISO-8859-1');
    });
    // A token-shaped file name is refused like a line.
    it('refuses changed paths shaped like a Socio token', () => {
        const change = (path: string) => ({
            path,
            modes: ['000000', '100644'],
            status: 'A',
        });
        expect(pathProblem(change(`notes/cbgw_${'Q'.repeat(43)}.txt`))).toMatchObject({ reason: 'token_shape' });
        expect(pathProblem(change(`cbsa_${'a'.repeat(20)}`))).toMatchObject({
            reason: 'token_shape',
        });
        expect(pathProblem(change('docs/cbgw_tokens.md'))).toBeUndefined();
    });
    it('flags a token only on lines added against every parent', () => {
        const token = `cbgw_${'Q'.repeat(43)}`;
        const scan = (width: number, text: string) => {
            const scanner = new AddedLineScanner(width);
            for (const piece of text.match(/[\s\S]{1,7}/g) ?? []) {
                scanner.push(piece);
            }
            return scanner.end();
        };
        expect(scan(1, `diff --git a/x b/x\n+++ b/${token}\n@@ -0,0 +1 @@\n+${token}\n`)).toBe(true);
        // A header line, a context or removed line: not added.
        expect(scan(1, `diff --git a/x b/x\n+++ b/${token}\n@@ -1 +0,0 @@\n-${token}\n`)).toBe(false);
        // Combined diff: added against one parent only (it came from the other).
        expect(scan(2, `diff --cc x\n@@@ -1,0 -1,1 +1,2 @@@\n+ ${token}\n`)).toBe(false);
        expect(scan(2, `diff --cc x\n@@@ -1,0 -1,1 +1,2 @@@\n++${token}\n`)).toBe(true);
        expect(scan(1, '@@ -0,0 +1 @@\n+cbgw_ tokens are described here\n')).toBe(false);
    });
});

describe('extraction scopes (CB-267)', () => {
    it('refuses traversal, absolute paths, .git, backslashes and other glob forms', () => {
        for (const path of [
            '',
            '..',
            '../x',
            'a/../b',
            'a/./b',
            '/abs',
            'a//b',
            '.git',
            'x/.git/y',
            '.GIT/x',
            'a\\b',
            'a\u0000b',
            'a[b]',
            'a{b}',
            '!a',
            'x'.repeat(201),
        ]) {
            expect(scopePathProblem(path), JSON.stringify(path)).toBeDefined();
        }
        for (const path of ['src/', 'src', 'docs/**/*.md', 'a?c', 'README.md', 'src/**']) {
            expect(scopePathProblem(path), path).toBeUndefined();
        }
    });
    it('matches prefixes and globs over whole paths', () => {
        const inScope = compileScope(['src/', 'docs/**/*.md', 'lib', 'a?.ts']);
        for (const path of ['src/a.ts', 'src/deep/b.ts', 'docs/x.md', 'docs/a/b/c.md', 'lib', 'lib/x', 'ab.ts']) {
            expect(inScope(path), path).toBe(true);
        }
        for (const path of ['srcx/a.ts', 'docs/x.txt', 'libx', 'x/src/a.ts', 'abc.ts', 'docs.md']) {
            expect(inScope(path), path).toBe(false);
        }
        // NFC on both sides.
        expect(compileScope(['café/'])('café/menu.md')).toBe(true);
    });
    it('fits a request inside a standing scope only when equal or under a plain prefix', () => {
        expect(scopeWithin(['src/'], ['src/'])).toBe(true);
        expect(scopeWithin(['src/lib/', 'src/**/*.ts'], ['src/'])).toBe(true);
        expect(scopeWithin(['src'], ['src/'])).toBe(false);
        expect(scopeWithin(['docs/'], ['src/'])).toBe(false);
        expect(scopeWithin(['docs/x.md'], ['docs/**/*.md'])).toBe(false);
        expect(scopeWithin(['src/', 'docs/'], ['src/'])).toBe(false);
    });
});

describe('commit identity', () => {
    it('is the socio’s, opaque and stable, never a person’s', () => {
        const one = socioCommitIdentity('secret', { id: 'dot-1', name: 'Rulo' }, 'apps.example');
        expect(one).toEqual(socioCommitIdentity('secret', { id: 'dot-1', name: 'Rulo' }, 'apps.example'));
        expect(one.name).toBe('Rulo (Socio)');
        expect(one.email).toMatch(/^socio-[0-9a-f]{16}@users\.noreply\.apps\.example$/);
        expect(one.email).not.toContain('dot-1');
        expect(socioCommitIdentity('secret', { id: 'dot-2', name: 'Rulo' }, 'apps.example').email).not.toBe(one.email);
        expect(socioCommitIdentity('s', { id: 'd', name: 'Evil <x@y>\n' }, 'h').name).toBe('Evil x@y (Socio)');
    });
});

describe('installation token permission sets', () => {
    it('asks for exactly the set, refuses workflows and anything wider, and keeps metadata read', async () => {
        const root = tempDir('cb-g2-github-', cleanup);
        const github = await fakeGitHub(join(root, 'gh'), cleanup);
        const converted = await GitHubApp.convertManifest(github.createApp('acme'), { hosts: github.hosts });
        const installation = String(github.install(Number(converted.id), ['app'], 'acme'));
        github.repository('acme', 'app');
        const app = new GitHubApp(converted, { hosts: github.hosts });
        const read = await app.installationToken(installation, 'acme/app', {
            contents: 'read',
        });
        expect(github.tokens.at(-1)!.permissions).toEqual({
            metadata: 'read',
            contents: 'read',
        });
        await read.revoke();
        expect(github.tokens.at(-1)!.revoked).toBe(true);
        for (const bad of [{ workflows: 'write' }, { contents: 'admin' }, {}, { issues: 'write' }]) {
            await expect(app.installationToken(installation, 'acme/app', bad as never)).rejects.toThrow(
                'only for contents and pull requests',
            );
        }
        github.extraPermissions.pull_requests = 'write';
        await expect(app.installationToken(installation, 'acme/app', { contents: 'read' })).rejects.toThrow(
            'more than was asked for',
        );
        expect(github.tokens.at(-1)!.revoked).toBe(true);
        expect(await app.ownedInstallation('acme/app')).toBe(installation);
    });
});

describe('coding-git’s API', () => {
    it('answers only the app’s key', async () => {
        const root = tempDir('cb-g2-cg-', cleanup);
        const secret = 'coding-git-secret-0123456789abcdef';
        const server = createCodingGitServer(new CodingGit({ dir: join(root, 'svc') }), secret);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
        expect((await fetch(`${base}/mirror/refs?repository=acme/app`)).status).toBe(401);
        expect(
            (
                await fetch(`${base}/mirror/refs?repository=acme/app`, {
                    headers: {
                        Authorization: `Bearer ${codingGitKey('another-secret-0123456789abcdef')}`,
                    },
                })
            ).status,
        ).toBe(401);
        const auth = { Authorization: `Bearer ${codingGitKey(secret)}` };
        expect(
            await (
                await fetch(`${base}/mirror/refs?repository=acme/app`, {
                    headers: auth,
                })
            ).json(),
        ).toEqual({ tips: [], has: false });
        expect((await fetch(`${base}/mirror/refs?repository=../etc`, { headers: auth })).status).toBe(400);
        expect((await fetch(`${base}/spool/../../etc`, { headers: auth })).status).toBe(404);
        void createServer;
    });
    // The app takes coding-git's reasons only from the closed list, and shows
    // its own text for each, never coding-git's.
    it('takes coding-git’s verdicts only from the closed list, with Socio’s own text', async () => {
        let answer: unknown;
        const client = new CodingGitClient({ url: 'http://coding-git.invalid', secret: 'x'.repeat(24) }, async () =>
            Response.json(answer),
        );
        const pack = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        const meta = {
            repository: 'acme/app',
            commands: [],
            identity: SOCIO,
        };
        for (const bad of [
            { ok: false, reason: 'Not A Code!', detail: 'x' },
            { ok: false, reason: 'x'.repeat(65), detail: 'x' },
            { ok: false, reason: 'toString', detail: 'x' },
            { ok: false, detail: 'x' },
            { ok: true, spool: '../../etc/passwd', commits: 1 },
            { ok: true, spool: '0'.repeat(36), commits: -1 },
            { ok: 'yes' },
            null,
            [],
        ]) {
            answer = bad;
            await expect(client.inspect(meta, pack()), JSON.stringify(bad)).rejects.toThrow(CodingGitUnavailable);
        }
        answer = {
            ok: false,
            reason: 'protected_path',
            detail: `see cbgw_${'S'.repeat(43)} and \u001b[31m`,
        };
        expect(await client.inspect(meta, pack())).toEqual({
            ok: false,
            reason: 'protected_path',
            detail: '.github/ and CODEOWNERS are a person’s to change',
        });
        answer = {
            ok: true,
            spool: 'a'.repeat(8) + '-' + 'b'.repeat(27),
            commits: 2,
        };
        expect(await client.inspect(meta, pack())).toMatchObject({ ok: true });
        const request = { commit: A, paths: ['src/'], maxBytes: 1, maxFiles: 1 };
        for (const bad of [
            { ok: false, reason: 'storage refused', detail: 'x' },
            { ok: true, files: [{ path: 1 }], bytes: 0, dropped: 0 },
            { ok: true, bytes: 0, dropped: 0 },
        ]) {
            answer = bad;
            await expect(client.extract('acme/app', request)).rejects.toThrow(CodingGitUnavailable);
        }
        answer = {
            ok: false,
            reason: 'paths_invalid',
            detail: 'cbsa_' + 'q'.repeat(30),
        };
        expect(await client.extract('acme/app', request)).toEqual({
            ok: false,
            reason: 'paths_invalid',
            detail: 'the paths are not a valid scope',
        });
        // Mirror tips become `have` lines to GitHub: object ids only.
        answer = { tips: [A, 'want evil\n', B], has: false };
        expect(await client.refs('acme/app')).toEqual({ tips: [A, B], has: false });
        answer = { tips: 'x', has: false };
        await expect(client.refs('acme/app')).rejects.toThrow(CodingGitUnavailable);
    });
    it('needs a long secret', () => {
        expect(() => codingGitFromEnv({ CODING_GIT_SECRET: 'short' })).toThrow();
        expect(codingGitFromEnv({ CODING_GIT_SECRET: 'x'.repeat(24) })).toMatchObject({
            port: 4350,
            dir: '/srv/coding-git',
        });
    });
});

it('adds its tables by expand-only migrations', () => {
    expect(contractViolations([gatewaySchema])).toEqual([]);
});
