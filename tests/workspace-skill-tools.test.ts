import { afterEach, expect, it, test, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import type { ModuleContext } from '../src/server/modules/contract.js';
import { chatSkillsModule } from '../src/server/skills/module.js';
import { skillsRepository } from '../src/server/skills/repository.js';

import { testModuleServices } from './helpers/module-services.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const close of cleanup.splice(0)) {
        close();
    }
});

type Tool = { name: string; execute: (input: unknown) => Promise<unknown> };
function fixture(userId = 'alice') {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const check = vi.fn();
    const tools = chatSkillsModule.dotTools!(
        { db: workspace.db, services: testModuleServices({ workspace }) } as unknown as ModuleContext,
        {
            userId,
            check,
            dot: workspace.dots()[0],
            threadId: 'skill-tools-thread',
            channel: false,
            purpose: 'chat',
            signal: new AbortController().signal,
            toolNames: () => [],
        } satisfies DotTurn,
    ) as unknown as Tool[];
    const call = (name: string, input: unknown = {}) => tools.find((tool) => tool.name === name)!.execute(input);
    return { workspace, check, call, repository: skillsRepository(workspace.db) };
}
const content = {
    name: 'unfurl',
    description: 'Import the full source of a link.',
    instructions: 'Read the requested link and save its full source.',
    mode: 'turn',
};

it('exposes skill management through the module and saves revisions attributed to the acting admin', async () => {
    const { call, repository } = fixture();
    expect(await call('save_workspace_skill', content)).toMatchObject({
        skill: { ...content, revision: 1, createdBy: 'alice', updatedBy: 'alice' },
    });
    expect(await call('save_workspace_skill', content)).toMatchObject({
        skill: { revision: 1 },
    });
    await call('save_workspace_skill', {
        ...content,
        instructions: 'Read the source and preserve attribution.',
        mode: 'until-done',
    });
    expect(await call('read_workspace_skill', { name: content.name })).toMatchObject({
        skill: { revision: 2, mode: 'until-done' },
        revisions: [
            { revision: 2, createdBy: 'alice' },
            { revision: 1, createdBy: 'alice' },
        ],
    });
    expect(await repository.list()).toHaveLength(1);
    expect(await call('read_workspace_skill', { name: 'missing' })).toHaveProperty('error');
});

it('lets members discover skills without exposing instructions, provenance or admin mutations', async () => {
    const { call, repository } = fixture('bob');
    await repository.save({ ...content, mode: 'turn' }, 'alice');
    const listed = (await call('list_workspace_skills')) as {
        skills: Record<string, unknown>[];
    };
    expect(listed.skills.map((skill) => skill.name)).toContain('compact');
    expect(listed.skills.at(-1)).toMatchObject({
        name: 'unfurl',
        builtIn: false,
    });
    for (const skill of listed.skills) {
        expect(skill).not.toHaveProperty('instructions');
        expect(skill).not.toHaveProperty('lock');
    }
    expect(await call('read_workspace_skill', { name: content.name })).toHaveProperty('error');
    expect(
        await call('save_workspace_skill', {
            ...content,
            userId: 'alice',
            role: 'admin',
        }),
    ).toHaveProperty('error');
    expect(await repository.revisions(content.name)).toHaveLength(1);
});

it('rechecks roles on every call, including missing users, and allows operators', async () => {
    const { workspace, call, repository } = fixture();
    const user = workspace.users().find((user) => user.id === 'alice')!;
    const users = vi.spyOn(workspace.slices.people, 'users');
    users.mockReturnValue([{ ...user, role: 'member' }]);
    expect(await call('save_workspace_skill', content)).toHaveProperty('error');
    users.mockReturnValue([]);
    expect(await call('read_workspace_skill', { name: 'unfurl' })).toHaveProperty('error');
    expect(await call('save_workspace_skill', content)).toHaveProperty('error');
    users.mockReturnValue([{ ...user, role: 'admin' }]);
    expect(await call('save_workspace_skill', content)).toHaveProperty('skill');
    expect(await repository.revisions(content.name)).toHaveLength(1);
});

it('rejects built-in names and invalid content without writing and checks cancelled turns', async () => {
    const { call, check, repository } = fixture();
    for (const change of [
        { name: 'compact' },
        { name: 'threads' },
        { name: 'Bad_Name' },
        { instructions: ' ' },
        { description: 'x'.repeat(1000) },
        { instructions: 'x'.repeat(100_000) },
        { mode: 'forever' },
    ]) {
        expect(await call('save_workspace_skill', { ...content, ...change })).toHaveProperty('error');
    }
    expect(await repository.list()).toEqual([]);
    check.mockImplementation(() => {
        throw new Error('Turn stopped');
    });
    for (const name of ['list_workspace_skills', 'read_workspace_skill', 'save_workspace_skill']) {
        await expect(call(name, content)).rejects.toThrow('Turn stopped');
    }
});

test.each(['admin'] as const)(
    'denies a retained %s actor read/save after deactivation during its turn',
    async (role) => {
        const { workspace, call, repository } = fixture();
        const user = workspace.users().find((user) => user.id === 'alice')!;
        workspace.recordUser({ ...user, role });
        let deactivated: string[] = [];
        workspace.useDeactivated(() => deactivated);
        await call('save_workspace_skill', content);
        expect(await call('read_workspace_skill', { name: content.name })).toHaveProperty('skill');

        // Deactivation preserves historical identity and role; the same tools
        // created before deactivation must deny new privileged work.
        deactivated = ['alice'];
        expect(workspace.users().find((user) => user.id === 'alice')?.role).toBe(role);
        expect(await call('read_workspace_skill', { name: content.name })).toHaveProperty('error');
        expect(
            await call('save_workspace_skill', {
                ...content,
                instructions: 'Changed after deactivation.',
            }),
        ).toHaveProperty('error');
        expect(
            await call('save_workspace_skill', {
                ...content,
                name: 'new-after-deactivation',
            }),
        ).toHaveProperty('error');
        expect(await repository.revisions(content.name)).toHaveLength(1);
        expect(await repository.get('new-after-deactivation')).toBeUndefined();

        deactivated = [];
        expect(
            await call('save_workspace_skill', {
                ...content,
                instructions: 'Changed after reactivation.',
            }),
        ).toHaveProperty('skill');
        expect(await repository.revisions(content.name)).toHaveLength(2);
    },
);
