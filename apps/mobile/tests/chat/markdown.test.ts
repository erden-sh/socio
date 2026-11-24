import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { formatInlineChart, type InlineChartData } from '@socio/shared/inline-chart';
import { ISSUE_STATUSES, type IssueSummary } from '@socio/shared/issues/issue-types';

import { barPath, chartLayout, chartSummary, niceTicks } from '../../src/chat/chart';
import { IMAGE_LABEL, replyParts, safeMarkdown } from '../../src/chat/markdown';
import {
    type IssueCardPart,
    issueCardGroups,
    issueCardParts,
    issueCardView,
    issueKeyOf,
    issueLinkPattern,
    issueLinksOnly,
    withIssueStatuses,
    linkTarget,
    statusLinkOf,
    statusLinkPattern,
    tappedLink,
    webSignInLine,
} from '../../src/chat/markdown-links';

// A socio's reply before the native renderer sees it: images become
// links, raw HTML blocks show as text, `socio-chart` fences become charts, and
// the link rules (only http(s) and mailto open). The hostile-Markdown device
// check (README) loads and taps the same text against an egress log.

const ORIGIN = 'https://acme.example';
const J = '\u2060';

/**
 * Whether any `!` meets a `[` unescaped: CommonMark has no image without it,
 * so the renderer can't load one, whatever it reads as code or prose.
 */
function hasImage(text: string): boolean {
    for (let at = text.indexOf('!['); at !== -1; at = text.indexOf('![', at + 1)) {
        let slashes = 0;
        for (let back = at - 1; back >= 0 && text[back] === '\\'; back--) {
            slashes++;
        }
        if (slashes % 2 === 0) {
            return true;
        }
    }
    return false;
}

/** Whether a line could open a `<video>` block (the renderer's one HTML block it draws). */
const hasVideoBlock = (text: string) => /(^|\n)[ \t>*+\-\d.)]*<video(?:[\s/>]|$)/im.test(text);

/** Markdown meant to make a renderer fetch, by every road we know. */
export const HOSTILE = [
    '# Hostile ![h](http://localhost:4391/heading.png)',
    'Inline ![alt text](http://localhost:4391/inline.png "title") and ![](http://10.0.2.2:4391/empty.png).',
    'Wow![bang](http://localhost:4391/bang.png) and ![ ](http://localhost:4391/space.png)',
    'Reference ![ref][r] and ![r][] and ![r].',
    '',
    '[r]: http://localhost:4391/ref.png',
    '',
    '[![nested](http://localhost:4391/nested.png)](http://localhost:4391/outer)',
    '',
    '- list ![l](http://localhost:4391/list.png)',
    '> quote ![q](http://localhost:4391/quote.png)',
    '',
    '| a | b |',
    '| - | - |',
    '| ![t](http://localhost:4391/table.png) | x |',
    '',
    '<img src="http://localhost:4391/html.png">',
    '',
    '<video src="http://localhost:4391/video.mp4" poster="http://localhost:4391/poster.png"></video>',
    '',
    '- <VIDEO src="http://localhost:4391/list-video.mp4">',
    '',
    '- > <video src="http://localhost:4391/list-quote-video.mp4"></video>',
    '',
    '1. > <video src="http://localhost:4391/ordered-quote-video.mp4">',
    '',
    '> - > <video src="http://localhost:4391/quote-list-quote-video.mp4">',
    '',
    '-\t<video src="http://localhost:4391/tab-video.mp4">',
    '',
    '<iframe src="http://localhost:4391/frame"></iframe>',
    '',
    'Inline <img src="http://localhost:4391/inline-html.png"> tag.',
    '',
    '2. ```',
    '![after a fake fence](http://localhost:4391/fake-fence.png)',
    '',
    '    ```',
    '![after an indented fence](http://localhost:4391/indented.png)',
    '',
    '```a`b',
    '![after a fence with a backtick](http://localhost:4391/backtick-info.png)',
    '',
    '> ```',
    '![after a quoted fence](http://localhost:4391/quoted-fence.png)',
    '',
    '- ```',
    '![after a list fence](http://localhost:4391/list-fence.png)',
    '',
    '~~~\r~~~\r![after carriage returns](http://localhost:4391/cr.png)',
    '',
    '<http://localhost:4391/a`b> ![after an autolink](http://localhost:4391/autolink.png) `',
    '',
    '[a](http://localhost:4391/x`y) ![after a link](http://localhost:4391/link-dest.png) `',
    '',
    '```markdown',
    '![in code](http://localhost:4391/code.png)',
    '<video src="http://localhost:4391/code.mp4">',
    '```',
    '',
    'Code `![span](http://localhost:4391/span.png)` here.',
].join('\n');

describe('images and HTML never reach the renderer', () => {
    it('turns every image into a link, an empty alt into "Image"', () => {
        expect(safeMarkdown('See ![a chart](https://x.example/c.png "t").')).toBe(
            'See [a chart](https://x.example/c.png "t").',
        );
        expect(safeMarkdown('![](https://x.example/c.png)')).toBe(`[${IMAGE_LABEL}](https://x.example/c.png)`);
        expect(safeMarkdown('![  ](https://x.example/c.png)')).toBe(`[${IMAGE_LABEL}](https://x.example/c.png)`);
        expect(safeMarkdown('![r][ref]\n\n[ref]: https://x.example/c.png')).toBe(
            '[r][ref]\n\n[ref]: https://x.example/c.png',
        );
    });

    it('leaves an escaped bang, and keeps code as code', () => {
        expect(safeMarkdown('\\![not an image](x)')).toBe('\\![not an image](x)');
        expect(safeMarkdown('\\\\![an image](x)')).toBe('\\\\[an image](x)');
        expect(safeMarkdown('Use `![alt](src)`.')).toBe(`Use \`!${J}[alt](src)\`.`);
        expect(safeMarkdown('```\n![alt](src)\n<p>hi</p>\n```')).toBe(`\`\`\`\n!${J}[alt](src)\n<p>hi</p>\n\`\`\``);
    });

    it('shows a line that starts an HTML block as text, as the web does, and keeps autolinks', () => {
        expect(safeMarkdown('<img src="x">')).toBe('\\<img src="x">');
        expect(safeMarkdown('> - <video src="x">')).toBe('> - \\<video src="x">');
        expect(safeMarkdown('- > <video src="x">')).toBe('- > \\<video src="x">');
        expect(safeMarkdown('1. > <video src="x">')).toBe('1. > \\<video src="x">');
        expect(safeMarkdown('> - > <video src="x">')).toBe('> - > \\<video src="x">');
        expect(safeMarkdown('-\t<video src="x">')).toBe('-\t\\<video src="x">');
        expect(safeMarkdown('<!-- note -->')).toBe('\\<!-- note -->');
        expect(safeMarkdown('</div>')).toBe('\\</div>');
        expect(safeMarkdown('<https://x.example/a>')).toBe('<https://x.example/a>');
        expect(safeMarkdown('<ada@example.test>')).toBe('<ada@example.test>');
        expect(safeMarkdown('2 < 3 and a <b>bold</b> word')).toBe('2 < 3 and a <b>bold</b> word');
    });

    it('leaves no image and no video block in hostile Markdown', () => {
        const safe = safeMarkdown(HOSTILE);
        expect(hasImage(HOSTILE)).toBe(true);
        expect(hasImage(safe)).toBe(false);
        expect(hasVideoBlock(safe)).toBe(false);
        expect(safe).not.toMatch(/\r/);
        // What the renderer reads as prose after a line that only looks like a fence is a link.
        for (const label of [
            'after a fake fence',
            'after an indented fence',
            'after a fence with a backtick',
            'after a quoted fence',
            'after a list fence',
            'after carriage returns',
        ]) {
            expect(safe, label).toContain(`\n[${label}](`);
        }
        // Code stays readable: the joiner is invisible.
        expect(safe).toContain(`!${J}[in code](http://localhost:4391/code.png)`);
        expect(safe).toContain(`<${J}video src="http://localhost:4391/code.mp4">`);
    });

    it('holds for every line of hostile Markdown on its own, and every prefix of it', () => {
        const lines = HOSTILE.split('\n');
        for (let end = 1; end <= lines.length; end++) {
            const text = lines.slice(0, end).join('\n');
            expect(hasImage(safeMarkdown(text)), text).toBe(false);
            expect(hasImage(safeMarkdown(lines[end - 1] ?? '')), lines[end - 1]).toBe(false);
            expect(hasVideoBlock(safeMarkdown(text)), text).toBe(false);
            expect(hasVideoBlock(safeMarkdown(lines[end - 1] ?? '')), lines[end - 1]).toBe(false);
        }
    });

    it('holds for random mixes of the dangerous pieces', () => {
        const pieces = [
            '![',
            '](',
            ')',
            '`',
            '``',
            '```',
            '~~~',
            '\n',
            '\r',
            '> ',
            '- ',
            '2. ',
            '1. ',
            '\t',
            '    ',
            '\\',
            '<',
            'video',
            'a',
            ' ',
            '[',
            ']',
        ];
        let seed = 7;
        const next = () => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed;
        };
        for (let run = 0; run < 3000; run++) {
            let text = '';
            for (let piece = next() % 40; piece > 0; piece--) {
                text += pieces[next() % pieces.length];
            }
            const safe = safeMarkdown(text);
            expect(hasImage(safe), JSON.stringify(text)).toBe(false);
            expect(hasVideoBlock(safe), JSON.stringify(text)).toBe(false);
        }
    });
});

const CHART: InlineChartData = {
    version: 1,
    kind: 'bar',
    title: 'Sales',
    description: 'Monthly totals',
    xLabel: 'Month',
    yLabel: 'Total',
    points: [
        { label: 'Jan', value: 120 },
        { label: 'Feb', value: null },
        { label: 'Mar', value: 340 },
    ],
};

describe('socio-chart fences', () => {
    it('cuts a reply into Markdown and the chart, keeping the data table after it', () => {
        const parts = replyParts(`Here:\n\n${formatInlineChart(CHART)}\n\nDone.`);
        expect(parts.map((part) => part.kind)).toEqual(['markdown', 'chart', 'markdown']);
        expect(parts[1]).toMatchObject({ kind: 'chart', chart: CHART });
        expect(parts[2]?.kind === 'markdown' && parts[2].text).toContain('| ` Feb ` | Not available |');
    });

    it('draws at most three, and leaves invalid, unclosed, indented or quoted ones as code', () => {
        const fence = formatInlineChart(CHART).split('\n\n')[0] ?? '';
        expect(
            replyParts([fence, fence, fence, fence].join('\n\n')).filter((part) => part.kind === 'chart'),
        ).toHaveLength(3);
        const kept = (text: string) => replyParts(text).every((part) => part.kind === 'markdown');
        expect(kept('```socio-chart\n{"version": 2}\n```')).toBe(true);
        expect(kept('```socio-chart\n{"version": 1}')).toBe(true);
        expect(kept(fence.replace(/\n```$/, '\n````'))).toBe(true);
        expect(kept(`> ${fence.replaceAll('\n', '\n> ')}`)).toBe(true);
        expect(kept(`  ${fence.replaceAll('\n', '\n  ')}`)).toBe(true);
        expect(kept(`\`\`\`\`\n${fence}\n\`\`\`\``)).toBe(true);
    });

    it('lays a chart out as the web does', () => {
        expect(niceTicks(0, 340)).toEqual([0, 100, 200, 300, 400]);
        expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(barPath(0, 100, 50, 10)).toBe('M0,100V54Q0,50 4,50H6Q10,50 10,54V100Z');
        const layout = chartLayout(CHART, 300);
        expect(layout.bars).toHaveLength(2);
        expect(layout.labels.map((label) => label.text)).toEqual(['Jan', 'Feb', 'Mar']);
        expect(layout.ticks.map((tick) => tick.label)).toEqual(['0', '100', '200', '300', '400']);
        const line = chartLayout({ ...CHART, kind: 'line' }, 300);
        expect(line.line.match(/M/g)).toHaveLength(2);
        expect(line.dots).toHaveLength(2);
        expect(chartSummary(CHART)).toBe(
            'Sales. Monthly totals: Bar chart of Total by Month, 3 points, from 120 to 340.',
        );
    });
});

describe('link rules', () => {
    it('opens only http(s) and mailto, and workspace paths', () => {
        expect(linkTarget('https://other.example/a', ORIGIN)).toEqual({
            kind: 'external',
            url: 'https://other.example/a',
        });
        expect(linkTarget('mailto:ada@example.test', ORIGIN)).toEqual({
            kind: 'external',
            url: 'mailto:ada@example.test',
        });
        expect(linkTarget('/issues/CB-1', ORIGIN)).toEqual({
            kind: 'issue',
            url: `${ORIGIN}/issues/CB-1`,
            key: 'CB-1',
        });
        expect(linkTarget('/issues/CB-1?tab=x', ORIGIN)).toEqual({
            kind: 'workspace',
            url: `${ORIGIN}/issues/CB-1?tab=x`,
        });
        expect(linkTarget(`${ORIGIN}/pages/x`, ORIGIN)).toEqual({ kind: 'workspace', url: `${ORIGIN}/pages/x` });
        for (const href of [
            'javascript:alert(1)',
            'JavaScript:alert(1)',
            ' javascript:alert(1)',
            'java\nscript:alert(1)',
            'data:text/html,<img src=x>',
            'file:///etc/hosts',
            'intent://x#Intent;scheme=http;end',
            'tel:123',
            'socio-dev://diagnostics',
            '//evil.example/x',
            '/\\evil.example/x',
            '\\\\evil.example',
            'issues/CB-1',
            '#top',
            'http:/evil.example',
            'https://exa mple.com',
            '',
            null,
            undefined,
        ]) {
            expect(linkTarget(href, ORIGIN), String(href)).toBeNull();
        }
    });

    it('opens an issue’s attachment in the app only as a root-relative path with no query or hash', () => {
        const id = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
        expect(linkTarget(`/api/issue-attachments/${id}`, ORIGIN)).toEqual({
            kind: 'issue-attachment',
            url: `${ORIGIN}/api/issue-attachments/${id}`,
            id,
        });
        // Anything else is the web's, through the browser, never read with the app's cookie.
        for (const href of [
            `${ORIGIN}/api/issue-attachments/${id}`,
            `/api/issue-attachments/${id}?download=1`,
            `/api/issue-attachments/${id}#x`,
            `/api/issue-attachments/../media/uploads`,
            `/api/issue-attachments/a/b`,
            `/api/issue-attachments/%2e%2e`,
        ]) {
            expect(linkTarget(href, ORIGIN)?.kind, href).toBe('workspace');
        }
        for (const href of [
            `//evil.example/api/issue-attachments/${id}`,
            `https://other.example/api/issue-attachments/${id}`,
        ]) {
            expect(linkTarget(href, ORIGIN)?.kind ?? null, href).not.toBe('issue-attachment');
        }
    });

    it('names an issue chip only for this workspace’s issue paths', () => {
        expect(issueKeyOf('/issues/CB-12', ORIGIN)).toBe('CB-12');
        expect(issueKeyOf(`${ORIGIN}/issues/CB-3`, ORIGIN)).toBe('CB-3');
        for (const href of [
            '/issues/CB-0',
            '/issues/CB-12?x=1',
            '/issues/CB-12#a',
            'https://other.example/issues/CB-1',
            '/issues/cb-1',
        ]) {
            expect(issueKeyOf(href, ORIGIN), href).toBeNull();
        }
        const pattern = new RegExp(issueLinkPattern(ORIGIN));
        expect(pattern.test('/issues/CB-12')).toBe(true);
        expect(pattern.test(`${ORIGIN}/issues/CB-12`)).toBe(true);
        expect(pattern.test('https://acmeXexample/issues/CB-12')).toBe(false);
        expect(pattern.test('/issues/CB-12?x')).toBe(false);
    });

    it('says the person signs in once in that browser, the workspace by name', () => {
        expect(webSignInLine('Acme', true)).toContain('app’s browser');
        expect(webSignInLine('Acme', false)).toContain('sign in to Acme in your browser');
        expect(webSignInLine('Acme', false)).not.toMatch(/\bDot\b/);
    });
});

describe("issue links as cards (the web's IssueLinkCard)", () => {
    /** Each part in short: `md:<text>` or `cards:CB-1,CB-2`. */
    const shape = (parts: readonly IssueCardPart[]) =>
        parts.map((part) =>
            part.kind === 'issues' ? `cards:${part.links.map((link) => link.key).join(',')}` : `md:${part.text.trim()}`,
        );

    it("makes a paragraph or list item of issue links only a stack of cards, and leaves running text's chips", () => {
        const reply = [
            'Your observation was added to [CB-1](/issues/CB-1). [CB-2](/issues/CB-2) is about something else.',
            '',
            '[CB-2](/issues/CB-2)',
            '',
            `[CB-3](${ORIGIN}/issues/CB-3).`,
            '',
            '- [CB-1](/issues/CB-1)',
            '- [CB-2](/issues/CB-2).',
            '- [CB-3](/issues/CB-3), the follow-up.',
            '',
            'Filed it and attached your screenshot.',
            '',
            '[Open CB-1](/issues/CB-1) ↗',
        ].join('\n');
        expect(shape(issueCardParts(reply, ORIGIN))).toEqual([
            'md:Your observation was added to [CB-1](/issues/CB-1). [CB-2](/issues/CB-2) is about something else.',
            'cards:CB-2,CB-3,CB-1,CB-2',
            'md:- [CB-3](/issues/CB-3), the follow-up.\n\nFiled it and attached your screenshot.',
            'cards:CB-1',
        ]);
        const card = issueCardParts('[CB-12](/issues/CB-12)', ORIGIN)[0];
        expect(card).toEqual({
            kind: 'issues',
            key: 'i0',
            links: [{ key: 'CB-12', number: 12, source: '[CB-12](/issues/CB-12)' }],
        });
    });

    it("keeps a mixed list's bullets, each card item indented under its marker, as the web's `li`", () => {
        const mixed = [
            '- [CB-1](/issues/CB-1)',
            '- [CB-2](/issues/CB-2).',
            '- [CB-3](/issues/CB-3), the follow-up.',
        ].join('\n');
        const parts = issueCardParts(mixed, ORIGIN);
        expect(shape(parts)).toEqual(['cards:CB-1,CB-2', 'md:- [CB-3](/issues/CB-3), the follow-up.']);
        const cards = parts[0]!.kind === 'issues' ? parts[0]!.links : [];
        expect(cards.map((link) => link.bullet?.marker)).toEqual(['•', '•']);
        expect(issueCardGroups(cards).map((group) => [group.marker, group.links.map((link) => link.key)])).toEqual([
            ['•', ['CB-1']],
            ['•', ['CB-2']],
        ]);
        // An ordered list keeps its numbers beside its cards.
        const ordered = issueCardParts(['1. First', '2. [CB-2](/issues/CB-2)'].join('\n'), ORIGIN);
        expect(ordered[1]?.kind === 'issues' && ordered[1].links[0]?.bullet?.marker).toBe('2.');
        // A list of issue links only has no bullets, as on the web; nor has a paragraph of them.
        const only = issueCardParts(['- [CB-1](/issues/CB-1)', '- [CB-2](/issues/CB-2)'].join('\n'), ORIGIN);
        const plain = only[0]?.kind === 'issues' ? only[0].links : [];
        expect(plain.every((link) => link.bullet === undefined)).toBe(true);
        expect(issueCardGroups(plain)).toHaveLength(1);
    });

    it("puts an inline issue link's status beside it (the web's “CB-3 [Ready]”), never in code", () => {
        const statusOf = (number: number) => (number === 3 ? ('ready' as const) : undefined);
        expect(withIssueStatuses('- [CB-3](/issues/CB-3), the follow-up.', ORIGIN, statusOf)).toBe(
            '- [CB-3](/issues/CB-3) [Ready](socio-status:ready/CB-3), the follow-up.',
        );
        // An issue the phone doesn't hold, another site's link, and code stay as written.
        expect(withIssueStatuses('See [CB-4](/issues/CB-4).', ORIGIN, statusOf)).toBe('See [CB-4](/issues/CB-4).');
        expect(withIssueStatuses('[CB-3](https://x.example/issues/CB-3)', ORIGIN, statusOf)).toBe(
            '[CB-3](https://x.example/issues/CB-3)',
        );
        expect(withIssueStatuses('`[CB-3](/issues/CB-3)`', ORIGIN, statusOf)).toBe('`[CB-3](/issues/CB-3)`');
        const fenced = ['```', '[CB-3](/issues/CB-3)', '```'].join('\n');
        expect(withIssueStatuses(fenced, ORIGIN, statusOf)).toBe(fenced);
    });

    it("numbers a mixed ordered list's cards from its start and their place, as the web's `ol`", () => {
        const markers = (markdown: string) =>
            issueCardParts(markdown, ORIGIN).flatMap((part) =>
                part.kind === 'issues' ? part.links.map((link) => link.bullet?.marker) : [`md:${part.text}`],
            );
        // Repeated `1.` markers count up, and a Markdown item after the cards says its number.
        expect(
            markers(['1. Intro', '1. [CB-3](/issues/CB-3)', '1. [CB-4](/issues/CB-4)', '1. Outro'].join('\n')),
        ).toEqual(['md:1. Intro', '2.', '3.', 'md:4. Outro']);
        // A list starting at 5, with `)` markers.
        expect(markers(['5) Intro', '5) [CB-3](/issues/CB-3)', '9) [CB-4](/issues/CB-4)'].join('\n'))).toEqual([
            'md:5) Intro',
            '6)',
            '7)',
        ]);
        // A loose list goes on counting across its blank lines.
        expect(markers(['1. Intro', '', '1. [CB-3](/issues/CB-3)'].join('\n'))).toEqual(['md:1. Intro\n', '2.']);
    });

    it('reads a loose list as one list: bullets from the whole of it, numbers across its cards and blank lines', () => {
        const markers = (markdown: string) =>
            issueCardParts(markdown, ORIGIN).flatMap((part) =>
                part.kind === 'issues'
                    ? part.links.map((link) => link.bullet?.marker ?? 'none')
                    : [`md:${part.text.trim()}`],
            );
        const card = (n: number) => `[CB-${n}](/issues/CB-${n})`;
        // Ordered: the item after the card goes on counting.
        expect(markers(['1. Intro', '', `1. ${card(3)}`, '', '1. Outro'].join('\n'))).toEqual([
            'md:1. Intro',
            '2.',
            'md:3. Outro',
        ]);
        // Starting with a card: the later Markdown item makes the list mixed, so the card keeps its marker.
        expect(markers([`- ${card(3)}`, '', '- Follow-up'].join('\n'))).toEqual(['•', 'md:- Follow-up']);
        expect(markers([`1. ${card(3)}`, '', `1. ${card(4)}`, '', '1. Then this'].join('\n'))).toEqual([
            '1.',
            '2.',
            'md:3. Then this',
        ]);
        expect(markers([`3) ${card(3)}`, '', '3) Then this'].join('\n'))).toEqual(['3)', 'md:4) Then this']);
        // A loose list of cards only has no markers, ordered or bulleted.
        expect(markers([`- ${card(3)}`, '', `- ${card(4)}`].join('\n'))).toEqual(['none', 'none']);
        expect(markers([`1. ${card(3)}`, '', `2. ${card(4)}`].join('\n'))).toEqual(['none', 'none']);
        // A paragraph between ends the list; another marker starts another one.
        expect(markers([`- ${card(3)}`, '', 'Words.', '', '- Other'].join('\n'))).toEqual([
            'none',
            'md:Words.\n\n- Other',
        ]);
        expect(markers([`- ${card(3)}`, '', '* Other'].join('\n'))).toEqual(['none', 'md:* Other']);
        // A change of marker with no blank line before it starts another list too (CommonMark): the `-`
        // list is cards only, so no bullets, and the `*` list stays Markdown.
        expect(markers([`- ${card(3)}`, '', `- ${card(4)}`, '* Other'].join('\n'))).toEqual([
            'none',
            'none',
            'md:* Other',
        ]);
        expect(markers([`- ${card(3)}`, '* Other', `* ${card(4)}`].join('\n'))).toEqual(['none', 'md:* Other', '•']);
        // An ordered list's `.` to `)` too: the new list counts from its own first number.
        expect(markers(['1. Intro', `2. ${card(3)}`, `7) ${card(4)}`, '8) Outro'].join('\n'))).toEqual([
            'md:1. Intro',
            '2.',
            '7)',
            'md:8) Outro',
        ]);
    });

    it('draws each status chip in its tone and opens its issue from it, as the web’s badge is in the link (CB-414)', () => {
        for (const status of ISSUE_STATUSES) {
            const url = statusLinkOf(status, 'CB-12');
            expect(new RegExp(statusLinkPattern(status)).test(url), status).toBe(true);
            // One fixed pattern per status, whatever the issue: the style stays stable while statuses load.
            expect(new RegExp(statusLinkPattern(status)).test(statusLinkOf(status, 'CB-7'))).toBe(true);
            expect(tappedLink(url)).toBe('/issues/CB-12');
        }
        expect(new RegExp(statusLinkPattern('ready')).test(statusLinkOf('done', 'CB-3'))).toBe(false);
        expect(tappedLink('socio-status:ready')).toBeNull();
        expect(tappedLink('socio-status:ready/../../x')).toBeNull();
        expect(tappedLink('/spaces/a')).toBe('/spaces/a');
    });

    it('never puts a status in code: fences (quoted, in a list), indented code and code spans of any length', () => {
        const statusOf = () => 'ready' as const;
        const link = '[CB-3](/issues/CB-3)';
        const cases = [
            `    ${link}`,
            ['> ```', `> ${link}`, '> ```'].join('\n'),
            ['- item', '  ```', `  ${link}`, '  ```'].join('\n'),
            ['~~~', link, '~~~'].join('\n'),
            `\`\` a \` ${link} \`\``,
            `\`\`\`${link}\`\`\` after`,
            [`\`start`, `${link}\``].join('\n'),
        ];
        for (const markdown of cases) {
            expect(withIssueStatuses(markdown, ORIGIN, statusOf)).toBe(markdown);
        }
        // Prose around code still gets its chip; an unmatched or escaped backtick opens no code.
        expect(withIssueStatuses(`\`x\` ${link}`, ORIGIN, statusOf)).toBe(
            `\`x\` ${link} [Ready](socio-status:ready/CB-3)`,
        );
        expect(withIssueStatuses(`\\\` ${link} \``.trim(), ORIGIN, statusOf)).toContain('socio-status:ready');
        expect(withIssueStatuses(`\`\` ${link} \``, ORIGIN, statusOf)).toContain('socio-status:ready');
        expect(withIssueStatuses(['```', 'code', '```', link].join('\n'), ORIGIN, statusOf)).toBe(
            ['```', 'code', '```', `${link} [Ready](socio-status:ready/CB-3)`].join('\n'),
        );
        expect(withIssueStatuses(`> ${link}`, ORIGIN, statusOf)).toBe(`> ${link} [Ready](socio-status:ready/CB-3)`);
    });

    it("takes separators between links but no words, and only this workspace's issues", () => {
        expect(
            issueLinksOnly('[CB-1](/issues/CB-1), [CB-2](/issues/CB-2) and [CB-3](/issues/CB-3).', ORIGIN),
        ).toHaveLength(3);
        expect(issueLinksOnly('**[CB-1](/issues/CB-1)** ↗', ORIGIN)).toHaveLength(1);
        expect(issueLinksOnly('See [CB-1](/issues/CB-1)', ORIGIN)).toBeNull();
        expect(issueLinksOnly('[CB-1](https://other.example/issues/CB-1)', ORIGIN)).toBeNull();
        expect(issueLinksOnly('[CB-1](/issues/CB-1?x=1)', ORIGIN)).toBeNull();
        expect(issueLinksOnly('[CB-1](/issues/CB-1) [docs](/spaces/a)', ORIGIN)).toBeNull();
        expect(issueLinksOnly('', ORIGIN)).toBeNull();
    });

    it("never reads code, headings, quotes or tables as cards, and keeps an ordered list's numbers", () => {
        const code = ['```', '[CB-9](/issues/CB-9)', '', '[CB-8](/issues/CB-8)', '```'].join('\n');
        expect(shape(issueCardParts(code, ORIGIN))).toEqual([`md:${code}`]);
        expect(shape(issueCardParts('    [CB-7](/issues/CB-7)', ORIGIN))).toEqual(['md:[CB-7](/issues/CB-7)']);
        for (const line of ['# [CB-1](/issues/CB-1)', '> [CB-1](/issues/CB-1)', '| [CB-1](/issues/CB-1) |']) {
            expect(shape(issueCardParts(line, ORIGIN))).toEqual([`md:${line}`]);
        }
        const ordered = ['1. First', '2. [CB-2](/issues/CB-2)', '3. Third'].join('\n');
        expect(shape(issueCardParts(ordered, ORIGIN))).toEqual(['md:1. First', 'cards:CB-2', 'md:3. Third']);
        // A list item that runs on to another line is left whole.
        const lazy = ['- [CB-1](/issues/CB-1)', '  more words'].join('\n');
        expect(shape(issueCardParts(lazy, ORIGIN))).toEqual([`md:${lazy}`]);
    });

    it("draws each card from the phone's issue: key, title, excerpt and the web's badges", () => {
        const issue: IssueSummary = {
            number: 1,
            title: 'A: Search misses accents',
            status: 'triage',
            priority: 'medium',
            kind: 'bug',
            area: null,
            labels: [],
            assigneeId: null,
            updatedAt: 1,
            excerpt: 'Filed by Ben in Workspace A.',
        };
        const view = issueCardView(issue);
        expect(view).toMatchObject({
            key: 'CB-1',
            title: 'A: Search misses accents',
            excerpt: 'Filed by Ben in Workspace A.',
        });
        expect(view.pills).toEqual([
            { label: 'Triage', tone: 'violet' },
            { label: 'Medium', tone: 'sky' },
            { label: 'Bug', tone: null },
        ]);
        expect(view.accessibilityLabel).toBe('CB-1: A: Search misses accents, Triage, Medium priority, Bug');
        // The web's neutral badges: won't fix and low priority carry no hue.
        const quiet = issueCardView({ ...issue, status: 'wont_fix', priority: 'low', excerpt: ' ' });
        expect(quiet.pills.slice(0, 2).map((pill) => pill.tone)).toEqual([null, null]);
        expect(quiet.excerpt).toBeNull();
    });

    it("is drawn only in a chat's replies, and an issue the phone lacks stays its chip", () => {
        const src = (file: string) => readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8');
        expect(src('chat.tsx')).toContain('<ReplyMarkdown text={shown} testID={testID} issueCards />');
        expect(src('chat-markdown.tsx')).toContain('issueCards = false');
        expect(src('chat-markdown.tsx')).toContain('issueCardParts(part.text, workspace.origin)');
        expect(src('issue-card.tsx')).toContain(
            '{issue === undefined ? chip(link.source) : <IssueCard issue={issue} />}',
        );
        expect(src('issue-card.tsx')).toContain('useSyncOnFocus(SYNCED);');
    });
});
