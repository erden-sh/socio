import { expect, it } from 'vitest';

import { pageText } from '@socio/shared/pages/page-text';

// The plain text the search index holds.

it('drops front matter, dataset views, HTML and Markdown markers', () => {
    expect(
        pageText(
            [
                '---',
                'owner: finance',
                '---',
                '# Budget **review**',
                '',
                '> A _quote_ with `code` and ~~strike~~.',
                '',
                '```dataset-view',
                '{"datasetId":"d1","query":"SELECT secret FROM t"}',
                '```',
                '',
                '<div class="note">Inside a <b>tag</b></div>',
                '<script>alert("no")</script><style>.x{color:red}</style>',
                '<!-- a comment -->',
                'Tom &amp; Jerry&nbsp;again &#169; &#99999999;',
            ].join('\n'),
        ),
    ).toBe('Budget review A quote with code and strike. Inside a tag Tom & Jerry again ©');
});

it('keeps link text, drops targets, images and reference definitions', () => {
    expect(
        pageText(
            [
                'See [the roadmap](https://example.com/road(map)) and ![a chart](chart.png "Chart").',
                '[![build badge](https://ci/badge.svg)](https://ci/build) [Docs][docs] <https://auto.link>',
                '',
                '[docs]: https://example.com/docs "Docs"',
            ].join('\n'),
        ),
    ).toBe('See the roadmap and . Docs');
});

it('keeps fenced and inline code, table cells and list items', () => {
    expect(
        pageText(
            [
                '| Name | Owner |',
                '| :--- | ---: |',
                '| Invoice | Ana |',
                '',
                '- [x] ship the release',
                '1. call the vendor',
                '',
                '```ts',
                'const page_search = 1;',
                '```',
                '',
                '~~~',
                'unclosed tilde fence stays code',
            ].join('\n'),
        ),
    ).toBe(
        'Name Owner Invoice Ana ship the release call the vendor const page_search = 1; unclosed tilde fence stays code',
    );
});

it('turns control characters into spaces and collapses whitespace', () => {
    expect(pageText('one\u0001two\u0002\tthree\r\n\r\n  four\u007f')).toBe('one two three four');
    expect(pageText('')).toBe('');
});

it('is fast on a 100,000-character page', () => {
    const page = Array.from(
        { length: 1500 },
        (_, index) => `## Part ${index}\n\nSome [link](https://x/${index}) text with **bold** and \`code\`.`,
    )
        .join('\n\n')
        .slice(0, 100_000);
    const started = performance.now();
    const text = pageText(page);
    expect(performance.now() - started).toBeLessThan(200);
    expect(text).toContain('Part 10 Some link text with bold and code.');
});
