// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FieldSettingEntry, FieldSettingsResponse } from '@socio/shared/dataset-views/contract';

import { FieldsPanel } from '../src/modules/dataspace/FieldsPanel';

// The Fields panel (CB-451): for people who may write the dataset,
// each field's kind (only those its column type takes), label and
// settings, saved with the version it was opened at; removing options
// rows still use asks first, and a save someone beat reloads the field.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const entry = (field: string, patch: Partial<FieldSettingEntry> = {}): FieldSettingEntry => ({
    field,
    label: field,
    kind: 'text',
    fallback: 'text',
    editable: true,
    required: false,
    isKey: false,
    settings: {},
    type: 'TEXT',
    kinds: ['text', 'long_text', 'select'],
    version: 0,
    ...patch,
});

let answer: FieldSettingsResponse;
/** Per path: another table's answer, and a read held back until released. */
let answers: Record<string, FieldSettingsResponse>;
let held: Record<string, Promise<void>>;
let replies: Array<{ status: number; body: unknown }>;
let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    replies = [];
    answers = {};
    held = {};
    answer = {
        schema: 1,
        canEdit: true,
        fields: [
            entry('id', { kind: 'id', isKey: true, editable: false, kinds: ['text', 'id'] }),
            entry('stage', {
                kind: 'select',
                version: 3,
                settings: { options: [{ id: 'won', label: 'Won', color: 'green' }] },
            }),
            entry('headline', { missing: true, kind: 'long_text', version: 1, type: '', kinds: [] }),
        ],
    };
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({ method, path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const body = method === 'GET' ? (answers[url.pathname] ?? answer) : undefined;
        await held[url.pathname];
        const reply = method === 'GET' ? { status: 200, body } : (replies.shift() ?? { status: 200, body: {} });
        return new Response(JSON.stringify(reply.body), {
            status: reply.status,
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
    for (let i = 0; i < 100; i++) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

const render = (table = 'deals') => act(() => root.render(<FieldsPanel datasetId="d 1" table={table} />));
const control = <T extends HTMLElement>(label: string) => host.querySelector<T>(`[aria-label="${label}"]`)!;
const type = (element: HTMLInputElement | HTMLSelectElement, value: string) =>
    act(() => {
        const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
const click = (element: Element) => act(() => (element as HTMLElement).click());
const button = (text: string, within: ParentNode = host) =>
    [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
const puts = () => calls.filter((call) => call.method === 'PUT');

it('shows nothing to people who may only read the dataset', async () => {
    answer = { ...answer, canEdit: false };
    render();
    await until(() => calls.length > 0, 'the fields');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.querySelector('[data-slot="dataset-fields"]')).toBeNull();
    expect(calls[0]!.path).toBe('/api/data/datasets/d%201/tables/deals/fields');
});

it('offers the kinds the column takes and saves with the version it was opened at', async () => {
    render();
    await until(() => !!host.querySelector('[data-slot="dataset-fields"]'), 'the panel');
    expect([...control<HTMLSelectElement>('Kind of deals.id').options].map((option) => option.textContent)).toEqual([
        'Text',
        'ID',
    ]);
    // A setting whose column is gone is listed, not editable.
    expect(host.textContent).toContain('headline: missing column');
    expect(control('Kind of deals.headline')).toBeNull();

    type(control('Label of deals.stage'), 'Stage');
    click(button('Add option'));
    type(control('Option 2 of deals.stage'), 'Lost');
    const stage = control('Label of deals.stage').closest('[data-slot="dataset-field"]')!;
    replies.push({ status: 200, body: { schema: 1, field: answer.fields[1] } });
    click(button('Save', stage));
    await until(() => puts().length === 1, 'the save');
    const [save] = puts();
    expect(save!.path).toBe('/api/data/datasets/d%201/tables/deals/fields/stage');
    expect(save!.body).toMatchObject({
        schema: 1,
        kind: 'select',
        label: 'Stage',
        baseVersion: 3,
        settings: {
            options: [
                { id: 'won', label: 'Won', color: 'green' },
                { label: 'Lost', color: 'blue' },
            ],
        },
    });
    const added = (save!.body!.settings as { options: Array<{ id: string }> }).options[1]!.id;
    expect(added).toMatch(/^opt_/);
    // The panel reads the fields again after a save.
    await until(() => calls.filter((call) => call.method === 'GET').length === 2, 'the reload');
});

it('asks before removing options rows use, then confirms', async () => {
    render();
    await until(() => !!host.querySelector('[data-slot="dataset-fields"]'), 'the panel');
    click(control('Remove option Won of deals.stage'));
    replies.push({
        status: 409,
        body: {
            code: 'options_in_use',
            error: '2 rows still use an option you removed.',
            inUse: [{ id: 'won', label: 'Won', rows: 2 }],
        },
    });
    click(button('Save', control('Label of deals.stage').closest('[data-slot="dataset-field"]')!));
    await until(() => document.body.textContent!.includes('Won: 2 rows'), 'the question');
    expect(puts()[0]!.body).not.toHaveProperty('confirmRemovedOptions');
    replies.push({ status: 200, body: {} });
    click(button('Remove anyway', document.body));
    await until(() => puts().length === 2, 'the confirmed save');
    expect(puts()[1]!.body).toMatchObject({ settings: { options: [] }, baseVersion: 3, confirmRemovedOptions: true });
});

it('reloads the field when someone saved it first, and lists a refusal’s problems', async () => {
    render();
    await until(() => !!host.querySelector('[data-slot="dataset-fields"]'), 'the panel');
    const stage = () => control('Label of deals.stage').closest('[data-slot="dataset-field"]')!;
    replies.push({
        status: 400,
        body: {
            code: 'invalid',
            error: 'x',
            problems: [{ path: '$.kind', message: 'TEXT can’t hold a currency field.' }],
        },
    });
    click(button('Save', stage()));
    await until(() => !!host.querySelector('[role="alert"]'), 'the problems');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('TEXT can’t hold a currency field.');

    answer = {
        ...answer,
        fields: answer.fields.map((item) => (item.field === 'stage' ? { ...item, label: 'Phase', version: 4 } : item)),
    };
    replies.push({ status: 409, body: { code: 'field_conflict', error: 'Someone changed “stage”.', current: {} } });
    click(button('Save', stage()));
    await until(() => control<HTMLInputElement>('Label of deals.stage').value === 'Phase', 'the field as it is now');
});

it('drops an answer that comes back after the table changed', async () => {
    let release!: () => void;
    held['/api/data/datasets/d%201/tables/deals/fields'] = new Promise((resolve) => (release = resolve));
    answers['/api/data/datasets/d%201/tables/leads/fields'] = {
        schema: 1,
        canEdit: true,
        fields: [entry('stage', { version: 3, label: 'Lead stage' })],
    };
    render('deals');
    await until(() => calls.length === 1, 'the first read');
    render('leads');
    await until(() => !!control('Label of leads.stage'), 'the second table');
    // The first table's answer lands late: it must not replace the second's.
    release();
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(control('Label of deals.stage')).toBeNull();
    expect(control<HTMLInputElement>('Label of leads.stage').value).toBe('Lead stage');
    expect(control('Kind of leads.id')).toBeNull();
});

it('sends only the settings of the kind it saves', async () => {
    render();
    await until(() => !!host.querySelector('[data-slot="dataset-fields"]'), 'the panel');
    click(button('Add option'));
    type(control('Kind of deals.stage'), 'text');
    click(button('Save', control('Label of deals.stage').closest('[data-slot="dataset-field"]')!));
    await until(() => puts().length === 1, 'the save');
    expect(puts()[0]!.body!.kind).toBe('text');
    expect(puts()[0]!.body!.settings).toEqual({});
});
