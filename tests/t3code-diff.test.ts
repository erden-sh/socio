import { execFileSync } from 'node:child_process';

import { expect, it } from 'vitest';

// provider-acp turns an ACP tool call's `diff` content into one unified patch with jsdiff's
// structuredPatch and formatPatch (acpToolCallDiffPatch). These are its outputs on diff 9. On
// diff 8 every case was the same except the two quoted filenames: diff 9 quotes a name with
// non-ASCII or special characters and escapes it as C does, as GNU diff and git do; diff 8 wrote
// it raw. The vendored source runs under tsx, as the session host runs it (Vite can't transform
// it: its tsconfig extends a base that isn't vendored).

const many = (seed: number) => `${Array.from({ length: 3000 }, (_, i) => `${(i * seed) % 7}`).join('\n')}\n`;
const edit = (path: string) => [{ type: 'diff', path, oldText: 'a\n', newText: 'b\n' }];

const CASES: ReadonlyArray<readonly [string, unknown, string | null]> = [
    [
        'an edit, with three lines of context',
        [
            {
                type: 'diff',
                path: 'src/app.ts',
                oldText: 'a\nb\nc\nd\ne\nf\ng\nh\n',
                newText: 'a\nb\nc\nD\ne\nf\ng\nh\n',
            },
        ],
        '--- src/app.ts\n+++ src/app.ts\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n',
    ],
    [
        'a new file',
        [{ type: 'diff', path: 'src/new.ts', newText: 'export const x = 1;\n' }],
        '--- /dev/null\n+++ src/new.ts\n@@ -0,0 +1,1 @@\n+export const x = 1;\n',
    ],
    [
        'a file emptied',
        [{ type: 'diff', path: 'notes.md', oldText: 'one\ntwo\n', newText: '' }],
        '--- notes.md\n+++ notes.md\n@@ -1,2 +0,0 @@\n-one\n-two\n',
    ],
    [
        'no newline at end of file',
        [{ type: 'diff', path: 'a.txt', oldText: 'x', newText: 'y' }],
        '--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n',
    ],
    [
        'two files',
        [
            { type: 'diff', path: 'one.txt', oldText: '1\n', newText: '2\n' },
            { type: 'diff', path: 'two.txt', oldText: '3\n', newText: '4\n' },
        ],
        '--- one.txt\n+++ one.txt\n@@ -1,1 +1,1 @@\n-1\n+2\n\n--- two.txt\n+++ two.txt\n@@ -1,1 +1,1 @@\n-3\n+4\n',
    ],
    ['no change', [{ type: 'diff', path: 'same.txt', oldText: 's\n', newText: 's\n' }], null],
    [
        'a space in the name',
        edit('docs/my file.md'),
        '--- docs/my file.md\n+++ docs/my file.md\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    ],
    [
        'a non-ASCII name',
        edit('docs/café.md'),
        '--- "docs/caf\\303\\251.md"\n+++ "docs/caf\\303\\251.md"\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    ],
    [
        'a quote, a backslash and a tab in the name',
        edit('we"ird\\na\tme.txt'),
        '--- "we\\"ird\\\\na\\tme.txt"\n+++ "we\\"ird\\\\na\\tme.txt"\n@@ -1,1 +1,1 @@\n-a\n+b\n',
    ],
    [
        'a git patch, passed through',
        [
            {
                type: 'diff',
                patch: { format: 'git_patch', text: '@@ -1 +1 @@\n-a\n+b\n' },
                changes: [{ path: 'x.txt', operation: 'modify' }],
            },
        ],
        'diff --git "a/x.txt" "b/x.txt"\n--- "a/x.txt"\n+++ "b/x.txt"\n@@ -1 +1 @@\n-a\n+b\n',
    ],
    [
        'more edits than the search allows',
        [{ type: 'diff', path: 'big.txt', oldText: many(3), newText: many(5) }],
        null,
    ],
];

const PROBE = `
import { readFileSync } from 'node:fs';
import { acpToolCallDiffPatch } from '@t3tools/provider-acp/server/adapter';
const contents = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(contents.map((content) => acpToolCallDiffPatch(content) ?? null)));
`;

it('formats ACP tool call diffs as unified patches', () => {
    const output = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
        cwd: process.cwd(),
        input: JSON.stringify(CASES.map(([, content]) => content)),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    const results = JSON.parse(output) as Array<string | null>;
    expect(Object.fromEntries(CASES.map(([name], i) => [name, results[i]]))).toEqual(
        Object.fromEntries(CASES.map(([name, , expected]) => [name, expected])),
    );
});
