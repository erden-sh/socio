import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateSnapshot } from '@copilotkit/runtime/internal/learned-skills';
import { afterEach, expect, it } from 'vitest';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const skills = (path?: string) => {
    const workspace = new WorkspaceStore(path ?? testDatabase());
    cleanup.push(() => workspace.close());
    return workspace.skills;
};
const md = (body: string) => `---\nname: weekly-report\ndescription: Weekly reports\n---\n${body}\n`;

it('round-trips published skills through a snapshot the runtime accepts', async () => {
    const store = skills();
    const report = store.saveRevision(
        'research',
        'weekly-report',
        'Write the weekly report from the team’s notes',
        [
            { path: 'SKILL.md', content: md('Collect, then summarize.') },
            { path: 'templates/outline.md', content: '# Outline\n- Wins\n- Risks' },
        ],
        'alice',
    );
    const sources = store.saveRevision(
        'research',
        'cite-sources',
        'Cite primary sources',
        [{ path: 'SKILL.md', content: 'Always link the primary source.' }],
        'alice',
    );
    store.publish(report.id, 'alice');
    store.publish(sources.id, 'alice');
    const snapshot = store.snapshot('research');
    expect(snapshot.revision).toBe('research@2');
    expect(snapshot.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const verified = await validateSnapshot(snapshot);
    expect(verified.skills.map((skill) => skill.name)).toEqual(['cite-sources', 'weekly-report']);
    const weekly = verified.skills[1];
    expect(weekly.description).toBe('Write the weekly report from the team’s notes');
    expect(weekly.files.map((file) => [file.path, file.text])).toEqual([
        ['SKILL.md', md('Collect, then summarize.')],
        ['templates/outline.md', '# Outline\n- Wins\n- Risks'],
    ]);
    const empty = store.snapshot('elsewhere');
    expect(empty.revision).toBe('elsewhere@0');
    expect((await validateSnapshot(empty)).skills).toEqual([]);
});

it('builds byte-identical snapshots for the same published state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = testDatabaseFile(join(dir, 'db.sqlite'));
    let store = skills(path);
    const files = [
        { path: 'z.md', content: 'last' },
        { path: 'SKILL.md', content: md('Do it.') },
    ];
    store.publish(store.saveRevision('c', 'weekly-report', 'Weekly', files, 'alice', 10).id, 'alice', 20);
    const first = store.snapshot('c');
    expect(Buffer.from(store.snapshot('c').bytes)).toEqual(Buffer.from(first.bytes));
    cleanup.pop()?.(); // close, keeping the file
    store = skills(path);
    const reopened = store.snapshot('c');
    expect(reopened.etag).toBe(first.etag);
    expect(Buffer.from(reopened.bytes)).toEqual(Buffer.from(first.bytes));
});

it('keeps revisions immutable and delivers a pinned container revision', async () => {
    const store = skills();
    const v1 = store.saveRevision(
        'c',
        'weekly-report',
        'Weekly',
        [{ path: 'SKILL.md', content: md('Version one.') }],
        'alice',
    );
    store.publish(v1.id, 'alice');
    const v2 = store.saveRevision(
        'c',
        'weekly-report',
        'Weekly, improved',
        [{ path: 'SKILL.md', content: md('Version two.') }],
        'alice',
    );
    expect(v2.revision).toBe(2);
    expect(store.skillRevision(v1.id)!.files[0].content).toContain('one');
    store.publish(v2.id, 'alice');
    const text = async () => (await validateSnapshot(store.snapshot('c'))).skills[0]?.files[0].text;
    expect(await text()).toContain('Version two.');
    store.pin('c', 1);
    expect(await text()).toContain('Version one.');
    expect(store.published('c').map((s) => s.revision)).toEqual([2]);
    store.pin('c', null);
    expect(await text()).toContain('Version two.');
    store.revoke('c', 'weekly-report', 'alice');
    expect((await validateSnapshot(store.snapshot('c'))).skills).toEqual([]);
    expect(store.history('c', 'weekly-report').map((s) => s.revision)).toEqual([2, 1]);
    expect(() => store.pin('c', 99)).toThrow('not found');
    expect(() => store.revoke('c', 'weekly-report', 'alice')).toThrow('not published');
});

it('lists revoked skills, newest first, until they are published again', () => {
    const store = skills();
    const save = (name: string, description: string, at: number) =>
        store.saveRevision('c', name, description, [{ path: 'SKILL.md', content: md(description) }], 'alice', at);
    store.publish(save('weekly-report', 'Weekly', 1).id, 'alice', 1);
    store.publish(save('cite-sources', 'Cite', 2).id, 'alice', 2);
    store.publish(save('weekly-report', 'Weekly, v2', 3).id, 'alice', 3);
    expect(store.revoked('c')).toEqual([]);
    store.revoke('c', 'weekly-report', 'alice', 4);
    store.revoke('c', 'cite-sources', 'alice', 5);
    // The description of the revision last delivered.
    expect(store.revoked('c')).toEqual([
        { name: 'cite-sources', description: 'Cite', revokedAt: 5 },
        { name: 'weekly-report', description: 'Weekly, v2', revokedAt: 4 },
    ]);
    store.publish(save('cite-sources', 'Cite again', 6).id, 'alice', 6);
    expect(store.revoked('c').map((skill) => skill.name)).toEqual(['weekly-report']);
    expect(store.revoked('other')).toEqual([]);
});

it('rejects unsafe names, paths and missing SKILL.md', () => {
    const store = skills();
    const ok = [{ path: 'SKILL.md', content: 'x' }];
    expect(() => store.saveRevision('c', 'Bad Name', 'd', ok, 'a')).toThrow();
    expect(() => store.saveRevision('c', 'a/b', 'd', ok, 'a')).toThrow();
    expect(() => store.saveRevision('c', 'ok', 'd', [{ path: 'x.md', content: '' }], 'a')).toThrow('SKILL.md');
    for (const path of ['../x', '/abs', 'a//b', 'a\\b', 'C:/x', './x']) {
        expect(() => store.saveRevision('c', 'ok', 'd', [...ok, { path, content: '' }], 'a')).toThrow(
            'Invalid skill file path',
        );
    }
    expect(() => store.saveRevision('c', 'ok', 'd', [...ok, { ...ok[0] }], 'a')).toThrow('Duplicate');
});
