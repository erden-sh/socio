// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { expect, it } from 'vitest';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { inspectMarkdown, markdownManager } from '../src/modules/pages/editor/markdown';

const post =
    '## Original post\n\n<blockquote>\nWe just launched OpenUSD support on the @huggingface Hub 🎉\n\nYesterday, @nvidiaomniverse put 2,500+ SimReady assets on the Hub.\n</blockquote>\n\n## Analysis\n\nText.';
const html = (markdown: string) =>
    renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown));

it("converts the CB-201 page's blockquote to Markdown quote lines", () => {
    expect(simpleHtmlToMarkdown(post)).toBe(
        '## Original post\n\n> We just launched OpenUSD support on the @huggingface Hub 🎉\n>\n> Yesterday, @nvidiaomniverse put 2,500+ SimReady assets on the Hub.\n\n## Analysis\n\nText.',
    );
    const out = html(simpleHtmlToMarkdown(post));
    expect(out).toContain('<blockquote>');
    expect(out).not.toContain('&lt;');
});

it('nests blockquotes', () => {
    const out = simpleHtmlToMarkdown('<blockquote>outer\n<blockquote>inner</blockquote>\nafter</blockquote>');
    expect(out).toBe('> outer\n>\n> > inner\n>\n> after');
    expect(html(out)).toMatch(/<blockquote>[\s\S]*<blockquote>[\s\S]*inner/);
});

it('keeps links, emphasis and line breaks inside a quote', () => {
    const out = simpleHtmlToMarkdown(
        '<blockquote>See **this** and *that* via [Hub](https://huggingface.co)<br>second line<br/>third</blockquote>',
    );
    expect(out).toBe('> See **this** and *that* via [Hub](https://huggingface.co)\\\n> second line\\\n> third');
    const rendered = html(out);
    expect(rendered).toContain('<strong>this</strong>');
    expect(rendered).toContain('<em>that</em>');
    expect(rendered).toContain('href="https://huggingface.co"');
    expect(rendered.match(/<br\/>/g)).toHaveLength(2);
});

it('leaves code, unbalanced tags and tags with attributes alone', () => {
    for (const source of [
        '```html\n<blockquote>x</blockquote>\n```',
        'Use `<blockquote>` and `<br>` in HTML.',
        '<blockquote>never closed',
        'stray </blockquote> close',
        '<blockquote class="a">x</blockquote>',
        '<blockquote onclick="x()">x</blockquote>',
        '<blockquote>\n```\ncode\n```\n</blockquote>',
        'No html at all',
    ]) {
        expect(simpleHtmlToMarkdown(source)).toBe(source);
    }
});

it.each([
    '<script>alert(1)</script>',
    '<blockquote><script>alert(1)</script></blockquote>',
    '<blockquote onmouseover="alert(1)">hi</blockquote>',
    '<iframe src="https://evil.example"></iframe>',
    '<blockquote><iframe src="https://evil.example"></iframe></blockquote>',
    '<style>body{display:none}</style>',
    '<blockquote style="position:fixed">hi</blockquote>',
    '<img src=x onerror=alert(1)>',
    '<blockquote><br onclick="x()"></blockquote>',
    '[x](javascript:alert(1))',
    '<blockquote>[x](javascript:alert(1))</blockquote>',
    '<blockquote>\n<a href="javascript:alert(1)">x</a>\n</blockquote>',
])('never lets active content through: %s', (source) => {
    const dom = document.createElement('div');
    dom.innerHTML = html(simpleHtmlToMarkdown(source));
    expect(dom.querySelector('script, iframe, style, img, object, embed')).toBeNull();
    for (const element of dom.querySelectorAll('*')) {
        for (const name of element.getAttributeNames()) {
            expect(name).not.toMatch(/^(on|style)/i);
            expect(element.getAttribute(name)).not.toMatch(/^\s*javascript:/i);
        }
    }
    // The editor still sends such a page to Markdown source mode.
    if (/<(script|iframe|style|img|a)\b|on\w+=/i.test(source)) {
        expect(inspectMarkdown(source).supported).toBe(false);
    }
});

it('opens a page with only a blockquote in the rich editor', () => {
    expect(inspectMarkdown(post)).toEqual({ supported: true });
    expect(inspectMarkdown('<blockquote>a<br>b</blockquote>').supported).toBe(true);
    expect(inspectMarkdown('<blockquote>a</blockquote><details>x</details>')).toMatchObject({ supported: false });
});

it('round-trips through the editor model as Markdown quote lines', () => {
    const doc = markdownManager.parse(simpleHtmlToMarkdown(post));
    expect(JSON.stringify(doc)).toContain('"type":"blockquote"');
    const saved = markdownManager.serialize(doc);
    expect(saved).toContain('> We just launched');
    expect(saved).not.toContain('<blockquote');
    expect(markdownManager.parse(saved)).toEqual(doc);
});
