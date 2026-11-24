import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodingGit, type InspectMeta } from '../src/coding-git/service.js';

import { PERSON, SOCIO, tempDir, workRepo, type WorkRepo } from './support/git-repos.js';

// CB-239: coding-git inspects pushes against a mirror in a quarantine and
// reads extractions (CB-267), on local bare repositories with real git. No
// network.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const REPO = 'acme/app';
const BRANCH = 'refs/heads/socio/rulo/ab12cd34';
const ZERO = '0'.repeat(40);

async function setup(config: Partial<ConstructorParameters<typeof CodingGit>[0]> = {}) {
    const root = tempDir('cb-coding-git-', cleanup);
    const service = new CodingGit({ dir: join(root, 'svc'), ...config });
    const work = workRepo(join(root, 'work'));
    // The base: a big file (so pushes delta against it, a thin pack) and a doc.
    work.write('src/big.txt', Array.from({ length: 4000 }, (_, i) => `line ${i}\n`).join(''));
    work.write('docs/readme.md', '# hello\n');
    work.commit('base', PERSON);
    const base = work.head();
    await mirror(service, work);
    return { service, work, base };
}

/** The mirror refreshed from the work repository's branches and tags. */
async function mirror(service: CodingGit, work: WorkRepo, known: string[] = []) {
    // What GitHub has: the branches and tags, but not the session's
    // branch, which is only being pushed now.
    const refs = Object.fromEntries(
        Object.entries(work.refs()).filter(
            ([ref]) => /^refs\/(heads|tags)\//.test(ref) && !ref.startsWith('refs/heads/socio/'),
        ),
    );
    const pack = work.pack([...new Set(Object.values(refs))], known, false);
    return service.refresh(REPO, refs, Readable.from([pack]));
}

/** Pushes `head` as the session branch: a thin pack against `base`. */
function inspect(service: CodingGit, work: WorkRepo, head: string, base: string, meta: Partial<InspectMeta> = {}) {
    return service.inspect(
        {
            repository: REPO,
            commands: [{ old: ZERO, new: head, ref: BRANCH }],
            identity: SOCIO,
            ...meta,
        },
        Readable.from([work.pack([head], [base])]),
    );
}

describe('push inspection', () => {
    it('accepts a thin pack of the socio’s own commits, and spools it unchanged', async () => {
        const { service, work, base } = await setup();
        work.git(['checkout', '--quiet', '-b', 'socio/rulo/ab12cd34']);
        work.write('src/big.txt', `changed\n${Array.from({ length: 3999 }, (_, i) => `line ${i + 1}\n`).join('')}`);
        const head = work.commit('Tidy the big file');
        const pack = work.pack([head], [base]);
        // It is thin: it can't be indexed without the mirror's objects.
        const empty = mkdtempSync(join(tmpdir(), 'cb-empty-'));
        cleanup.push(() => execFileSync('rm', ['-rf', empty]));
        execFileSync('git', ['init', '--quiet', '--bare', empty]);
        expect(() =>
            execFileSync('git', ['-C', empty, 'index-pack', '--stdin'], {
                input: pack,
                stdio: ['pipe', 'ignore', 'ignore'],
            }),
        ).toThrow();
        const verdict = await service.inspect(
            {
                repository: REPO,
                commands: [{ old: ZERO, new: head, ref: BRANCH }],
                identity: SOCIO,
            },
            Readable.from([pack]),
        );
        expect(verdict).toMatchObject({ ok: true, commits: 1 });
        if (!verdict.ok) {
            return;
        }
        const file = await service.spoolFile(verdict.spool);
        const chunks: Buffer[] = [];
        for await (const chunk of createReadStream(file!)) {
            chunks.push(chunk as Buffer);
        }
        expect(Buffer.concat(chunks).equals(pack)).toBe(true);
        // Pushed objects never reach the mirror.
        expect((await service.refs(REPO, head)).has).toBe(false);
        await service.dropSpool(verdict.spool);
        expect(await service.spoolFile(verdict.spool)).toBeUndefined();
    });

    const refusals: Array<[string, (work: WorkRepo) => void, string]> = [
        ['a workflow', (work) => work.write('.github/workflows/x.yml', 'on: push\n'), 'protected_path'],
        ['CODEOWNERS anywhere', (work) => work.write('docs/CODEOWNERS', '* @someone\n'), 'protected_path'],
        ['.GitHub in another case', (work) => work.write('.GitHub/workflows/x.yml', 'x\n'), 'protected_path'],
        [
            'a full-width lookalike of .github',
            (work) => work.write('.ｇｉｔｈｕｂ/workflows/x.yml', 'x\n'),
            'protected_path',
        ],
        ['.github with a zero-width space', (work) => work.write('.git\u200bhub/x.yml', 'x\n'), 'protected_path'],
        ['a symlink named .github', (work) => work.symlink('.github', 'docs'), 'protected_path'],
        [
            '.gitmodules',
            (work) => work.write('.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = https://example.com/x\n'),
            'submodule',
        ],
        [
            'a gitlink',
            (work) => work.git(['update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},vendor/lib`]),
            'submodule',
        ],
        [
            'a gateway token in an added line',
            (work) => work.write('src/config.ts', `export const key = 'cbgw_${'A'.repeat(43)}';\n`),
            'token_shape',
        ],
        ['a data token in an added line', (work) => work.write('notes.txt', `cbdt_${'b'.repeat(43)}\n`), 'token_shape'],
        // The file name, which the line scan never sees.
        ['a token in a file name', (work) => work.write(`docs/cbgw_${'P'.repeat(43)}.md`, 'x\n'), 'token_shape'],
    ];
    for (const [name, change, reason] of refusals) {
        it(`refuses ${name}`, async () => {
            const { service, work, base } = await setup();
            work.git(['add', '-A']);
            change(work);
            work.git(['add', '-A', '--', ':!vendor']);
            // Committed as staged: `add -A` would drop a hand-staged gitlink.
            const head = work.commitStaged('A change');
            const verdict = await inspect(service, work, head, base);
            expect(verdict).toMatchObject({ ok: false, reason });
        });
    }

    it('refuses commits authored or committed as anyone but the socio', async () => {
        const { service, work, base } = await setup();
        work.write('a.txt', 'a\n');
        const authored = work.commit('A change', PERSON, SOCIO);
        expect(await inspect(service, work, authored, base)).toMatchObject({
            ok: false,
            reason: 'foreign_identity',
        });
        work.git(['reset', '--quiet', '--hard', base]);
        work.write('b.txt', 'b\n');
        const committed = work.commit('A change', SOCIO, PERSON);
        expect(await inspect(service, work, committed, base)).toMatchObject({
            ok: false,
            reason: 'foreign_identity',
        });
        // An earlier commit of the push counts too, not only the tip.
        work.git(['reset', '--quiet', '--hard', base]);
        work.write('c.txt', 'c\n');
        work.commit('Theirs', PERSON);
        work.write('d.txt', 'd\n');
        const tip = work.commit('Mine');
        expect(await inspect(service, work, tip, base)).toMatchObject({
            ok: false,
            reason: 'foreign_identity',
        });
    });

    const messages: Array<[string, string]> = [
        ['a co-author', 'Fix it\n\nCo-authored-by: Pat Person <pat@example.com>'],
        ['a sign-off by someone else', 'Fix it\n\nSigned-off-by: Maintainer <m@example.com>'],
        ['an email address', 'Fix it for pat@example.com'],
        ['a closing keyword', 'Fixes #12'],
        ['a closing keyword for another repository', 'closes acme/other#3'],
        ['a closing keyword with an address', 'Resolves https://github.com/acme/app/issues/9'],
        ['[skip ci]', 'Tidy [skip ci]'],
        ['[ci skip]', 'Tidy [ci skip]'],
        ['skip-checks: true', 'Tidy\n\nskip-checks: true'],
        ['a token', `Note cbsa_${'z'.repeat(43)}`],
    ];
    for (const [name, message] of messages) {
        it(`refuses a commit message with ${name}`, async () => {
            const { service, work, base } = await setup();
            work.write('a.txt', 'a\n');
            const head = work.commit(message);
            const verdict = await inspect(service, work, head, base);
            expect(verdict.ok).toBe(false);
        });
    }

    // The message checks read UTF-8; GitHub reads the declared encoding.
    it('refuses a commit that declares a non-UTF-8 encoding', async () => {
        const { service, work, base } = await setup();
        work.write('a.txt', 'a\n');
        work.git(['add', '-A']);
        work.git(['-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '--quiet', '-m', 'Latin']);
        const head = work.head();
        expect(work.git(['cat-file', 'commit', head])).toContain('encoding ISO-8859-1');
        expect(await inspect(service, work, head, base)).toMatchObject({
            ok: false,
            reason: 'commit_text',
        });
    });

    it('accepts trailers that name the socio itself, and plain issue mentions', async () => {
        const { service, work, base } = await setup();
        work.write('a.txt', 'a\n');
        const head = work.commit(`Refs issue #12 without closing it\n\nSigned-off-by: ${SOCIO.name} <${SOCIO.email}>`);
        expect(await inspect(service, work, head, base)).toMatchObject({
            ok: true,
        });
    });

    it('scans only added lines: a token already in the base doesn’t refuse an edit nearby', async () => {
        const root = tempDir('cb-coding-git-', cleanup);
        const service = new CodingGit({ dir: join(root, 'svc') });
        const work = workRepo(join(root, 'work'));
        work.write('docs/tokens.md', `Example: cbgw_${'E'.repeat(43)}\n\nMore text.\n`);
        const base = work.commit('docs', PERSON);
        await mirror(service, work);
        work.write('docs/tokens.md', `Example: cbgw_${'E'.repeat(43)}\n\nMore text, edited.\n`);
        const head = work.commit('Edit the docs');
        expect(await inspect(service, work, head, base)).toMatchObject({
            ok: true,
        });
    });

    it('accepts a clean merge of the base that brought .github changes, and refuses an evil merge', async () => {
        const { service, work, base } = await setup();
        work.git(['checkout', '--quiet', '-b', 'socio/rulo/ab12cd34']);
        work.write('src/feature.ts', 'export const x = 1;\n');
        const mine = work.commit('Feature');
        // A person changes CI on main, and it is mirrored.
        work.git(['checkout', '--quiet', 'main']);
        work.write('.github/workflows/ci.yml', 'on: push\n');
        const theirs = work.commit('CI', PERSON);
        await mirror(service, work);
        work.git(['checkout', '--quiet', 'socio/rulo/ab12cd34']);
        work.git(['merge', '--quiet', '--no-edit', '-m', 'Merge main', 'main']);
        const merged = work.head();
        expect(
            await service.inspect(
                {
                    repository: REPO,
                    commands: [{ old: ZERO, new: merged, ref: BRANCH }],
                    identity: SOCIO,
                },
                Readable.from([work.pack([merged], [theirs, base])]),
            ),
        ).toMatchObject({ ok: true, commits: 2 });
        // The same merge, but with its own change to CI.
        work.git(['reset', '--quiet', '--hard', mine]);
        work.git(['merge', '--quiet', '--no-commit', 'main']);
        work.write('.github/workflows/ci.yml', 'on: push\nrun: curl evil\n');
        work.git(['add', '-A']);
        work.git(['commit', '--quiet', '-m', 'Merge main']);
        const evil = work.head();
        expect(
            await service.inspect(
                {
                    repository: REPO,
                    commands: [{ old: ZERO, new: evil, ref: BRANCH }],
                    identity: SOCIO,
                },
                Readable.from([work.pack([evil], [theirs, base])]),
            ),
        ).toMatchObject({ ok: false, reason: 'protected_path' });
    });

    it('refuses a stale mirror’s base commits only until the mirror is refreshed', async () => {
        const { service, work, base } = await setup();
        // A person's commit on main that the mirror hasn't seen yet.
        work.write('x.txt', 'x\n');
        const theirs = work.commit('Theirs', PERSON);
        work.git(['checkout', '--quiet', '-b', 'socio/rulo/ab12cd34']);
        work.write('y.txt', 'y\n');
        const mine = work.commit('Mine');
        const pack = () => Readable.from([work.pack([mine], [base])]);
        const meta = {
            repository: REPO,
            commands: [{ old: ZERO, new: mine, ref: BRANCH }],
            identity: SOCIO,
        };
        expect(await service.inspect(meta, pack())).toMatchObject({
            ok: false,
            reason: 'foreign_identity',
        });
        await mirror(service, work);
        expect(await service.inspect(meta, Readable.from([work.pack([mine], [theirs])]))).toMatchObject({
            ok: true,
            commits: 1,
        });
    });

    it('refuses what isn’t a pack, a pack over the limit, too many commits, and a ref that isn’t a commit', async () => {
        const { service, work, base } = await setup({
            maxPushBytes: 64 * 1024,
            maxCommits: 2,
        });
        const meta = (head: string) => ({
            repository: REPO,
            commands: [{ old: ZERO, new: head, ref: BRANCH }],
            identity: SOCIO,
        });
        work.write('a.txt', 'a\n');
        const one = work.commit('one');
        expect(
            await service.inspect(meta(one), Readable.from([Buffer.from('not a pack at all, really not one')])),
        ).toMatchObject({
            ok: false,
            reason: 'pack_invalid',
        });
        expect(await service.inspect(meta(one), Readable.from([Buffer.alloc(70 * 1024, 1)]))).toMatchObject({
            ok: false,
            reason: 'pack_too_large',
        });
        work.write('b.txt', 'b\n');
        work.commit('two');
        work.write('c.txt', 'c\n');
        const three = work.commit('three');
        expect(await inspect(service, work, three, base)).toMatchObject({
            ok: false,
            reason: 'too_many_commits',
        });
        const tree = work.git(['rev-parse', 'HEAD^{tree}']);
        expect(await service.inspect(meta(tree), Readable.from([work.pack([three], [base])]))).toMatchObject({
            ok: false,
            reason: 'not_a_commit',
        });
    });

    // At most two inspections at once for the instance; a third waits without
    // reading its pack.
    it('runs at most two inspections at once', async () => {
        const { service, work, base } = await setup();
        const repositories = [REPO, 'acme/two', 'acme/three'];
        for (const repository of repositories.slice(1)) {
            await service.refresh(
                repository,
                { 'refs/heads/main': base },
                Readable.from([work.pack([base], [], false)]),
            );
        }
        const paused = () => {
            let started = false;
            const stream = new Readable({
                read() {
                    started = true;
                },
            });
            return { stream, started: () => started };
        };
        const packs = repositories.map(() => paused());
        const verdicts = repositories.map((repository, index) =>
            service.inspect(
                {
                    repository,
                    commands: [{ old: ZERO, new: base, ref: BRANCH }],
                    identity: SOCIO,
                },
                packs[index].stream,
            ),
        );
        await vi.waitFor(() => expect(packs.slice(0, 2).every((pack) => pack.started())).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(packs[2].started()).toBe(false);
        // The first ends (not a pack): the third starts.
        packs[0].stream.push(Buffer.alloc(64, 'x'));
        packs[0].stream.push(null);
        expect(await verdicts[0]).toMatchObject({
            ok: false,
            reason: 'pack_invalid',
        });
        await vi.waitFor(() => expect(packs[2].started()).toBe(true));
        for (const pack of packs.slice(1)) {
            pack.stream.push(null);
        }
        await Promise.all(verdicts);
    });

    it('refuses a push before its repository has a mirror', async () => {
        const root = tempDir('cb-coding-git-', cleanup);
        const service = new CodingGit({ dir: join(root, 'svc') });
        expect(
            await service.inspect(
                { repository: 'acme/none', commands: [], identity: SOCIO },
                Readable.from([Buffer.alloc(0)]),
            ),
        ).toMatchObject({ ok: false, reason: 'mirror_missing' });
    });

    it('refuses repository names that could leave its directory', async () => {
        const root = tempDir('cb-coding-git-', cleanup);
        const service = new CodingGit({ dir: join(root, 'svc') });
        for (const name of ['../etc', 'acme/../x', 'acme', '/abs/x', 'a/b/c']) {
            expect(() => service.mirrorPath(name)).toThrow();
        }
    });
});

describe('mirror', () => {
    it('follows GitHub’s refs: new ones set, gone ones deleted, ones without objects skipped', async () => {
        const { service, work } = await setup();
        work.git(['branch', 'topic']);
        await mirror(service, work);
        const tips = (await service.refs(REPO)).tips;
        expect(tips).toHaveLength(1);
        work.git(['branch', '-D', 'topic']);
        work.write('n.txt', 'n\n');
        const next = work.commit('next', PERSON);
        const result = await service.refresh(
            REPO,
            {
                'refs/heads/main': next,
                'refs/heads/ghost': 'f'.repeat(40),
                'refs/pull/1/head': next,
            },
            Readable.from([work.pack([next], tips, false)]),
        );
        expect(result.refs).toBe(1);
        expect((await service.refs(REPO)).tips).toEqual([next]);
    });
});

describe('extraction', () => {
    async function repo() {
        const root = tempDir('cb-coding-git-', cleanup);
        const service = new CodingGit({ dir: join(root, 'svc') });
        const work = workRepo(join(root, 'work'));
        work.write('src/a.ts', 'export const a = 1;\n');
        work.write('src/deep/b.ts', 'export const b = 2;\n');
        work.write('src/c.js', 'c\n');
        work.write('docs/guide.md', '# Guide\n');
        work.write('docs/api/ref.md', '# Ref\n');
        work.write('docs/notes.txt', 'notes\n');
        work.write('README.md', 'hi\n');
        work.symlink('src/link.ts', '../README.md');
        work.git(['add', '-A']);
        work.git(['update-index', '--add', '--cacheinfo', `160000,${'2'.repeat(40)},src/vendored`]);
        const commit = work.commitStaged('all', PERSON);
        await mirror(service, work);
        return { service, work, commit };
    }

    it('keeps only regular files under the approved prefixes and globs', async () => {
        const { service, commit } = await repo();
        const result = await service.extract(REPO, {
            commit,
            paths: ['src/', 'docs/**/*.md'],
            maxBytes: 1024 * 1024,
            maxFiles: 100,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.files.map((file) => file.path).sort()).toEqual([
            'docs/api/ref.md',
            'docs/guide.md',
            'src/a.ts',
            'src/c.js',
            'src/deep/b.ts',
        ]);
        // The symlink and the gitlink are dropped, not followed.
        expect(result.dropped).toBe(2);
        const a = result.files.find((file) => file.path === 'src/a.ts')!;
        expect(Buffer.from(a.content, 'base64').toString()).toBe('export const a = 1;\n');
    });

    it('fails rather than cutting short past the file or byte limit', async () => {
        const { service, commit } = await repo();
        expect(
            await service.extract(REPO, {
                commit,
                paths: ['src/'],
                maxBytes: 1024 * 1024,
                maxFiles: 2,
            }),
        ).toMatchObject({ ok: false, reason: 'too_large' });
        expect(
            await service.extract(REPO, {
                commit,
                paths: ['src/'],
                maxBytes: 10,
                maxFiles: 100,
            }),
        ).toMatchObject({ ok: false, reason: 'too_large' });
    });

    it('refuses invalid scopes and commits the mirror doesn’t have', async () => {
        const { service, commit } = await repo();
        for (const paths of [['../x'], ['/etc'], ['.git/config'], ['src/[ab].ts'], [], Array(21).fill('src/')]) {
            expect(
                await service.extract(REPO, {
                    commit,
                    paths,
                    maxBytes: 1024,
                    maxFiles: 10,
                }),
            ).toMatchObject({ ok: false, reason: 'paths_invalid' });
        }
        expect(
            await service.extract(REPO, {
                commit: 'e'.repeat(40),
                paths: ['src/'],
                maxBytes: 1024,
                maxFiles: 10,
            }),
        ).toMatchObject({ ok: false, reason: 'commit_missing' });
    });
});
