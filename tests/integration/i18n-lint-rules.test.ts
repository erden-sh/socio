import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The client's i18n lint rules (scripts/lint/socio-rules.mjs), run by the
// root's oxlint with the real .oxlintrc.json on files placed where its
// overrides look, in a scratch copy:
// - socio/no-literal-text, only in the folders its override lists (the
//   ratchet: Settings › Language first);
// - socio/translate-in-components, in all of packages/client/src.

const root = join(import.meta.dirname, '../..');
const LANGUAGE = 'packages/client/src/modules/settings/language';

const FILES: Record<string, string> = {
    [`${LANGUAGE}/Literal.tsx`]: [
        'export const A = () => <p>Hello there</p>;',
        'export const B = () => <img alt="A photo" src=\'x\' />;',
        "export const C = () => <input placeholder={'Search'} aria-label={`Find`} />;",
        'export const D = () => <p title="Help">{\'Words\'}</p>;',
        '',
    ].join('\n'),
    [`${LANGUAGE}/Fine.tsx`]: [
        "import { useTranslation } from 'react-i18next';",
        '',
        'export function Fine({ n }: { n: number }) {',
        '    const { t } = useTranslation();',
        "    return <p title={t('title')} data-slot=\"x\" className=\"mt-1\">{t('body')} {n} · 12 — {'·'}</p>;",
        '}',
        '',
    ].join('\n'),
    // Outside the ratchet's folders: literal text is still allowed.
    'packages/client/src/modules/media/Literal.tsx': 'export const A = () => <p title="Help">Hello there</p>;\n',
    'packages/client/src/modules/chat/translate.tsx': [
        "import i18n from 'i18next';",
        "import { useTranslation } from 'react-i18next';",
        '',
        "export const LABEL = i18n.t('label');",
        "export const fixed = i18n.getFixedT('es-419');",
        "const helper = (t: (key: string) => string) => t('helper');",
        'export function Panel() {',
        '    const { t } = useTranslation();',
        "    const onClick = () => t('click');",
        "    return <button onClick={onClick}>{t('label')}{helper(t)}</button>;",
        '}',
        'export function useTitle() {',
        '    const { t } = useTranslation();',
        "    return t('title');",
        '}',
        'export const Memo = memo(function () {',
        '    const { t } = useTranslation();',
        "    return t('x');",
        '});',
        'declare function memo<T>(value: T): T;',
        '',
    ].join('\n'),
};

interface Diagnostic {
    code: string;
    message: string;
    filename: string;
    labels?: { span: { line: number } }[];
}

let findings: Map<string, string[]>;
const scratch = mkdtempSync(join(tmpdir(), 'socio-i18n-lint-'));

beforeAll(() => {
    for (const path of ['.oxlintrc.json', 'scripts/lint/socio-rules.mjs']) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        copyFileSync(join(root, path), join(scratch, path));
    }
    for (const [path, text] of Object.entries(FILES)) {
        mkdirSync(dirname(join(scratch, path)), { recursive: true });
        writeFileSync(join(scratch, path), text);
    }
    const run = spawnSync(join(root, 'node_modules/.bin/oxlint'), ['-c', '.oxlintrc.json', '-f', 'json', 'packages'], {
        cwd: scratch,
        encoding: 'utf8',
        maxBuffer: 1e8,
    });
    expect(run.stdout, run.stderr).toMatch(/^\s*\{/);
    const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
    findings = new Map();
    for (const { code, message, filename, labels } of diagnostics) {
        const rule = /\((.+)\)$/.exec(code)?.[1] ?? code;
        if (rule === 'no-literal-text' || rule === 'translate-in-components') {
            findings.set(filename, [
                ...(findings.get(filename) ?? []),
                `${labels?.[0]?.span.line}: ${rule}: ${message}`,
            ]);
        }
    }
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const of = (path: string) => [...(findings.get(path) ?? [])].sort();

describe('socio/no-literal-text', () => {
    it('flags text and read attributes in a migrated folder', () => {
        expect(of(`${LANGUAGE}/Literal.tsx`)).toEqual([
            '1: no-literal-text: Translate this text: t() from useTranslation() (docs/I18N.md).',
            '2: no-literal-text: Translate alt: t() from useTranslation() (docs/I18N.md).',
            '3: no-literal-text: Translate aria-label: t() from useTranslation() (docs/I18N.md).',
            '3: no-literal-text: Translate placeholder: t() from useTranslation() (docs/I18N.md).',
            '4: no-literal-text: Translate this text: t() from useTranslation() (docs/I18N.md).',
            '4: no-literal-text: Translate title: t() from useTranslation() (docs/I18N.md).',
        ]);
    });

    it('leaves t(), numbers, punctuation and non-read attributes alone', () => {
        expect(of(`${LANGUAGE}/Fine.tsx`)).toEqual([]);
    });

    it('isn’t on outside the folders it lists', () => {
        expect(of('packages/client/src/modules/media/Literal.tsx')).toEqual([]);
    });

    it('covers all of Settings (Settings › Language first), and its list only grows', () => {
        const { overrides } = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8')) as {
            overrides: { files: string[]; rules: Record<string, unknown> }[];
        };
        const folders = overrides
            .filter((entry) => 'socio/no-literal-text' in entry.rules)
            .flatMap((entry) => entry.files);
        // What has moved to t(): Settings, Language included, the shell, chat, Rooms and Spaces.
        expect(folders).toContain('packages/client/src/modules/settings/**');
        expect(folders).toContain('packages/client/src/shell/**');
        expect(folders).toContain('packages/client/src/modules/chat/**');
        expect(folders).toContain('packages/client/src/modules/rooms/**');
        expect(folders).toContain('packages/client/src/modules/spaces/**');
        expect(folders).toContain('packages/client/src/modules/operations/**');
        expect(folders).toContain('packages/client/src/modules/schedules/**');
        expect(folders).toContain('packages/client/src/modules/runs/**');
        expect(folders).toContain('packages/client/src/modules/activity/**');
        expect(folders.some((glob) => `${LANGUAGE}/`.startsWith(glob.replace(/\*\*$/, '')))).toBe(true);
    });
});

describe('socio/translate-in-components', () => {
    it('flags an instance’s t, getFixedT, and t called outside a component or hook', () => {
        expect(of('packages/client/src/modules/chat/translate.tsx')).toEqual([
            '4: translate-in-components: Take t from useTranslation() in the component or hook instead of i18n.t (docs/I18N.md).',
            '5: translate-in-components: Take t from useTranslation() in the component or hook instead of i18n.getFixedT (docs/I18N.md).',
            '6: translate-in-components: Call t inside a component or hook, from useTranslation() (docs/I18N.md).',
        ]);
    });
});
