import { expect, it } from 'vitest';

import { findFences, textLines } from '@socio/shared/pages/fences';

// The fence reader the merge (`merge-lines.ts`) and a page move's picture
// copies share: lenient openers, strict closes.

it('finds each fence with its lines, info, prefix and body', () => {
    const text = 'a\n- ```image\n  {"id":"x"}\n  ```\n> ~~~ js\r\n> code\r\n> ~~~\r\nb';
    expect(textLines(text).join('')).toBe(text);
    expect(findFences(text)).toEqual([
        expect.objectContaining({
            open: 1,
            close: 3,
            info: 'image',
            fence: '```',
            prefix: '- ',
            body: ['  {"id":"x"}\n'],
        }),
        expect.objectContaining({ open: 4, close: 6, info: 'js', fence: '~~~', prefix: '> ', body: ['> code\r\n'] }),
    ]);
    expect(findFences(text)[0]!.at).toMatchObject({ quotes: 0, marker: true, column: 2, lead: 0 });
});

it('reads no fences inside a fence, and only accepted ones when asked', () => {
    const text = '~~~md\n```image\n{}\n```\n~~~\n```image\nopen to the end\n';
    expect(findFences(text).map((fence) => [fence.open, fence.close, fence.info])).toEqual([
        [0, 4, 'md'],
        [5, undefined, 'image'],
    ]);
    expect(findFences(text, (info) => info === 'image').map((fence) => [fence.open, fence.close])).toEqual([
        [1, 3],
        [5, undefined],
    ]);
});

it('closes only on a sure close: a doubtful one makes the fence longer', () => {
    // A close with a list marker, another quote depth or another column.
    for (const close of ['- ```', '> ```', '   ```']) {
        const text = `- \`\`\`image\n  {}\n${close}\nafter\n`;
        expect(findFences(text)[0]!.close, close).toBeUndefined();
    }
});
