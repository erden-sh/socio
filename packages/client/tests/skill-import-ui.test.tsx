// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { SkillImportPreview } from '@socio/shared/chat/chat-skills';

import { SkillImportSection, skillImportDiff } from '../src/modules/settings/SkillImportSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, host: HTMLDivElement;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
});
const preview: SkillImportPreview = {
    id: 'x'.repeat(32),
    expiresAt: 123456,
    name: 'motion-design',
    description: 'Full imported description.',
    instructions: 'Full instructions.\n' + 'More steps.\n'.repeat(400) + 'FINAL_REVIEW_SENTINEL',
    mode: 'turn',
    source: {
        url: 'https://github.com/example/skills',
        path: 'skills/motion/SKILL.md',
        ref: 'main',
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
        license: 'MIT',
        licenseText: 'MIT License\nCopyright Example Author',
    },
    previous: {
        revision: 2,
        description: 'Previous description',
        instructions: 'Previous local instructions.',
    },
    warnings: ['Repository programs are never installed.'],
};
const input = (label: string, value: string) => {
    const element = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const until = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
    }
    throw Error('UI did not settle');
};

it('shows complete instructions, existing content and immutable provenance before explicit apply', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
        calls.push({ path, body: JSON.parse(String(init.body)) });
        return Response.json(path.endsWith('/preview') ? preview : { skill: { name: preview.name } });
    });
    const saved = vi.fn(async () => {});
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SkillImportSection onSaved={saved} />));
    input('Skill repository URL', preview.source.url);
    input('Skill source path', preview.source.path);
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => !!host.querySelector('[aria-label="Skill import preview"]'));
    expect(calls).toHaveLength(1);
    expect(host.textContent).toContain(preview.source.commit);
    expect(host.textContent).toContain('MIT');
    expect(host.querySelector('[aria-label="Imported skill instructions"]')?.textContent).toBe(preview.instructions);
    expect(host.querySelector('[aria-label="Current skill instructions"]')?.textContent).toBe(
        preview.previous!.instructions,
    );
    const apply = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Apply reviewed update',
    )!;
    act(() => apply.click());
    await until(() => saved.mock.calls.length === 1);
    expect(calls[1]).toEqual({
        path: '/api/chat-skills/import/apply',
        body: { previewId: preview.id, sha256: preview.source.sha256 },
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain('updated from commit aaaaaaa');
});

it('invalidates a displayed preview as soon as the source changes', async () => {
    const fetcher = vi.fn(async () => Response.json(preview));
    vi.stubGlobal('fetch', fetcher);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SkillImportSection onSaved={async () => {}} />));
    input('Skill repository URL', preview.source.url);
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await until(() => !!host.querySelector('[aria-label="Skill import preview"]'));
    input('Skill source ref', 'new-ref');
    expect(host.querySelector('[aria-label="Skill import preview"]')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it('shows changed lines with bounded surrounding context instead of an unbounded quadratic diff', () => {
    expect(skillImportDiff('same\nkeep\nold\nend\nlast', 'same\nkeep\nnew\nend\nlast')).toBe(
        ' same\n keep\n- old\n+ new\n end\n last',
    );
    expect(skillImportDiff('same', 'same')).toBe('');
});
