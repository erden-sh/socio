// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ClassifyUseView, FailureLabelView } from '@socio/shared/classify';

import { FailureLabelPanel } from '../src/modules/operations/FailureLabelPanel';
import { FailureLabelSettings } from '../src/modules/operations/FailureLabelSettings';

// Failure labels in the dashboard (CB-198): Reliability's relabel panel
// (what the model reads, its suggestion, an admin's label) and the
// Operations → Settings card (switch, threshold, cap, golden set and
// evaluation).

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const NOW = Date.UTC(2026, 9, 22, 12);
const label = (patch: Partial<FailureLabelView> = {}): FailureLabelView => ({
    runId: 'r0',
    level: 'tool',
    idx: 0,
    tool: 'run_query',
    code: 'tool_error',
    rulesCategory: 'unclassified',
    rule: 'generic_code',
    labelable: true,
    input: 'connect ECONNREFUSED <email>',
    label: null,
    suggestion: {
        label: 'external_service',
        confidence: 0.82,
        provider: 'workspace',
        version: 'workspace:tiny/p1',
        applied: false,
        at: NOW,
    },
    ...patch,
});
const viewWith = (patch: Partial<ClassifyUseView> = {}): ClassifyUseView => ({
    use: 'failures',
    labelsVersion: 1,
    enabled: false,
    provider: 'workspace',
    threshold: 0.9,
    perDay: 200,
    defaults: {
        enabled: false,
        provider: 'workspace',
        threshold: 0.9,
        perDay: 200,
    },
    available: true,
    version: 'workspace:tiny/p1',
    versionPassed: false,
    golden: 3,
    callsToday: 4,
    evalCallsToday: 0,
    tokensToday: 900,
    costToday: null,
    unknownCostCalls: 4,
    evaluating: false,
    lastEval: null,
    ...patch,
});

let calls: { method: string; path: string; body: unknown }[] = [];
let respond: (method: string, path: string, body: unknown) => [number, unknown];
let root: Root;
let host: HTMLElement;

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('fetch', async (input: string, init: RequestInit | undefined = {}) => {
        const url = new URL(input, 'http://app.test');
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        const path = `${url.pathname}${url.search}`;
        calls.push({ method, path, body });
        const [status, answer] = respond(method, path, body);
        return new Response(JSON.stringify(answer), {
            status,
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
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host.textContent}`);
}
const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name);

it('shows what the model reads and suggests, and saves an admin’s label', async () => {
    respond = (method) =>
        method === 'PUT'
            ? [
                  200,
                  label({
                      label: {
                          label: 'external_service',
                          source: 'admin',
                          provider: null,
                          at: NOW,
                          by: 'Alice',
                      },
                  }),
              ]
            : [200, label()];
    act(() => root.render(<FailureLabelPanel runId="r0" level="tool" timeZone="UTC" />));
    await until(() => !!host.querySelector('[data-slot="ops-failure-suggestion"]'), 'the suggestion');
    // Opened from Reliability, for the access log.
    expect(calls[0]).toMatchObject({
        method: 'GET',
        path: '/api/classify/failures/r0?level=tool&via=reliability',
    });
    expect(host.textContent).toContain('connect ECONNREFUSED <email>');
    expect(host.querySelector('[data-slot="ops-failure-suggestion"]')!.textContent).toContain(
        'Other external services, 82% sure; a suggestion only',
    );
    act(() => button('Save label')!.click());
    await until(() => !!host.querySelector('[data-slot="ops-failure-label-in-force"]'), 'the label');
    expect(calls.at(-1)).toEqual({
        method: 'PUT',
        path: '/api/classify/failures/r0/label',
        body: { level: 'tool', label: 'external_service' },
    });
    expect(host.querySelector('[data-slot="ops-failure-label-in-force"]')!.textContent).toContain(
        'Labeled Other external services by Alice',
    );
});

it('says when the rules sort a failure and offers no label', async () => {
    respond = () => [200, label({ labelable: false, rulesCategory: 'quotas', rule: 'quota_code' })];
    act(() => root.render(<FailureLabelPanel runId="r0" level="turn" timeZone="UTC" />));
    await until(() => /labels apply only/.test(host.textContent ?? ''), 'it');
    expect(button('Save label')).toBeUndefined();
});

it('turns labelling on with a threshold and cap, and evaluates once the golden set is big enough', async () => {
    let view = viewWith();
    respond = (method, path, body) => {
        if (method === 'PUT') {
            view = viewWith({ ...view, ...(body as object) });
        }
        if (method === 'POST' && path.endsWith('/evaluate')) {
            view = viewWith({ ...view, evaluating: true });
        }
        return [method === 'POST' ? 202 : 200, view];
    };
    act(() => root.render(<FailureLabelSettings />));
    await until(() => !!host.querySelector('[data-slot="failure-label-status"]'), 'the card');
    expect(host.textContent).toContain('workspace:tiny/p1');
    expect(host.textContent).toContain('Suggestions only');
    expect(host.textContent).toContain('3 admin labels (an evaluation needs 20)');
    expect(host.textContent).toContain('4 of 200 calls');
    expect(button('Evaluate')!.disabled).toBe(true);
    // On, at 95%, 50 a day.
    const checkbox = host.querySelector<HTMLButtonElement>('[data-slot="permission-row"] button[role="checkbox"]')!;
    act(() => checkbox.click());
    const [threshold, perDay] = [...host.querySelectorAll<HTMLInputElement>('input[inputmode="numeric"]')];
    const type = (input: HTMLInputElement, value: string) =>
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    type(threshold!, '95');
    type(perDay!, '50');
    act(() => button('Save')!.click());
    await until(() => calls.some((call) => call.method === 'PUT'), 'the save');
    expect(calls.find((call) => call.method === 'PUT')).toEqual({
        method: 'PUT',
        path: '/api/classify/uses/failures',
        body: { enabled: true, threshold: 0.95, perDay: 50 },
    });

    // Enough labels: it evaluates.
    view = viewWith({ ...view, golden: 25 });
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<FailureLabelSettings />));
    await until(() => button('Evaluate')?.disabled === false, 'Evaluate');
    act(() => button('Evaluate')!.click());
    await until(() => !!button('Evaluating…'), 'it running');
    expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/classify/uses/failures/evaluate',
        body: undefined,
    });
});

it('shows the last evaluation per label', async () => {
    respond = () => [
        200,
        viewWith({
            golden: 24,
            versionPassed: true,
            lastEval: {
                id: 'e1',
                use: 'failures',
                provider: 'workspace',
                version: 'workspace:tiny/p1',
                labelsVersion: 1,
                threshold: 0.9,
                startedAt: NOW,
                finishedAt: NOW + 1000,
                status: 'done',
                error: null,
                golden: 24,
                answered: 20,
                correct: 19,
                precision: 0.95,
                accuracy: 19 / 24,
                failedCalls: 0,
                passed: true,
                labels: [
                    {
                        label: 'quotas',
                        support: 4,
                        predicted: 4,
                        correct: 4,
                        precision: 1,
                        recall: 1,
                    },
                ],
                confusion: {},
            },
        }),
    ];
    act(() => root.render(<FailureLabelSettings />));
    await until(() => !!host.querySelector('[data-slot="failure-label-eval"]'), 'the evaluation');
    expect(host.querySelector('[data-slot="failure-label-pass"]')!.textContent).toContain('Count: this version passed');
    const text = host.querySelector('[data-slot="failure-label-eval"]')!.textContent!;
    expect(text).toContain('Passed. 24 labels, 20 answered, 95% of those right');
    expect(text).toContain('Quotas and limits');
});
