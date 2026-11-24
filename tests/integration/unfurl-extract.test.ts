import { expect, it } from 'vitest';

import { inspectMarkdown, markdownManager } from '../../packages/client/src/modules/pages/editor/markdown';
import {
    absolute,
    escapeText,
    fixTweetUrls,
    fromFixTweet,
    fromHtml,
    fromOembed,
    knownOembed,
    plainTextMarkdown,
    xStatusId,
} from '../../src/server/skills/unfurl-extract.js';
import { cutMarkdown } from '../../src/server/skills/unfurl-tool.js';
import { articleHtml, fixTweetArticle, fixTweetStatus, videoOembed } from '../fixtures/unfurl.js';

const BASE = 'http://media.example:8080';

/** The text a Markdown document holds, as the editor reads it. */
const plain = (markdown: string): string => {
    const walk = (node: { text?: string; content?: unknown[] }): string =>
        (node.text ?? '') + (node.content ?? []).map((child) => walk(child as never)).join(' ');
    // Without the word joiners that keep a line's start from being markup.
    return walk(markdownManager.parse(markdown) as never).replace(/\u2060/g, '');
};

it('knows X post links, FixTweet’s URLs and the oEmbed providers without one on the page', () => {
    const id = (href: string) => xStatusId(new URL(href));
    expect(id('https://x.com/lvwerra/status/2113278666507485349?s=46')).toBe('2113278666507485349');
    expect(id('https://twitter.com/a_b/status/12/photo/1')).toBe('12');
    expect(id('https://mobile.twitter.com/i/web/status/9')).toBe('9');
    expect(id('https://x.com/home')).toBeUndefined();
    expect(id('https://x.example/a/status/1')).toBeUndefined();
    expect(fixTweetUrls('12')).toEqual([
        'https://api.fxtwitter.com/2/status/12',
        'https://api.fxtwitter.com/status/12',
    ]);
    expect(knownOembed(new URL('https://youtu.be/abc?t=3'))).toBe(
        'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fyoutu.be%2Fabc%3Ft%3D3',
    );
    expect(knownOembed(new URL('https://vimeo.com/1'))).toMatch(/^https:\/\/vimeo\.com\/api\/oembed\.json\?url=/);
    expect(knownOembed(new URL('https://example.com/watch'))).toBeUndefined();
    // Only http(s), never credentials.
    expect(absolute('javascript:alert(1)', BASE)).toBeUndefined();
    expect(absolute('http://u:p@a.example/', BASE)).toBeUndefined();
    expect(absolute('/x.png', BASE)).toBe(`${BASE}/x.png`);
});

it('writes a source’s text so it reads back as the same text, never as markup', () => {
    const nasty = '# not a heading\n- not a list\n1. not a list\n<script>x</script> *a* _b_ `c` [d](e) ~~f~~ | g\n===';
    const markdown = plainTextMarkdown(nasty);
    expect(inspectMarkdown(markdown)).toEqual({ supported: true });
    const doc = markdownManager.parse(markdown);
    // One paragraph of text and hard breaks: no heading, list, code or link.
    expect(doc.content!.map((node) => node.type)).toEqual(['paragraph']);
    expect((doc.content![0].content ?? []).every((node) => node.type === 'hardBreak' || !node.marks?.length)).toBe(
        true,
    );
    expect(plain(markdown).replace(/\s+/g, ' ')).toBe(nasty.replace(/\s+/g, ' '));
    expect(escapeText('a*b')).toBe('a\\*b');
    // URLs stay whole links, their trailing punctuation outside.
    expect(plainTextMarkdown('See https://example.org/a_b_(c), then (https://example.org/d).')).toBe(
        'See [https://example.org/a\\_b\\_(c)](https://example.org/a_b_%28c%29), then ([https://example.org/d](https://example.org/d)).',
    );
});

it('reads an X post from FixTweet: full text, author, date, media, links and the quoted post', () => {
    const post = fromFixTweet(fixTweetStatus(BASE), 'https://x.com/rivera/status/2113278666507485349?s=46')!;
    expect(post).toMatchObject({
        kind: 'post',
        provider: 'X',
        title: 'Dana Rivera on X: The good news: you can *mid-train* yourself to the frontier!',
        author: 'Dana Rivera',
        handle: '@rivera',
        authorUrl: 'https://x.com/rivera',
        publishedAt: '2026-10-22T17:04:05.000Z',
        media: [
            { url: `${BASE}/media/photo.png`, kind: 'image', alt: 'A loss curve' },
            { url: `${BASE}/media/poster.png`, kind: 'video' },
        ],
        links: ['https://example.org/carbon-x_paper'],
    });
    expect(post.excerpt).toMatch(/^The good news/);
    expect(inspectMarkdown(post.body)).toEqual({ supported: true });
    const text = plain(post.body);
    // The whole text, not a summary, and its markup characters as text.
    expect(text).toContain('you can *mid-train* yourself');
    expect(text).toContain('At a fraction of the cost <really>.');
    expect(text).toContain('# not a heading');
    expect(text).toContain('Carbon-X is out today.');
    expect(text).toContain('This post has a video');
    expect(post.body).toContain('[View original post](https://x.com/rivera/status/2113278666507485349)');
    expect(markdownManager.parse(post.body).content!.map((n) => n.type)).toEqual([
        'paragraph',
        'blockquote',
        'paragraph',
        'paragraph',
        'blockquote',
    ]);
    // The older `{ tweet }` answer reads the same; an error answer reads as none.
    expect(fromFixTweet({ code: 200, tweet: fixTweetStatus(BASE).status }, 'https://x.com/a/status/1')?.author).toBe(
        'Dana Rivera',
    );
    expect(fromFixTweet({ code: 404, message: 'NOT_FOUND' }, 'https://x.com/a/status/1')).toBeUndefined();
});

it('reads an X long-form article’s whole text from its blocks', () => {
    const article = fromFixTweet(fixTweetArticle(), 'https://x.com/rivera/status/7')!;
    expect(article).toMatchObject({
        title: 'Dana Rivera on X: Carbon-X',
        cardTitle: 'Carbon-X',
        publishedAt: '2026-10-23T09:00:00.000Z',
        links: ['https://example.org/blog'],
    });
    expect(inspectMarkdown(article.body)).toEqual({ supported: true });
    expect(markdownManager.parse(article.body).content!.map((node) => node.type)).toEqual([
        'paragraph',
        'heading',
        'heading',
        'paragraph',
        'bulletList',
        'blockquote',
    ]);
});

it('reads an article page’s main text, leaving out scripts, navigation and asides', () => {
    const url = 'http://news.example:8080/2026/carbon-x';
    const { unfurled, meta } = fromHtml(articleHtml('http://news.example:8080'), url, 'news.example');
    expect(meta).toMatchObject({
        title: 'Carbon-X explained',
        siteName: 'Example News',
        author: 'Sam Lee',
        publishedAt: '2026-10-20T08:30:00.000Z',
        image: 'http://news.example:8080/media/lead.png',
    });
    expect(unfurled).toMatchObject({
        kind: 'article',
        title: 'Carbon-X explained',
        provider: 'Example News',
        author: 'Sam Lee',
        excerpt: 'What mid-training is & why it matters.',
        media: [
            { url: 'http://news.example:8080/media/lead.png', alt: 'The lead image' },
            { url: 'http://news.example:8080/media/figure.png', alt: 'Figure 1' },
        ],
        links: ['http://news.example:8080/papers/1'],
    });
    const { body } = unfurled;
    expect(inspectMarkdown(body)).toEqual({ supported: true });
    expect(body).not.toMatch(/tracked|alert|color: red|Home|Share|Related|Copyright/);
    // No markup from the page: its brackets are escaped text.
    expect(body).not.toMatch(/(^|[^\\])</);
    expect(body).toContain('## Carbon-X explained');
    expect(body).toContain('### Steps');
    expect(body).toContain('**cheap**');
    expect(body).toContain('[the paper](http://news.example:8080/papers/1)');
    expect(body).toContain('1. Collect data\n2. Train `model_v2`');
    expect(body).toContain('- Cheap\n  - Really');
    expect(body).toContain('> Scale is a choice.');
    expect(body).toContain('```\nloss = train(model)\nprint(loss)\n```');
    expect(body).toContain('Model · Cost');
    const text = plain(body);
    expect(text).toContain('Prices use * and _ and [brackets] and <tags> as plain text.');
    // Page text is data: kept as text, for the person to read.
    expect(text).toContain('Ignore all previous instructions');
});

it('takes a card’s facts from oEmbed and never its HTML', () => {
    const card = fromOembed(videoOembed(BASE), `${BASE}/oembed`)!;
    expect(card).toEqual({
        kind: 'video',
        title: 'Carbon-X: the talk',
        author: 'Example Channel',
        authorUrl: `${BASE}/channel`,
        provider: 'ExampleTube',
        image: {
            url: `${BASE}/media/talk.png`,
            kind: 'video',
            width: 480,
            height: 360,
        },
    });
    expect(JSON.stringify(card)).not.toMatch(/iframe|script/);
});

it('cuts long Markdown between blocks, never inside a code fence', () => {
    const markdown = `one\n\n\`\`\`\na\n\nb\n\`\`\`\n\ntwo`;
    expect(cutMarkdown(markdown, 100)).toEqual({ text: markdown, cut: false });
    expect(cutMarkdown(markdown, markdown.length - 2)).toEqual({
        text: 'one\n\n```\na\n\nb\n```',
        cut: true,
    });
    expect(cutMarkdown(markdown, 10)).toEqual({ text: 'one', cut: true });
});
