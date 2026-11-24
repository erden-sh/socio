// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CodingRepositoriesView, CodingRepositoryView } from '@socio/shared/coding/coding-repos';

import { CodingRepositoriesSection } from '../src/modules/coding/CodingRepositoriesSection';

// CB-239 in Settings: the repositories section is hidden while the
// server says the feature is off, and push can't be saved on until the
// admin confirms the checklist. Every control has a label (keyboard and
// screen readers). A repository's settings save as they change (CB-308);
// adding one is an action, with Add repository.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let routes: Record<string, (body: unknown) => [number, unknown]>;
let calls: { method: string; path: string; body: unknown }[];

const limits = {
    gitRequestsPerMinute: 30,
    tokensPerHour: 1000,
    tokensPerSessionHour: 200,
    extractMaxMb: 50,
    extractMaxFiles: 20000,
    extractRetentionHours: 24,
};
const repository = (fields: Partial<CodingRepositoryView> = {}): CodingRepositoryView => ({
    repository: 'acme/app',
    baseBranches: [],
    branchPrefix: 'socio',
    push: false,
    pushChecklist: null,
    users: null,
    extraction: false,
    standingExtraction: false,
    updatedAt: 1,
    updatedBy: 'olga',
    ...fields,
});
const view = (repositories: CodingRepositoryView[] = [repository()]): CodingRepositoriesView => ({
    repositories,
    limits,
    limitDefaults: limits,
    checklist: ['No secrets for socio/** workflows.', 'Secrets in environments.', 'Protected bases.'],
});

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    routes = { 'GET /api/gateway/repositories': () => [200, view()] };
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://localhost:3000');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const handler = routes[`${method} ${url.pathname}`];
        const [code, answer] = handler ? handler(body) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(answer), {
            status: code,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const checkbox = (label: string) =>
    [...host.querySelectorAll('label')]
        .find((entry) => entry.textContent?.includes(label))!
        .querySelector('button[role="checkbox"]') as HTMLButtonElement;

it('shows nothing while the server says the feature is off', async () => {
    routes['GET /api/gateway/repositories'] = () => [404, { error: 'Not available.' }];
    act(() => root.render(<CodingRepositoriesSection />));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.textContent).toBe('');
});

it('asks for the checklist before push can be turned on, and sends the confirmation', async () => {
    routes['PUT /api/gateway/repositories/acme/app'] = () => [
        200,
        view([
            repository({
                push: true,
                pushChecklist: { at: 2, by: 'olga' },
                updatedAt: 2,
            }),
        ]),
    ];
    act(() => root.render(<CodingRepositoriesSection />));
    await until(() => !!button('Check GitHub App'), 'the section');
    expect(button('Save')).toBeUndefined();
    // Every input is labeled.
    for (const input of host.querySelectorAll('input')) {
        expect(host.querySelector(`label[for="${input.id}"]`), input.id).not.toBeNull();
    }
    act(() => checkbox('may push').click());
    await until(() => !!host.querySelector('[data-slot="push-checklist"]'), 'the checklist');
    // Ticking push saves nothing until the checklist is confirmed.
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
    expect(button('Turn on push')!.disabled).toBe(true);
    act(() => checkbox('I confirmed these').click());
    await until(() => !button('Turn on push')!.disabled, 'Turn on push enabled');
    act(() => button('Turn on push')!.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save');
    expect(calls.find((call) => call.method === 'PUT')!.body).toMatchObject({
        push: true,
        pushChecklistConfirmed: true,
        users: null,
    });
    await until(() => host.querySelector('[data-slot="save-status"]')!.textContent === 'Saved', 'Saved');
    expect(host.querySelector('[data-slot="push-checklist"]')).toBeNull();
});

it('saves a repository’s fields as they are left, and says why a save failed', async () => {
    let answer: [number, unknown] = [200, view([repository({ baseBranches: ['main', 'develop'], updatedAt: 2 })])];
    routes['PUT /api/gateway/repositories/acme/app'] = () => answer;
    act(() => root.render(<CodingRepositoriesSection />));
    await until(() => !!host.querySelector('#acme-app-bases'), 'the section');
    const bases = host.querySelector<HTMLInputElement>('#acme-app-bases')!;
    const type = (value: string) =>
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(bases, value);
            bases.dispatchEvent(new Event('input', { bubbles: true }));
        });
    const leave = () =>
        act(async () => {
            bases.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
    const puts = () => calls.filter((call) => call.method === 'PUT');
    await leave();
    expect(puts()).toEqual([]);
    type('main,develop ');
    await leave();
    await until(() => puts().length === 1, 'the save');
    expect(puts()[0].body).toMatchObject({
        baseBranches: ['main', 'develop'],
        push: false,
    });
    // Turning push off or on is the only save without the confirmation.
    expect(puts()[0].body).not.toHaveProperty('pushChecklistConfirmed');
    await until(() => bases.value === 'main, develop', 'the saved list');
    answer = [409, { error: 'Base branches must exist on GitHub.' }];
    type('nope');
    await leave();
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Base branches must exist on GitHub.');
    expect(bases.value).toBe('main, develop');
});

it('refuses a malformed repository name before asking the server', async () => {
    act(() => root.render(<CodingRepositoriesSection />));
    await until(() => !!button('Add repository'), 'the section');
    const input = host.querySelector('#coding-repository-add') as HTMLInputElement;
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, '../etc');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => button('Add repository')!.click());
    await until(() => !!host.querySelector('[role="alert"]'), 'the error');
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
});
