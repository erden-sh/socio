import { expect, it } from 'vitest';

import { embedCardMarkdown } from '@socio/shared/embed-card';
import { pageImageMarkdown } from '@socio/shared/page-image';

import { inspectMarkdown, markdownManager } from '../src/modules/pages/editor/markdown';

it('round-trips supported writing structures without losing semantic content', () => {
    const source =
        '# Project\n\nA **bold**, *italic*, ~~done~~ and `code` sentence.\n\n- First\n  - Nested\n\n1. Ordered\n2. Second\n\n- [ ] Open\n- [x] Complete\n\n> A quoted thought\n\n```ts\nconst value = "<safe>";\n```\n\n---\n\n| Name | Status |\n| --- | --- |\n| A | Ready |\n\n[Page](/#/spaces/space/pages/page)';
    expect(inspectMarkdown(source).supported).toBe(true);
    const first = markdownManager.parse(source);
    const roundtrip = markdownManager.serialize(first);
    expect(markdownManager.parse(roundtrip)).toEqual(first);
    expect(roundtrip).toContain('Complete');
    expect(roundtrip).toContain('/#/spaces/space/pages/page');
});
it.each([
    '![remote](https://example.com/photo.png)',
    '<script>alert(1)</script>',
    '<details><summary>Note</summary>Hidden</details>',
    '[^1]: A footnote',
    '---\ntitle: Front matter\n---\nBody',
])('requires exact source editing for unsupported Markdown: %s', (source) => {
    const result = inspectMarkdown(source);
    expect(result.supported).toBe(false);
    expect(result.reason).toBeTruthy();
});
it('does not mistake source code containing HTML for active HTML', () => {
    expect(inspectMarkdown('```html\n<img src="https://example.com">\n```').supported).toBe(true);
});
it('detects unsupported content nested inside task items', () => {
    expect(inspectMarkdown('- [ ] ![remote](https://example.com/a.png)').supported).toBe(false);
    expect(inspectMarkdown('- [x] <iframe>embedded</iframe>').supported).toBe(false);
});
it('preserves reference definitions through explicit source fallback, including unused definitions', () => {
    expect(inspectMarkdown('A\n\n[unused]: https://example.com "keep"').supported).toBe(false);
    expect(inspectMarkdown('[Linked][ref]\n\n[ref]: https://example.com').supported).toBe(false);
});
it('opens a bold link in the rich editor: mark order is not a formatting loss (CB-230)', () => {
    // The page in CB-230's screenshot: the editor saves `**[a](b)**` as
    // `[**a**](b)`, whose marks parse in the other order. Same document.
    const source =
        '# Someone on X: Carbon-X\n\n**[View original post](https://x.com/someone/status/1?s=46)** · Oct 22, 2026\n\n> The good news: you can mid-train yourself to the frontier!';
    expect(inspectMarkdown(source)).toEqual({ supported: true });
    expect(inspectMarkdown('*[a](https://example.com)* and ~~**b**~~')).toEqual({
        supported: true,
    });
});

const card = {
    url: 'https://x.com/someone/status/1',
    kind: 'post',
    provider: 'X',
    author: 'Some One',
    handle: '@someone',
    text: 'Text with ``` fences` and "quotes"',
    media: [{ id: 'cbemb_0123456789abcdef', kind: 'image', alt: 'A chart' }],
    fetchedAt: '2026-10-27T12:00:00.000Z',
};
it('keeps a link card as a block the rich editor opens and saves unchanged (CB-230)', () => {
    const source = `# Notes\n\n${embedCardMarkdown(card as never)}\n\nAfter.`;
    // A backtick on the card can't close its fence.
    expect(source).not.toMatch(/```[^`\n]*fences/);
    expect(inspectMarkdown(source)).toEqual({ supported: true });
    const doc = markdownManager.parse(source);
    expect(doc.content!.map((node) => node.type)).toEqual(['heading', 'embedCard', 'paragraph']);
    expect(doc.content![1].attrs!.card).toEqual(card);
    expect(markdownManager.serialize(doc)).toBe(source);
    // Hand-written JSON in another key order reads as the same card.
    const reordered = `\`\`\`embed\n${JSON.stringify({ fetchedAt: card.fetchedAt, kind: 'link', url: card.url })}\n\`\`\``;
    expect(inspectMarkdown(reordered)).toEqual({ supported: true });
    expect(markdownManager.parse(reordered).content![0].type).toBe('embedCard');
});

it.each([
    ['broken JSON', '```embed\n{ not json\n```'],
    ['an unknown field', `\`\`\`embed\n${JSON.stringify({ ...card, html: '<iframe>' })}\n\`\`\``],
    ['a script URL', `\`\`\`embed\n${JSON.stringify({ ...card, url: 'javascript:alert(1)' })}\n\`\`\``],
    [
        'a remote media URL',
        `\`\`\`embed\n${JSON.stringify({ ...card, media: [{ id: 'https://evil.example/x.png', kind: 'image' }] })}\n\`\`\``,
    ],
])('keeps an ```embed fence with %s as a plain code block', (_name, source) => {
    const doc = markdownManager.parse(source);
    expect(doc.content!.map((node) => node.type)).toEqual(['codeBlock']);
    expect(inspectMarkdown(source).supported).toBe(true);
});

const picture = { id: 'cbemb_0123456789abcdef', alt: 'The `whiteboard` after "planning"', width: 1600, height: 1200 };
it('keeps a picture as a block the rich editor opens and saves unchanged (CB-358)', () => {
    const source = `Before.\n\n${pageImageMarkdown(picture)}\n\nAfter.`;
    // The page stores the embed's id as an ```image fence, never image Markdown.
    expect(source).not.toMatch(/!\[|\/api\/media/);
    expect(source).not.toMatch(/```[^`\n]*whiteboard/);
    expect(inspectMarkdown(source)).toEqual({ supported: true });
    const doc = markdownManager.parse(source);
    expect(doc.content!.map((node) => node.type)).toEqual(['paragraph', 'pageImage', 'paragraph']);
    expect(doc.content![1].attrs).toEqual(picture);
    expect(markdownManager.serialize(doc)).toBe(source);
    // Only the id is required; hand-written JSON in another key order reads too.
    const bare = '```image\n{"height":10,"id":"cbemb_fedcba9876543210"}\n```';
    expect(inspectMarkdown(bare)).toEqual({ supported: true });
    const parsed = markdownManager.parse(bare);
    expect(parsed.content![0].attrs).toEqual({ id: 'cbemb_fedcba9876543210', alt: null, width: null, height: 10 });
    expect(markdownManager.serialize(parsed)).toBe(
        '```image\n{\n  "id": "cbemb_fedcba9876543210",\n  "height": 10\n}\n```',
    );
});

it.each([
    ['an empty alt', '```image\n{\n  "id": "cbemb_0123456789abcdef",\n  "alt": ""\n}\n```', null],
    ['a blank alt', '```image\n{\n  "id": "cbemb_0123456789abcdef",\n  "alt": "  "\n}\n```', null],
    ['no alt', pageImageMarkdown({ id: 'cbemb_0123456789abcdef' }), null],
    ['an alt', pageImageMarkdown({ id: 'cbemb_0123456789abcdef', alt: 'A chart' }), 'A chart'],
])('keeps a picture with %s in the rich editor, round-tripping (CB-358)', (_name, source, alt) => {
    expect(inspectMarkdown(source)).toEqual({ supported: true });
    const doc = markdownManager.parse(source);
    expect(doc.content![0].type).toBe('pageImage');
    expect(doc.content![0].attrs!.alt).toBe(alt);
    // Saved, a picture with no alt (or an empty one) is written the editor's
    // way, without the key, and reads back the same.
    const saved = markdownManager.serialize(doc);
    expect(saved).toBe(pageImageMarkdown({ id: 'cbemb_0123456789abcdef', ...(alt ? { alt } : {}) }));
    expect(markdownManager.parse(saved)).toEqual(doc);
    expect(markdownManager.serialize(markdownManager.parse(saved))).toBe(saved);
});

it.each([
    ['broken JSON', '```image\n{ not json\n```'],
    ['no id', '```image\n{ "alt": "A chart" }\n```'],
    ['a remote URL as its id', `\`\`\`image\n${JSON.stringify({ id: 'https://evil.example/x.png' })}\n\`\`\``],
    ['a src', `\`\`\`image\n${JSON.stringify({ ...picture, src: 'https://evil.example/x.png' })}\n\`\`\``],
    ['a bad size', `\`\`\`image\n${JSON.stringify({ ...picture, width: -1 })}\n\`\`\``],
])('keeps an ```image fence with %s as a plain code block (CB-358)', (_name, source) => {
    const doc = markdownManager.parse(source);
    expect(doc.content!.map((node) => node.type)).toEqual(['codeBlock']);
    expect(inspectMarkdown(source).supported).toBe(true);
    expect(markdownManager.serialize(doc)).toBe(source);
});

it('still sends image Markdown to source mode (CB-358)', () => {
    expect(inspectMarkdown('![A chart](/api/media/embeds/cbemb_0123456789abcdef/content)').supported).toBe(false);
});
