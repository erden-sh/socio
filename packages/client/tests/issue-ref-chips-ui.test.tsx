// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { IssueCard } from '@socio/shared/issues/issue-types';

import { forgetIssueCards } from '../src/modules/issues/issue-cards';
import { IssueMarkdown } from '../src/modules/issues/IssueMarkdown';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Issue references in an issue's text as chips (CB-274).

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    forgetIssueCards();
    vi.unstubAllGlobals();
});

const card = (number: number, title: string, status = 'open'): IssueCard =>
    ({
        number,
        title,
        excerpt: '',
        status,
        kind: 'bug',
        priority: 'medium',
        area: null,
    }) as IssueCard;

/** The cards API, as the reader may read it; records each request. */
function serve(issues: IssueCard[] | 'fail') {
    const asked: number[][] = [];
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        expect(url.pathname).toBe('/api/issues/cards');
        const numbers = url.searchParams.get('numbers')!.split(',').map(Number);
        asked.push(numbers);
        if (issues === 'fail') {
            return new Response(JSON.stringify({ error: 'Down.' }), { status: 500 });
        }
        return Response.json(issues.filter((issue) => numbers.includes(issue.number)));
    });
    return asked;
}

async function render(text: string, issueChips = true) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<IssueMarkdown text={text} issueChips={issueChips} />));
    // The batch goes out after the render's effects; then its answer lands.
    for (let round = 0; round < 3; round++) {
        await act(async () => {});
    }
    return host;
}
const chipsIn = (view: HTMLElement) =>
    [...view.querySelectorAll<HTMLAnchorElement>('a[data-slot="issue-ref"]')].map((chip) => [
        chip.getAttribute('href'),
        chip.textContent,
    ]);

it('shows #n and CB-n as chips with key and title, read in one batch', async () => {
    const asked = serve([card(4, 'Fix the parser'), card(5, 'Ship it', 'done')]);
    const view = await render('Waits for #4 and CB-5.\n\n- also (#4)\n- see CB-5, then #4!');
    expect(asked).toEqual([[4, 5]]);
    expect(chipsIn(view)).toEqual([
        ['/issues/CB-4', 'CB-4 Fix the parser'],
        ['/issues/CB-5', 'CB-5 Ship it'],
        ['/issues/CB-4', 'CB-4 Fix the parser'],
        ['/issues/CB-5', 'CB-5 Ship it'],
        ['/issues/CB-4', 'CB-4 Fix the parser'],
    ]);
    const chip = view.querySelector<HTMLAnchorElement>('a[data-slot="issue-ref"]')!;
    // A link: in the tab order, named by its key and title, full title on hover.
    expect(chip.tabIndex).toBe(0);
    expect(chip.getAttribute('title')).toBe('CB-4: Fix the parser');
    expect(view.textContent).toContain('Waits for CB-4 Fix the parser and ');
});

it('leaves references the reader can’t have as the words, not links', async () => {
    serve([card(4, 'Fix the parser')]);
    const view = await render('See #4, #77 and CB-78.');
    expect(chipsIn(view)).toEqual([['/issues/CB-4', 'CB-4 Fix the parser']]);
    expect(view.querySelectorAll('a')).toHaveLength(1);
    expect(view.textContent).toBe('See CB-4 Fix the parser, #77 and CB-78.');
    act(() => root?.unmount());
    host?.remove();
    forgetIssueCards();

    // The call failing (signed out, the board off) tells nothing either.
    serve('fail');
    const failed = await render('See #4.');
    expect(failed.querySelector('a')).toBeNull();
    expect(failed.textContent).toBe('See #4.');
});

it('leaves code, links, headings, URLs, colours and entities alone', async () => {
    const asked = serve([card(1, 'One'), card(12, 'Twelve'), card(123, 'Many')]);
    const view = await render(
        [
            '# #1 goal',
            '## Fixing CB-12',
            'Inline `#12` and `CB-12`, a [link #12](https://example.com/#12).',
            '```\n#12 CB-12\n```',
            'https://example.com/page#12 and example.com/#12 and page#12',
            'Colours #fff, #1a2b3c, #000, a hex #12ab, entity &#123; and v1.#12',
            'Wiki style ##12, path /#12, query ?#12, color:#123',
            'But #123 is real.',
        ].join('\n\n'),
    );
    // Only "CB-12" in the heading and the last "#123" are references.
    expect(asked).toEqual([[12, 123]]);
    expect(chipsIn(view)).toEqual([
        ['/issues/CB-12', 'CB-12 Twelve'],
        ['/issues/CB-123', 'CB-123 Many'],
    ]);
    expect(view.querySelector('h3')?.textContent).toBe('#1 goal');
    expect(view.querySelector('pre')?.textContent).toBe('#12 CB-12\n');
    expect([...view.querySelectorAll('p > code')].map((c) => c.textContent)).toEqual(['#12', 'CB-12']);
});

it('keeps plain issue keys without chips where none were asked for', async () => {
    const asked = serve([card(4, 'Fix the parser')]);
    const view = await render('See #4 and CB-4.', false);
    expect(asked).toEqual([]);
    expect(view.querySelector('a')).toBeNull();
    expect(view.textContent).toBe('See #4 and CB-4.');
});

it('opens the issue on click, like the side panel’s links', async () => {
    serve([card(4, 'Fix the parser')]);
    const { setAppNavigator } = await import('../src/modules/pages/page-navigation');
    const navigate = vi.fn();
    const unregister = setAppNavigator(navigate);
    try {
        const view = await render('See #4.');
        act(() => view.querySelector<HTMLAnchorElement>('a[data-slot="issue-ref"]')!.click());
        expect(navigate.mock.calls).toEqual([['/issues/CB-4', { fromIssues: true }]]);
    } finally {
        unregister();
    }
});

it('stays inside a narrow column: the chip wraps with the text, its title cut', async () => {
    const long = 'A very long title '.repeat(20).trim();
    serve([card(4, long)]);
    const view = await render('See #4.');
    const chip = view.querySelector<HTMLAnchorElement>('a[data-slot="issue-ref"]')!;
    // Inline (no box of its own to widen the column), wrapping anywhere,
    // its border repeated on each line.
    expect(chip.className).not.toMatch(/\b(inline-)?(flex|block)\b/);
    expect(chip.className).toContain('[overflow-wrap:anywhere]');
    expect(chip.className).toContain('[box-decoration-break:clone]');
    const title = chip.querySelector('[data-slot="issue-ref-title"]')!;
    expect(title.textContent).toHaveLength(60);
    expect(title.textContent!.endsWith('…')).toBe(true);
    expect(chip.getAttribute('title')).toBe(`CB-4: ${long}`);
});
