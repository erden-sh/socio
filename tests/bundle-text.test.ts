import { describe, expect, it } from 'vitest';

import { embedToken } from '@socio/shared/embed-card';
import { pageImageToken } from '@socio/shared/page-image';

import { denyList, originOf, parseIdList, parseIssueList } from '../src/server/bundle/selection.js';
import {
    codeRanges,
    embedIdsIn,
    fencedBlocks,
    rewriteText,
    sensitiveHits,
    type RewriteContext,
} from '../src/server/bundle/text.js';

const ORIGIN = 'https://source.example.test';
const context: RewriteContext = {
    origin: ORIGIN,
    label: 'SRC',
    prefix: 'CB',
    issue: (n) => ([1, 2, 364].includes(n) ? n : undefined),
    page: (spaceId, pageId) =>
        spaceId === 'sp-a' && pageId === 'pg-1'
            ? { spaceId: 'sp-a', pageId }
            : spaceId === 'sp-b' && pageId === 'pg-2'
              ? { spaceId: 'sp-target', pageId }
              : undefined,
    space: (id) => (id === 'sp-a' ? 'sp-a' : undefined),
};
const rewrite = (text: string) => rewriteText(text, context).text;

describe('rewriteText', () => {
    it('keeps mentions of copied issues as they are', () => {
        expect(rewrite('See CB-1 and CB-364.')).toBe('See CB-1 and CB-364.');
    });

    it('points mentions of issues that were not copied at the source, labeled', () => {
        expect(rewrite('Blocked on CB-9.')).toBe(`Blocked on [CB-9 (SRC)](${ORIGIN}/issues/CB-9).`);
    });

    it('rewrites issue links: copied ones relative, others absolute', () => {
        expect(rewrite(`[one](${ORIGIN}/issues/CB-1) and [nine](/issues/CB-9)`)).toBe(
            `[one](/issues/CB-1) and [nine](${ORIGIN}/issues/CB-9)`,
        );
        expect(rewrite(`Open ${ORIGIN}/issues/CB-2 or /issues/CB-9 now`)).toBe(
            `Open /issues/CB-2 or ${ORIGIN}/issues/CB-9 now`,
        );
    });

    it('labels a mention inside link text without nesting a link', () => {
        expect(rewrite('[CB-9](/issues/CB-9)')).toBe(`[CB-9 (SRC)](${ORIGIN}/issues/CB-9)`);
        expect(rewrite('[see CB-9](https://github.com/x/y)')).toBe('[see CB-9 (SRC)](https://github.com/x/y)');
    });

    it('rewrites page and Space links by where they went', () => {
        expect(rewrite(`[a](${ORIGIN}/spaces/sp-a/pages/pg-1)`)).toBe('[a](/spaces/sp-a/pages/pg-1)');
        expect(rewrite('[b](/spaces/sp-b/pages/pg-2)')).toBe('[b](/spaces/sp-target/pages/pg-2)');
        expect(rewrite('[c](/spaces/sp-b/pages/pg-gone)')).toBe(`[c](${ORIGIN}/spaces/sp-b/pages/pg-gone)`);
        expect(rewrite('[s](/spaces/sp-a) [t](/spaces/sp-b)')).toBe(`[s](/spaces/sp-a) [t](${ORIGIN}/spaces/sp-b)`);
    });

    it('leaves fenced code, inline code and indented fences alone', () => {
        const text = [
            'Mention CB-9 here.',
            '```ts',
            'const key = "CB-9"; // /issues/CB-9',
            '```',
            'Inline `CB-9` and ``a ` CB-9`` stay.',
            '> ~~~',
            '> CB-9 in a quoted fence',
            '> ~~~',
            '- item',
            '    ```',
            '    CB-9 in a list fence',
            '    ```',
            'After CB-9.',
        ].join('\n');
        const out = rewrite(text);
        const linked = `[CB-9 (SRC)](${ORIGIN}/issues/CB-9)`;
        expect(out.split('\n')).toEqual([
            `Mention ${linked} here.`,
            '```ts',
            'const key = "CB-9"; // /issues/CB-9',
            '```',
            'Inline `CB-9` and ``a ` CB-9`` stay.',
            '> ~~~',
            '> CB-9 in a quoted fence',
            '> ~~~',
            '- item',
            '    ```',
            '    CB-9 in a list fence',
            '    ```',
            `After ${linked}.`,
        ]);
    });

    it('finds fences that open list items, unordered and ordered', () => {
        const linked = `[CB-3 (SRC)](${ORIGIN}/issues/CB-3)`;
        const ctx = { ...context, issue: () => undefined };
        const out = (text: string) => rewriteText(text, ctx).text;
        expect(out('- ```sh\n  echo CB-3\n  ```\n\nCB-3')).toBe(`- \`\`\`sh\n  echo CB-3\n  \`\`\`\n\n${linked}`);
        expect(out('12. ~~~\n    CB-3\n    ~~~\nCB-3')).toBe(`12. ~~~\n    CB-3\n    ~~~\n${linked}`);
        expect(out('* ```\nCB-3\n```\n- CB-3')).toBe(`* \`\`\`\nCB-3\n\`\`\`\n- ${linked}`);
        // A dash with no space is not a list marker: only the last line opens a fence.
        expect(fencedBlocks('-```\nx\n```').map((b) => b.start)).toEqual([7]);
    });

    it('leaves #n shorthand alone (often a GitHub PR number), while CB-n is still rewritten', () => {
        const text = 'Fixed by #524 and #141415, see #9 and CB-9; [see #9](https://x.test) [#1](/issues/CB-9)';
        const result = rewriteText(text, context);
        expect(result.text).toBe(
            `Fixed by #524 and #141415, see #9 and [CB-9 (SRC)](${ORIGIN}/issues/CB-9); [see #9](https://x.test) [#1](${ORIGIN}/issues/CB-9)`,
        );
        expect(result.changes.map((c) => c.before)).toEqual(['CB-9', '[#1](/issues/CB-9)']);
    });

    it('treats an unclosed fence as code to the end', () => {
        expect(rewrite('CB-9\n```\nCB-9')).toBe(`[CB-9 (SRC)](${ORIGIN}/issues/CB-9)\n\`\`\`\nCB-9`);
    });

    it('treats an unmatched backtick as text, and never spans a blank line', () => {
        expect(rewrite('a ` CB-9')).toBe(`a \` [CB-9 (SRC)](${ORIGIN}/issues/CB-9)`);
        expect(rewrite('`a\n\nCB-9 b`')).toBe(`\`a\n\n[CB-9 (SRC)](${ORIGIN}/issues/CB-9) b\``);
    });

    it('does not touch look-alikes: other prefixes, #n, ids inside words, URLs or query strings', () => {
        const text = 'ABCB-9, CB-9x, #9, see https://other.test/CB-9 and ?q=CB-9, file CB-9.md';
        // Only the last one is a mention: "CB-9" followed by ".md" is still CB-9.
        expect(rewrite(text)).toBe(
            `ABCB-9, CB-9x, #9, see https://other.test/CB-9 and ?q=CB-9, file [CB-9 (SRC)](${ORIGIN}/issues/CB-9).md`,
        );
    });

    it('does not label a mention twice', () => {
        expect(rewrite('CB-9 (SRC)')).toBe('CB-9 (SRC)');
        const once = rewrite('CB-9');
        expect(rewrite(once)).toBe(once);
    });

    it('lists each change for the dry run', () => {
        expect(rewriteText('CB-1 CB-9', context).changes).toEqual([
            { before: 'CB-9', after: `[CB-9 (SRC)](${ORIGIN}/issues/CB-9)` },
        ]);
    });

    it('stays linear on many inline code spans in one paragraph', () => {
        const text = '`x` CB-9 '.repeat(50_000);
        const started = performance.now();
        const out = rewrite(text);
        expect(performance.now() - started).toBeLessThan(3_000);
        expect(out.startsWith(`\`x\` [CB-9 (SRC)](${ORIGIN}/issues/CB-9)`)).toBe(true);
    });

    it('stays linear on long indents', () => {
        const text = `${' '.repeat(200_000)}x CB-9\n${'\t'.repeat(200_000)}y`;
        const started = performance.now();
        rewrite(text);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    it('stays linear on hostile input', () => {
        const hostile = `${'['.repeat(20_000)}${'`'.repeat(20_000)}${'CB-1 '.repeat(20_000)}`;
        const started = performance.now();
        rewrite(hostile);
        expect(performance.now() - started).toBeLessThan(5_000);
    });
});

describe('fences and code', () => {
    it('finds fences with their info and body, quoted ones unquoted', () => {
        const blocks = fencedBlocks('x\n```image\n{"id":"a"}\n```\n> ```embed\n> {"b":1}\n> ```\n');
        expect(blocks.map((b) => [b.info, b.body])).toEqual([
            ['image', '{"id":"a"}'],
            ['embed', '{"b":1}'],
        ]);
    });

    it('closes a fence only with the same character, at least as long', () => {
        const text = '````\n```\n~~~\n````\nafter';
        expect(fencedBlocks(text)).toHaveLength(1);
        expect(codeRanges(text)).toEqual([[0, text.indexOf('\nafter')]]);
    });

    it('finds page pictures, link card media and written embed URLs', () => {
        const content = [
            '```image',
            '{"id":"cbemb_one_0123456789","alt":"x"}',
            '```',
            '```embed',
            JSON.stringify({
                url: 'https://e.test',
                kind: 'link',
                title: 'E',
                media: [{ id: 'cbemb_two_0123456789', kind: 'image' }],
                fetchedAt: '2026-11-01T00:00:00.000Z',
            }),
            '```',
            '![x](/api/media/embeds/cbemb_three_0123456789/content)',
            '```',
            '{"id":"cbemb_code_0123456789"}',
            '```',
        ].join('\n');
        expect(embedIdsIn(content, { image: pageImageToken, card: embedToken })).toEqual([
            'cbemb_one_0123456789',
            'cbemb_two_0123456789',
            'cbemb_three_0123456789',
        ]);
    });
});

describe('sensitive details', () => {
    it('lists paths, Portainer ids, internal hosts, private addresses, emails and terms', () => {
        const hits = sensitiveHits(
            'Logs in /home/someone/app/logs, Portainer stack 42, endpoint id 3, host nas.lan, 192.168.1.20, a@b.example, BIGBOX',
            ['bigbox'],
        );
        expect(hits.map((h) => h.kind).sort()).toEqual(
            ['address', 'email', 'host', 'path', 'portainer', 'portainer', 'term'].sort(),
        );
    });
});

describe('selection', () => {
    it('parses issue lists, ranges, keys and files', () => {
        expect(parseIssueList('3, 1-2,CB-7,CB-5-CB-6')).toEqual([1, 2, 3, 5, 6, 7]);
        expect(parseIssueList('all')).toBe('all');
        expect(parseIssueList('@list', () => '# picked\n9\n10 # yes\n')).toEqual([9, 10]);
        expect(() => parseIssueList('nine')).toThrow('Not an issue number');
        expect(() => parseIssueList('5-1')).toThrow('Not a usable range');
    });

    it('parses id lists and refuses odd ids', () => {
        expect(parseIdList(['a,b', 'b', '@f'], () => 'c\n')).toEqual(['a', 'b', 'c']);
        expect(() => parseIdList(['../etc'])).toThrow('Not an id');
    });

    it('requires a deny-list, or an explicit --no-deny-list', () => {
        expect(() => denyList([], undefined, false)).toThrow('never read');
        expect([...denyList(['s1'], 's2,s3', false)].sort()).toEqual(['s1', 's2', 's3']);
        expect(denyList([], undefined, true).size).toBe(0);
        expect(() => denyList(['s1'], undefined, true)).toThrow('one or the other');
    });

    it('takes the origin from a URL or APP_ORIGIN', () => {
        expect(originOf('https://a.example.test/x, https://b.test')).toBe('https://a.example.test');
        expect(() => originOf(undefined)).toThrow('origin');
        expect(() => originOf('ftp://x')).toThrow('http');
    });
});
