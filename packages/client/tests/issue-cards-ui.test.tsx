import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { IssueCard } from '@socio/shared/issues/issue-types';

import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { forgetIssueCards, issueLinkNumber } from '../src/modules/issues/issue-cards';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    forgetIssueCards();
    vi.unstubAllGlobals();
});

const slow: IssueCard = {
    number: 85,
    title: 'The board is slow',
    excerpt: 'Cards take too long to appear after changing filters.',
    status: 'in_progress',
    kind: 'improvement',
    priority: 'high',
    area: 'client',
};
const cards: IssueCard = {
    number: 86,
    title: 'Ship issue cards',
    excerpt: '',
    status: 'open',
    kind: 'feature',
    priority: 'medium',
    area: null,
};

/** The issues API, as the viewer may read it; records each request. */
function serve(issues: IssueCard[] | 'fail') {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
        asked.push(input);
        if (issues === 'fail') {
            return new Response(JSON.stringify({ error: 'Down.' }), { status: 500 });
        }
        const numbers = new URL(input, 'http://app.test').searchParams.get('numbers')!.split(',').map(Number);
        return Response.json(issues.filter((issue) => numbers.includes(issue.number)));
    });
    return asked;
}

async function render(content: string, role: 'assistant' | 'user' = 'assistant') {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const messages: Message[] = [{ id: 'm', role, content }];
    act(() => root!.render(<ChatTranscript messages={messages} calls={[]} />));
    // The batch goes out after the render's effects; then its answer lands.
    for (let round = 0; round < 3; round++) {
        await act(async () => {});
    }
    return host;
}
const cardsIn = (view: HTMLElement) => [...view.querySelectorAll<HTMLAnchorElement>('a[data-slot="issue-card"]')];
const chipsIn = (view: HTMLElement) => [...view.querySelectorAll<HTMLAnchorElement>('a[data-slot="issue-chip"]')];

it('shows an issue link on its own line as a card with its title and status', async () => {
    const asked = serve([slow]);
    const view = await render('Filed it:\n\n[Open issue CB-85](/issues/CB-85)');
    const [card] = cardsIn(view);
    expect(card).toBeDefined();
    expect(card!.getAttribute('href')).toBe('/issues/CB-85');
    expect(card!.textContent).toContain('CB-85');
    expect(card!.textContent).toContain('The board is slow');
    expect(card!.textContent).toContain(slow.excerpt);
    expect(card!.textContent).toContain('In progress');
    expect(card!.textContent).toContain('High');
    expect(card!.textContent).toContain('Improvement');
    expect(card!.textContent).toContain('Client');
    expect(asked).toEqual(['/api/issues/cards?numbers=85']);
});

it('shows the full long title and summary without ellipsizing the chat card (CB-247)', async () => {
    const title = 'Surface issue dependencies as builder-agent hints with structured blockers';
    serve([{ ...slow, title }]);
    const view = await render('[CB-85](/issues/CB-85)');
    const [card] = cardsIn(view);
    expect(card!.textContent).toContain(title);
    expect(card!.querySelector('.truncate')).toBeNull();
    expect(card!.querySelector('[data-slot="issue-card-summary"]')!.textContent).toBe(slow.excerpt);
});

it('asks once for every issue in a message and stacks a run of them', async () => {
    const asked = serve([slow, cards]);
    const view = await render(
        [
            'Filed [CB-85](/issues/CB-85) for you.',
            '',
            `[CB-85](${location.origin}/issues/CB-85) and [CB-86](/issues/CB-86).`,
            '',
            '- [CB-85](/issues/CB-85)',
            '- [CB-86](/issues/CB-86)',
        ].join('\n'),
    );
    // A same-origin absolute link counts too; one request for both.
    expect(asked).toEqual(['/api/issues/cards?numbers=85,86']);
    const stack = view.querySelector('[data-slot="issue-cards"]')!;
    expect(stack).not.toBeNull();
    expect(cardsIn(stack as HTMLElement).map((card) => card.textContent)).toEqual([
        expect.stringContaining('The board is slow'),
        expect.stringContaining('Ship issue cards'),
    ]);
    // The separators go; the list loses its bullets.
    expect(stack.textContent).not.toContain(' and ');
    expect(view.querySelector('ul')!.className).toContain('list-none');
    expect(cardsIn(view)).toHaveLength(4);
    // In prose the link stays inline, its status beside it (CB-104).
    expect(chipsIn(view)).toHaveLength(1);
    expect(view.querySelector('[data-chat-body="assistant"] p')!.textContent).toBe('Filed CB-85In progress for you.');
});

it('keeps a link in running text inline, its punctuation with it (CB-104)', async () => {
    serve([slow, cards]);
    const view = await render(
        'Your observation was added to [CB-85](/issues/CB-85). [CB-86](/issues/CB-86) is about something else.',
    );
    expect(cardsIn(view)).toEqual([]);
    expect(view.querySelector('[data-slot="issue-cards"]')).toBeNull();
    const chips = chipsIn(view);
    expect(chips.map((chip) => chip.getAttribute('href'))).toEqual(['/issues/CB-85', '/issues/CB-86']);
    // The link's own words, its status and the title on hover.
    expect(chips[0]!.textContent).toBe('CB-85In progress');
    expect(chips[0]!.title).toBe('CB-85: The board is slow');
    // One paragraph: the full stop follows the link, nothing starts with one.
    const paragraphs = [...view.querySelectorAll('[data-chat-body="assistant"] p')];
    expect(paragraphs.map((p) => p.textContent)).toEqual([
        'Your observation was added to CB-85In progress. CB-86Open is about something else.',
    ]);
});

it('makes a link before a lone full stop a card, the stop dropped (CB-104)', async () => {
    serve([slow]);
    const view = await render('Done.\n\n[CB-85](/issues/CB-85).');
    expect(cardsIn(view)).toHaveLength(1);
    expect(chipsIn(view)).toEqual([]);
    const stack = view.querySelector('[data-slot="issue-cards"]')!;
    expect(stack.textContent).not.toMatch(/\.$/);
    expect(view.querySelector('[data-chat-body="assistant"]')!.textContent).not.toMatch(/(^|\n)\s*\./);
});

it('shows a list of links as cards, a list item with words as a chip (CB-104)', async () => {
    serve([slow, cards]);
    let view = await render('- [CB-85](/issues/CB-85).\n- [CB-86](/issues/CB-86),');
    expect(cardsIn(view)).toHaveLength(2);
    expect(view.querySelector('ul')!.className).toContain('list-none');
    // A link's trailing punctuation doesn't sit under its card.
    for (const item of view.querySelectorAll('li')) {
        expect(item.textContent).not.toMatch(/[.,]$/);
    }
    act(() => root?.unmount());
    host?.remove();

    view = await render('- [CB-85](/issues/CB-85)\n- [CB-86](/issues/CB-86), the follow-up.');
    const [first, second] = view.querySelectorAll('li');
    expect(cardsIn(first as HTMLElement)).toHaveLength(1);
    expect(cardsIn(second as HTMLElement)).toEqual([]);
    expect(chipsIn(second as HTMLElement)).toHaveLength(1);
    expect(second!.textContent).toBe('CB-86Open, the follow-up.');
    expect(view.querySelector('ul')!.className).not.toContain('list-none');
});

it('makes a lone link a card in each form a Dot writes it, a mark after it dropped (CB-118)', async () => {
    serve([slow]);
    // gpt-6-luna wrote "[Open CB-117](https://…/issues/CB-117) ↗": the arrow
    // made it running text, a chip, not a card.
    for (const reply of [
        'Filed it.\n\n[Open CB-85](/issues/CB-85) ↗',
        `Filed it.\n\n[Open CB-85](${location.origin}/issues/CB-85) ↗`,
        `Filed it.\n\n${location.origin}/issues/CB-85`,
        `Filed it.\n\n<${location.origin}/issues/CB-85>`,
        'Filed it.\n\n[CB-85](/issues/CB-85) →',
        'Filed it.\n\n[CB-85](/issues/CB-85) (↗)',
        'Filed it.\n\n[CB-85](/issues/CB-85) 🔗',
        'Filed it.\n\n- [Open CB-85](/issues/CB-85) ↗',
    ]) {
        const view = await render(reply);
        const [card] = cardsIn(view);
        expect(card, reply).toBeDefined();
        expect(card!.getAttribute('href')).toBe('/issues/CB-85');
        expect(chipsIn(view), reply).toEqual([]);
        // The mark goes with the link's words: the card is the link.
        expect(view.querySelector('[data-chat-body="assistant"]')!.textContent).not.toMatch(/[↗→()]|🔗|Open/u);
        act(() => root?.unmount());
        host?.remove();
    }
    // Words after the link are running text: the link stays inline.
    const view = await render('[Open CB-85](/issues/CB-85) ↗ for the details');
    expect(cardsIn(view)).toEqual([]);
    expect(chipsIn(view)).toHaveLength(1);
});

it('opens the issue from the chat, so closing it comes back (CB-119)', async () => {
    serve([slow]);
    const { setAppNavigator } = await import('../src/modules/pages/page-navigation');
    const navigate = vi.fn();
    const unregister = setAppNavigator(navigate);
    try {
        const view = await render('Filed it:\n\n[CB-85](/issues/CB-85)\n\nSee also [CB-85](/issues/CB-85) now.');
        const [card] = cardsIn(view);
        const [chip] = chipsIn(view);
        act(() => card!.click());
        act(() => chip!.click());
        expect(navigate.mock.calls).toEqual([
            ['/issues/CB-85', { fromChat: true }],
            ['/issues/CB-85', { fromChat: true }],
        ]);
    } finally {
        unregister();
    }
});

it('keeps the plain link when the issue can’t be read or the call fails', async () => {
    serve([]);
    let view = await render('See [Open issue CB-85](/issues/CB-85).');
    expect(cardsIn(view)).toEqual([]);
    let link = view.querySelector('[data-chat-body="assistant"] a')!;
    expect(link.textContent).toBe('Open issue CB-85');
    expect(link.getAttribute('href')).toBe('/issues/CB-85');
    act(() => root?.unmount());
    host?.remove();
    forgetIssueCards();

    serve('fail');
    view = await render('See [Open issue CB-85](/issues/CB-85).');
    expect(cardsIn(view)).toEqual([]);
    link = view.querySelector('[data-chat-body="assistant"] a')!;
    expect(link.textContent).toBe('Open issue CB-85');
    expect(link.getAttribute('href')).toBe('/issues/CB-85');
});

it('leaves other links, bare keys and the person’s own messages alone', async () => {
    const asked = serve([slow]);
    const view = await render(
        'Read [the docs](https://example.com/issues/CB-85), [a page](/spaces/s1), CB-85 and `/issues/CB-85`.',
    );
    expect(cardsIn(view)).toEqual([]);
    expect(asked).toEqual([]);
    expect(
        [...view.querySelectorAll('[data-chat-body="assistant"] a')].map((a) => [
            a.textContent,
            a.getAttribute('href'),
        ]),
    ).toEqual([
        ['the docs', 'https://example.com/issues/CB-85'],
        ['a page', '/spaces/s1'],
    ]);
    act(() => root?.unmount());
    host?.remove();
    const own = await render('Is [CB-85](/issues/CB-85) done?', 'user');
    expect(cardsIn(own)).toEqual([]);
    expect(asked).toEqual([]);
});

it('knows this app’s issue URLs', () => {
    expect(issueLinkNumber('/issues/CB-85')).toBe(85);
    expect(issueLinkNumber(`${location.origin}/issues/CB-7`)).toBe(7);
    for (const href of [
        '/issues/CB-0',
        '/issues/85',
        '/issues/CB-85?x=1',
        '/issues/CB-85/comments',
        '//evil.test/issues/CB-85',
        'https://evil.test/issues/CB-85',
        'CB-85',
        undefined,
    ]) {
        expect([href, issueLinkNumber(href)]).toEqual([href, undefined]);
    }
});
