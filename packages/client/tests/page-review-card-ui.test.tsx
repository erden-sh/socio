// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
    api: vi.fn(),
    ApiError: class extends Error {
        status = 0;
    },
}));
import { pageReviewApproved, pageReviewTool } from '@socio/shared/pages/page-review';

import { api } from '../src/lib/api';
import { PageReviewCard } from '../src/modules/pages/PageReviewCard';

// The review card as CopilotKit drives it (CB-81): `inProgress` while the
// Dot writes the draft, or while an earlier review in the same turn waits;
// `executing` with `respond` once it is this card's turn, live or after a
// reload; `complete` once answered.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
/** Receipts by tool call, and the drafts the card saved. */
let receipts: Record<string, unknown>;
let saves: Array<Record<string, unknown>>;
beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    receipts = {};
    saves = [];
    vi.mocked(api).mockReset();
    vi.mocked(api).mockImplementation(async (path, method, body) => {
        if (method === 'POST') {
            const draft = body as Record<string, unknown>;
            saves.push(draft);
            const page = {
                id: `page-${saves.length}`,
                spaceId: draft.spaceId ?? 'default-space',
                title: draft.title,
                content: draft.content,
                reviewDraft: {
                    title: draft.title,
                    content: draft.content,
                    spaceId: draft.spaceId ?? 'default-space',
                },
            };
            receipts[String(draft.toolCallId)] = page;
            return page;
        }
        return receipts[String(path).split('/').at(-1)!] ?? null;
    });
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
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
const cards = () => [...host.querySelectorAll<HTMLElement>('section[aria-label="Review page draft"]')];
const buttons = (within: HTMLElement) => [...within.querySelectorAll('button')].map((item) => item.textContent);
const click = (within: HTMLElement, name: string) =>
    act(() => {
        [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === name)!.click();
    });

type Call = {
    id: string;
    args: unknown;
    status: string;
    result?: string;
    respond?: (result: unknown) => Promise<void>;
};
const render = (calls: Call[]) =>
    act(() =>
        root.render(
            <>
                {calls.map((call) => (
                    <PageReviewCard
                        key={call.id}
                        args={call.args}
                        status={call.status}
                        result={call.result}
                        respond={call.respond}
                        threadId="thread"
                        toolCallId={call.id}
                        onSaved={() => {}}
                    />
                ))}
            </>,
        ),
    );

it('renders a finished draft without a Space and saves it to the default one', async () => {
    // The prompt and create_space_page let the Dot leave the Space out; such
    // a draft used to stay on "Preparing your draft…" with Approve disabled.
    const respond = vi.fn(async () => {});
    render([
        {
            id: 'call-a',
            args: { title: 'Launch brief', content: '# Goals', extra: 'ignored' },
            status: 'executing',
            respond,
        },
    ]);
    await until(() => /Ready for your review/.test(host.textContent!), 'review');
    expect(host.textContent).not.toContain('Preparing your draft');
    expect(host.querySelector('h3')?.textContent).toBe('Launch brief');
    expect(host.querySelector('h1')?.textContent).toBe('Goals');
    click(cards()[0], 'Approve & save');
    await until(() => respond.mock.calls.length > 0, 'the decision');
    expect(saves).toEqual([{ title: 'Launch brief', content: '# Goals', toolCallId: 'call-a' }]);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ approved: true, pageId: 'page-1' }));
});

it('shows a finished draft that cannot be saved and sends it back with the reason', async () => {
    const respond = vi.fn(async () => {});
    render([
        {
            id: 'call-a',
            args: { title: 'T'.repeat(200), content: 'Body text' },
            status: 'executing',
            respond,
        },
    ]);
    await until(() => /Draft needs fixing/.test(host.textContent!), 'the card');
    expect(host.textContent).not.toContain('Preparing your draft');
    expect(host.textContent).toContain('Body text');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('title');
    expect(buttons(cards()[0])).toEqual(['Send back']);
    click(cards()[0], 'Send back');
    await until(() => respond.mock.calls.length > 0, 'the decision');
    expect(saves).toEqual([]);
    expect(respond).toHaveBeenCalledWith({
        approved: false,
        message: expect.stringMatching(new RegExp(`title.*call ${pageReviewTool.name} again`)),
    });
});

it('reviews two drafts from one turn in order, each under its own tool call', async () => {
    const first = { title: 'First', content: 'One', spaceId: 's1' };
    const second = { title: 'Second', content: 'Two', spaceId: 's1' };
    const respondFirst = vi.fn(async () => {});
    const respondSecond = vi.fn(async () => {});
    // CopilotKit runs one human review at a time: the second waits.
    render([
        { id: 'call-a', args: first, status: 'executing', respond: respondFirst },
        { id: 'call-b', args: second, status: 'inProgress' },
    ]);
    await until(() => /Ready for your review/.test(host.textContent!), 'review');
    const [a, b] = cards();
    expect(a.querySelector('h3')?.textContent).toBe('First');
    expect(b.querySelector('h3')?.textContent).toBe('Second');
    expect(b.textContent).toContain('Draft on its way');
    expect(b.textContent).toContain('any review above it is decided');
    expect(buttons(b)).toEqual([]);
    click(a, 'Approve & save');
    await until(() => respondFirst.mock.calls.length > 0, 'the first decision');
    render([
        { id: 'call-a', args: first, status: 'complete' },
        { id: 'call-b', args: second, status: 'executing', respond: respondSecond },
    ]);
    await until(() => buttons(cards()[1]).includes('Decline'), 'the second');
    expect(cards()[0].textContent).toContain('Saved to your Space');
    click(cards()[1], 'Decline');
    await until(() => respondSecond.mock.calls.length > 0, 'the second decision');
    expect(saves.map((save) => save.toolCallId)).toEqual(['call-a']);
    expect(respondSecond).toHaveBeenCalledWith(expect.objectContaining({ approved: false }));
});

it('restores a draft without a Space after a reload, saved or still waiting', async () => {
    // Saved before the reload: the receipt holds the default Space.
    receipts['call-a'] = {
        id: 'page-a',
        spaceId: 'default-space',
        title: 'First',
        content: 'One',
        reviewDraft: { title: 'First', content: 'One', spaceId: 'default-space' },
    };
    const respond = vi.fn(async () => {});
    // From history the arguments are final: CopilotKit runs the unanswered
    // review again on connect, so it is `executing` with `respond`.
    render([
        {
            id: 'call-a',
            args: { title: 'First', content: 'One' },
            status: 'complete',
        },
        {
            id: 'call-b',
            args: { title: 'Second', content: 'Two' },
            status: 'executing',
            respond,
        },
    ]);
    await until(() => buttons(cards()[1]).includes('Approve & save'), 'the restored review');
    expect(cards()[0].textContent).toContain('Saved to your Space');
    expect(cards()[0].textContent).not.toContain('Review changed');
    expect(cards()[1].querySelector('h3')?.textContent).toBe('Second');
    expect(host.textContent).not.toContain('Preparing your draft');
});

it('shows a draft edited before saving (on the app) as saved, not as a different draft', async () => {
    // The receipt holds the edits; the stored result says they were edited (RVL).
    const draft = { title: 'Brief', content: 'Socio text', spaceId: 'space' };
    const edited = { ...draft, content: 'Edited on the phone' };
    receipts['call-a'] = { id: 'page-a', ...edited, reviewDraft: edited };
    receipts['call-b'] = { id: 'page-b', ...edited, reviewDraft: edited };
    const approved = (pageId: string, options = {}) =>
        JSON.stringify(pageReviewApproved({ id: pageId, spaceId: 'space' }, `/spaces/space/pages/${pageId}`, options));
    render([
        { id: 'call-a', args: draft, status: 'complete', result: approved('page-a', { edited: true }) },
        // Without the edited result, the same receipt is another draft's.
        { id: 'call-b', args: draft, status: 'complete', result: approved('page-b') },
    ]);
    await until(() => /Saved to your Space/.test(cards()[0].textContent!), 'the edited review');
    expect(cards()[0].textContent).not.toContain('different draft');
    expect(buttons(cards()[0])).toEqual(['Open page ']);
    expect(cards()[0].textContent).toContain('Edited on the phone');
    expect(cards()[0].textContent).not.toContain('Socio text');
    await until(() => /Review changed/.test(cards()[1].textContent!), 'the conflict');
    expect(cards()[1].textContent).toContain('This review was saved with a different draft');
});
