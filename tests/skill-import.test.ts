import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { assertSkillsFit } from '@socio/foundation/skills/chat-skill';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import type { WorkspaceSkillsRepository } from '../src/server/skills/contract.js';
import { provenanceOf } from '../src/server/skills/domain/repositories.js';
import { GitHubSkillImporter, githubSource, parseSkillDocument } from '../src/server/skills/github-import.js';
import { chatSkills } from '../src/server/skills/registry.js';
import { skillsRepository, skillSessions } from '../src/server/skills/repository.js';
import { chatSkillRoutes } from '../src/server/skills/routes.js';
import { workspaceSkillTools } from '../src/server/skills/tools.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const close: Array<() => void> = [];
afterEach(() => {
    close.splice(0).forEach((fn) => fn());
    vi.restoreAllMocks();
});
const source = {
    url: 'https://github.com/example/design-skills',
    ref: 'main',
    path: 'skills/design-motion/SKILL.md',
};
const commit = 'a'.repeat(40),
    root = 'b'.repeat(40),
    skillsTree = 'c'.repeat(40),
    skillTree = 'd'.repeat(40);
const blob = (text: string | Buffer) => {
    const bytes = Buffer.from(text);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return {
        sha,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
    };
};
function fixture(repository?: WorkspaceSkillsRepository) {
    if (!repository) {
        const db = testDatabase();
        close.push(() => db.close());
        repository = skillsRepository(db);
    }
    const description = 'Design a reusable motion showcase. '.repeat(24).trim();
    const instructions =
        '# Motion design\n' +
        '1. Inspect the provided design and preserve its content.\n'.repeat(720) +
        '\nAttribution is preserved.\n';
    const document = `---\nname: design-motion\ndescription: ${JSON.stringify(description)}\n---\n${instructions}`;
    const skillBlob = blob(document),
        licenseBlob = blob('MIT License\nCopyright (c) Example author\nPermission is hereby granted.\n');
    const rootEntries = [
        { path: 'skills', mode: '040000', type: 'tree', sha: skillsTree },
        {
            path: 'LICENSE',
            mode: '100644',
            type: 'blob',
            sha: licenseBlob.sha,
            size: licenseBlob.size,
        },
    ];
    const leaf = {
        path: 'SKILL.md',
        mode: '100644',
        type: 'blob',
        sha: skillBlob.sha,
        size: skillBlob.size,
    };
    const data = new Map<string, unknown>([
        ['commits/main', { sha: commit, commit: { tree: { sha: root } } }],
        ['commits/stable', { sha: commit, commit: { tree: { sha: root } } }],
        [`git/trees/${root}`, { sha: root, truncated: false, tree: rootEntries }],
        [
            `git/trees/${skillsTree}`,
            {
                sha: skillsTree,
                truncated: false,
                tree: [
                    {
                        path: 'design-motion',
                        mode: '040000',
                        type: 'tree',
                        sha: skillTree,
                    },
                ],
            },
        ],
        [`git/trees/${skillTree}`, { sha: skillTree, truncated: false, tree: [leaf] }],
        [`git/blobs/${skillBlob.sha}`, skillBlob],
        [`git/blobs/${licenseBlob.sha}`, licenseBlob],
    ]);
    const read = vi.fn(async (url: URL) => {
        expect(url.origin).toBe('https://api.github.com');
        const key = url.pathname.replace('/repos/example/design-skills/', '');
        if (!data.has(key)) {
            throw Error(`Unexpected fixture request: ${key}`);
        }
        const value = data.get(key);
        return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
    });
    let now = 1000;
    const importer = new GitHubSkillImporter(repository, {
        read,
        now: () => now,
    });
    return {
        repository,
        importer,
        read,
        data,
        rootEntries,
        leaf,
        skillBlob,
        instructions,
        description,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

it('previews full long source text, then applies exactly its pinned content with attributed license and provenance', async () => {
    const f = fixture();
    const preview = await f.importer.preview('alice', source);
    expect(preview).toMatchObject({
        name: 'design-motion',
        description: f.description,
        instructions: f.instructions,
        previous: null,
        source: { ...source, commit, license: 'Repository license (review text)' },
    });
    expect(preview.instructions.length).toBeGreaterThan(38_000);
    expect(preview.description.length).toBeGreaterThan(200);
    expect(await f.repository.list()).toEqual([]);
    const before = f.read.mock.calls.length;
    const installed = await f.importer.apply('alice', {
        previewId: preview.id,
        sha256: preview.source.sha256,
    });
    expect(f.read).toHaveBeenCalledTimes(before);
    expect(installed).toMatchObject({
        name: 'design-motion',
        instructions: f.instructions,
        source: 'git',
        sourceCommit: commit,
        sourcePath: source.path,
        createdBy: 'alice',
        revision: 1,
    });
    expect(provenanceOf(installed)).toMatchObject({
        license: 'Repository license (review text)',
        licenseText: expect.stringContaining('Copyright (c) Example author'),
        sha256: preview.source.sha256,
        locallyModified: false,
    });
    expect((await chatSkills(f.repository).list()).at(-1)?.lock).toMatchObject({
        source: 'git',
        commit,
        sourceSha256: preview.source.sha256,
        license: 'Repository license (review text)',
        locallyModified: false,
    });
    await expect(
        f.importer.apply('alice', {
            previewId: preview.id,
            sha256: preview.source.sha256,
        }),
    ).rejects.toThrow(/preview/i);
});

it('preserves provenance across local edits, explicit updates and rollback without making duplicate imports', async () => {
    const f = fixture();
    const apply = async (ref = 'main') => {
        const p = await f.importer.preview('alice', { ...source, ref });
        return f.importer.apply('alice', {
            previewId: p.id,
            sha256: p.source.sha256,
        });
    };
    const first = await apply();
    expect((await apply()).revision).toBe(1);
    const edited = await f.repository.save({ ...first, instructions: first.instructions + '\nLocal note.\n' }, 'alice');
    expect(edited.revision).toBe(2);
    expect(provenanceOf(edited)).toMatchObject({ commit, locallyModified: true });
    const restored = await f.repository.rollback(first.name, 1, 'alice');
    expect(restored).toMatchObject({ revision: 3, instructions: f.instructions });
    expect(provenanceOf(restored!)).toMatchObject({
        commit,
        locallyModified: false,
    });
    const updatedRef = await apply('stable');
    expect(updatedRef).toMatchObject({ revision: 4, sourceRef: 'stable' });
    const rollback = await f.repository.rollback(first.name, 3, 'alice');
    expect(rollback).toMatchObject({ revision: 5, sourceRef: 'main' });
    expect((await f.repository.revisions(first.name)).map((revision) => revision.sourceCommit)).toEqual([
        commit,
        commit,
        commit,
        commit,
        commit,
    ]);
});

it('binds previews to their admin, digest, expiry and unchanged destination revision', async () => {
    const f = fixture();
    const p = await f.importer.preview('alice', source);
    const input = { previewId: p.id, sha256: p.source.sha256 };
    await expect(f.importer.apply('bob', input)).rejects.toThrow(/preview/i);
    await expect(f.importer.apply('alice', { ...input, sha256: '0'.repeat(64) })).rejects.toThrow(/preview/i);
    p.instructions = 'Caller cannot alter cached review content.';
    expect((await f.importer.apply('alice', input)).instructions).toBe(f.instructions);
    const stale = await f.importer.preview('alice', source);
    await f.repository.save(
        {
            name: stale.name,
            description: 'Local edit',
            instructions: 'Keep this local edit.',
            mode: 'turn',
        },
        'alice',
    );
    await expect(
        f.importer.apply('alice', {
            previewId: stale.id,
            sha256: stale.source.sha256,
        }),
    ).rejects.toThrow(/changed since preview/);
    expect((await f.repository.get(stale.name))?.instructions).toBe('Keep this local edit.');
    const expired = await f.importer.preview('alice', source);
    f.advance(10 * 60_000 + 1);
    await expect(
        f.importer.apply('alice', {
            previewId: expired.id,
            sha256: expired.source.sha256,
        }),
    ).rejects.toThrow(/expired/);
});

it('rejects arbitrary URLs, encoded/traversing paths, submodules, symlinks, executable files and truncated trees before installing', async () => {
    for (const url of [
        'http://github.com/example/repo',
        'https://github.com.evil/example/repo',
        'https://token@github.com/example/repo',
        'https://github.com/example/repo?token=x',
        'https://127.0.0.1/example/repo',
        'https://github.com/example/repo#fragment',
        'https://github.com/example/repo/extra',
    ]) {
        expect(() => githubSource({ ...source, url })).toThrow();
    }
    for (const path of [
        '../SKILL.md',
        '/SKILL.md',
        'skills//SKILL.md',
        'skills/%2e%2e/SKILL.md',
        'skills\\SKILL.md',
        'skills/%2f/SKILL.md',
        'skills/script.sh',
        Array(13).fill('directory').join('/') + '/SKILL.md',
    ]) {
        expect(() => githubSource({ ...source, path })).toThrow();
    }
    for (const [type, mode] of [
        ['blob', '120000'],
        ['commit', '160000'],
    ]) {
        const f = fixture();
        f.rootEntries[0].type = type;
        f.rootEntries[0].mode = mode;
        await expect(f.importer.preview('alice', source)).rejects.toThrow(/symlinks|submodules/);
        expect(f.read.mock.calls.some(([url]) => url.pathname.includes('git/blobs/'))).toBe(false);
    }
    for (const mode of ['120000', '160000', '100755']) {
        const f = fixture();
        f.leaf.mode = mode;
        await expect(f.importer.preview('alice', source)).rejects.toThrow(/ordinary non-executable/);
    }
    const truncated = fixture();
    truncated.data.set(`git/trees/${root}`, {
        sha: root,
        truncated: true,
        tree: truncated.rootEntries,
    });
    await expect(truncated.importer.preview('alice', source)).rejects.toThrow(/incomplete/);
});

it('refuses mismatched or missing identity for every tree before reading its entries', async () => {
    for (const sha of [root, skillsTree, skillTree]) {
        for (const actual of ['f'.repeat(40), undefined]) {
            const f = fixture();
            f.data.set(`git/trees/${sha}`, {
                ...(f.data.get(`git/trees/${sha}`) as Record<string, unknown>),
                sha: actual,
            });
            await expect(f.importer.preview('alice', source)).rejects.toThrow(/different tree.*pinned commit/);
            expect(f.read.mock.calls.some(([url]) => url.pathname.includes('git/blobs/'))).toBe(false);
            expect(await f.repository.list()).toEqual([]);
        }
    }
});

it('rejects deleted-and-recreated destinations even when their revision numbers and content match', async () => {
    const f = fixture();
    const first = await f.importer.preview('alice', source);
    await f.importer.apply('alice', {
        previewId: first.id,
        sha256: first.source.sha256,
    });
    const stale = await f.importer.preview('alice', source);
    const old = (await f.repository.get(stale.name))!;
    await f.repository.remove(old.name, 'alice');
    const recreated = await f.repository.save(old, 'alice');
    expect(recreated.revision).toBe(1);
    expect(recreated.id).not.toBe(old.id);
    await expect(
        f.importer.apply('alice', {
            previewId: stale.id,
            sha256: stale.source.sha256,
        }),
    ).rejects.toThrow(/changed since preview/);
});

it('keeps a bounded preview cache and makes concurrent application single-use', async () => {
    const f = fixture();
    const first = await f.importer.preview('alice', source);
    let newest = first;
    for (let index = 0; index < 20; index++) {
        newest = await f.importer.preview('alice', source);
    }
    await expect(
        f.importer.apply('alice', {
            previewId: first.id,
            sha256: first.source.sha256,
        }),
    ).rejects.toThrow(/preview/);
    const input = { previewId: newest.id, sha256: newest.source.sha256 };
    const results = await Promise.allSettled([f.importer.apply('alice', input), f.importer.apply('alice', input)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await f.repository.get(newest.name))?.revision).toBe(1);
});

it('caps in-flight network previews and releases the capacity after failure', async () => {
    const f = fixture();
    const rejectors: Array<(error: Error) => void> = [];
    const read = vi.fn<(url: URL, max: number, signal: AbortSignal) => Promise<{ value: unknown; bytes: number }>>();
    read.mockImplementation(() => new Promise((_resolve, reject) => rejectors.push(reject)));
    const importer = new GitHubSkillImporter(f.repository, { read });
    const first = importer.preview('alice', source),
        second = importer.preview('alice', source);
    await expect(importer.preview('alice', source)).rejects.toThrow(/already being previewed/);
    rejectors.forEach((reject) => reject(Error('Fixture network failure')));
    await Promise.allSettled([first, second]);
    read.mockImplementation(f.read);
    expect((await importer.preview('alice', source)).name).toBe('design-motion');
});

it('checks byte budgets, tree/blob integrity, invalid UTF-8 and license bounds without truncating source', async () => {
    const large = fixture();
    large.leaf.size = 128 * 1024 + 1;
    await expect(large.importer.preview('alice', source)).rejects.toThrow(/size limit/);
    const changed = fixture();
    changed.data.set(`git/blobs/${changed.skillBlob.sha}`, {
        ...changed.skillBlob,
        content: Buffer.from('different').toString('base64'),
        size: 9,
    });
    await expect(changed.importer.preview('alice', source)).rejects.toThrow(/pinned tree hash/);
    const oversize = fixture();
    const importer = new GitHubSkillImporter(oversize.repository, {
        read: async () => ({ value: {}, bytes: 512 * 1024 + 1 }),
    });
    await expect(importer.preview('alice', source)).rejects.toThrow(/bounded import budget/);
    const invalid = fixture();
    const bad = blob(Buffer.from([0xff, 0xff]));
    invalid.leaf.sha = bad.sha;
    invalid.leaf.size = bad.size;
    invalid.data.set(`git/blobs/${bad.sha}`, bad);
    await expect(invalid.importer.preview('alice', source)).rejects.toThrow();
    const license = fixture();
    license.rootEntries[1].size = 32 * 1024 + 1;
    await expect(license.importer.preview('alice', source)).rejects.toThrow(/license/);
});

it('requires an explicitly supplied immutable commit to match the resolved GitHub commit exactly', async () => {
    const f = fixture();
    const pin = 'f'.repeat(40);
    f.data.set(`commits/${pin}`, {
        sha: commit,
        commit: { tree: { sha: root } },
    });
    await expect(f.importer.preview('alice', { ...source, ref: pin })).rejects.toThrow(
        /different commit.*explicitly pinned/,
    );
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(await f.repository.list()).toEqual([]);
});

it('parses bounded scalar frontmatter without evaluating YAML or silently dropping content', () => {
    expect(
        parseSkillDocument('---\nname: safe-skill\ndescription: >-\n  A reusable\n  procedure.\n---\n\nExact body.\n'),
    ).toMatchObject({
        name: 'safe-skill',
        description: 'A reusable procedure.',
        instructions: '\nExact body.\n',
    });
    for (const header of [
        'name: help\ndescription: x',
        'name: safe\nname: other\ndescription: x',
        'name: safe\ndescription: !run shell',
        'name: safe\ndescription: &anchor value',
        'name: safe\ndescription:\n  nested: value',
    ]) {
        expect(() => parseSkillDocument(`---\n${header}\n---\nInstructions.`)).toThrow();
    }
    expect(() => parseSkillDocument(`---\nname: safe\ndescription: ${'x'.repeat(2001)}\n---\nInstructions.`)).toThrow(
        /descriptions/,
    );
    expect(() => parseSkillDocument(`---\nname: safe\ndescription: safe\n---\n${'x'.repeat(64001)}`)).toThrow(
        /instructions/,
    );
});

it('refuses oversized protected skill notes for small models without altering runtime context budgets or truncating instructions', async () => {
    const f = fixture();
    const preview = await f.importer.preview('alice', source);
    await f.importer.apply('alice', {
        previewId: preview.id,
        sha256: preview.source.sha256,
    });
    const skill = (await chatSkills(f.repository).list()).find((item) => item.name === preview.name)!;
    expect(() => assertSkillsFit([skill], { acceptsImages: false, contextWindow: 4096 })).toThrow(
        /larger-context model.*no instructions were truncated/,
    );
    expect(() => assertSkillsFit([skill], { acceptsImages: false, contextWindow: 65536 })).not.toThrow();
    expect(skill.instructions).toBe(f.instructions);
});

it('guards preview/apply routes and tools with current admin authority and preserves manual authoring limits', async () => {
    const workspace = new WorkspaceStore(testDatabase());
    close.push(() => workspace.close());
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const repository = skillsRepository(workspace.db);
    const f = fixture(repository);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set(
            'user',
            workspace.users().find((user) => user.id === (c.req.header('X-User') ?? 'alice'))!,
        );
        await next();
    });
    app.route(
        '/',
        chatSkillRoutes({
            registry: chatSkills(repository),
            repository,
            sessions: skillSessions(workspace.db),
            workspace,
            importer: f.importer,
        }),
    );
    const request = (path: string, data: unknown, user = 'alice') =>
        app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-User': user },
            body: JSON.stringify(data),
        });
    expect((await request('/chat-skills/import/preview', source, 'bob')).status).toBe(403);
    const response = await request('/chat-skills/import/preview', source);
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(
        (await request('/chat-skills/import/apply', { previewId: preview.id, sha256: preview.source.sha256 }, 'bob'))
            .status,
    ).toBe(403);
    expect(
        (
            await request('/chat-skills/import/apply', {
                previewId: preview.id,
                sha256: preview.source.sha256,
            })
        ).status,
    ).toBe(200);
    const edit = await app.request('/chat-skills/design-motion', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            description: f.description,
            instructions: f.instructions + '\nLocal edit.',
            mode: 'turn',
        }),
    });
    expect(edit.status).toBe(200);
    expect(provenanceOf((await repository.get('design-motion'))!)?.locallyModified).toBe(true);
    const manual = await app.request('/chat-skills/new-manual', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            description: 'Manual',
            instructions: 'x'.repeat(4001),
            mode: 'turn',
        }),
    });
    expect(manual.status).toBe(400);
    const tools = workspaceSkillTools(
        { userId: 'alice', check: vi.fn() },
        repository,
        workspace,
        f.importer,
    ) as unknown as Array<{
        name: string;
        execute(input: unknown): Promise<unknown>;
    }>;
    const call = (name: string, input: unknown) => tools.find((tool) => tool.name === name)!.execute(input);
    const toolPreview = (await call('preview_workspace_skill_import', source)) as {
        preview: { id: string; source: { sha256: string } };
    };
    expect(toolPreview.preview.id).toBeTruthy();
    const original = workspace.users();
    vi.spyOn(workspace, 'users').mockReturnValue(
        original.map((user) => (user.id === 'alice' ? { ...user, role: 'member' } : user)),
    );
    expect(
        await call('apply_workspace_skill_import', {
            previewId: toolPreview.preview.id,
            sha256: toolPreview.preview.source.sha256,
        }),
    ).toMatchObject({ error: expect.stringContaining('admin') });
});
