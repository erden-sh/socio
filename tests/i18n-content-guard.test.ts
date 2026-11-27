import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    checkLocales,
    contentItems,
    newContent,
    newMarkup,
    translationProblems,
} from '../scripts/i18n-content-guard.mjs';

// scripts/i18n-content-guard.mjs (docs/I18N.md): a translation adds no URL, domain, email,
// phone number or markup its en-US source doesn't have.
const root = join(import.meta.dirname, '..');
const added = (source: string, translation: string) =>
    newContent(source, translation).map((item) => `${item.kind}:${item.text}`);

describe('content', () => {
    it('finds what a translation adds', () => {
        expect(added('Read the guide', 'Lee la guía en https://example.org/x')).toEqual(['url:https://example.org/x']);
        expect(added('Read the guide', 'Lee la guía en www.example.org')).toEqual(['url:www.example.org']);
        expect(added('Read the guide', 'Visita example.org.')).toEqual(['domain:example.org']);
        expect(added('Write to us', 'Escribe a ada@example.org')).toEqual(['email:ada@example.org']);
        expect(added('Call us', 'Llama al +1 (555) 010-0199')).toEqual(['phone:+1 (555) 010-0199']);
        expect(added('Call us', 'Llama al 912 345 678')).toEqual(['phone:912 345 678']);
        expect(added('Open', 'Abre mailto:ada@example.org')).toEqual(['url:mailto:ada@example.org']);
        expect(added('Open', 'Abre javascript:alert(1)')).toEqual(['url:javascript:alert(1']);
        expect(added('Server', 'Servidor 192.0.2.10')).toEqual(['domain:192.0.2.10']);
    });

    it('lets through what the source has, however the translation writes it', () => {
        expect(added('Go to socio.sh', 'Ve a Socio.sh.')).toEqual([]);
        expect(added('See https://socio.sh/docs', 'Mira https://socio.sh/docs, o socio.sh')).toEqual([]);
        expect(added('Write to help@example.com', 'Escribe a help@example.com o visita example.com')).toEqual([]);
        expect(added('Call 555-010-0199', 'Llama al (555) 010 0199')).toEqual([]);
        expect(added('Up to 1,000,000 rows', 'Hasta 1 000 000 filas')).toEqual([]);
    });

    it('reads full-width characters as their ASCII forms', () => {
        expect(added('Visit', 'Visita ｅｘａｍｐｌｅ．ｏｒｇ')).toEqual(['domain:example.org']);
        expect(added('Write', 'Escribe a ａｄａ＠ｅｘａｍｐｌｅ．ｏｒｇ')).toEqual(['email:ada@example.org']);
        expect(added('Visit', 'Visita ｈｔｔｐｓ：／／example.org')).toEqual(['url:https://example.org']);
        expect(added('Call', 'Llama al ＋３４ ９１２ ３４５ ６７８')).toEqual(['phone:+34 912 345 678']);
        // Ideographic full stops are dots in a host name.
        expect(added('Visit', 'Visita example。org')).toEqual(['domain:example.org']);
    });

    it('sees through look-alike and punycode domains', () => {
        // A Cyrillic а in place of a Latin a is another domain than the source's.
        expect(added('Visit example.com', 'Visita exаmple.com')).toEqual(['domain:xn--exmple-4nf.com']);
        expect(added('Visit example.com', 'Visita xn--exmple-4nf.com')).toEqual(['domain:xn--exmple-4nf.com']);
        expect(added('Visit', 'Visita пример.рф')).toEqual(['domain:xn--e1afmkfd.xn--p1ai']);
        expect(added('Visit', 'Visita xn--e1afmkfd.xn--p1ai')).toEqual(['domain:xn--e1afmkfd.xn--p1ai']);
        // Written in Unicode where the source has punycode, it is the same domain.
        expect(added('Visit xn--e1afmkfd.xn--p1ai', 'Visita пример.рф')).toEqual([]);
        // A zero-width space hides nothing.
        expect(added('Visit', 'Visita exa\u200bmple.org')).toEqual(['domain:example.org']);
    });

    it('undoes defanged URLs, domains and emails', () => {
        expect(added('Visit', 'hxxp://example[.]org/x')).toEqual(['url:http://example.org/x']);
        expect(added('Visit', 'hXXps[:]//example.org')).toEqual(['url:https://example.org']);
        expect(added('Visit', 'Visita example(dot)org')).toEqual(['domain:example.org']);
        expect(added('Visit', 'Visita example [.] org')).toEqual(['domain:example.org']);
        expect(added('Write', 'ada (at) example (dot) org')).toEqual(['email:ada@example.org']);
        expect(added('Write', 'ada[@]example.org')).toEqual(['email:ada@example.org']);
    });

    it('takes numbers that are not phone numbers for what they are', () => {
        for (const text of [
            'Hasta 1.000.000 filas',
            'Hasta 1,000,000 filas',
            'Pi es 3,14159265',
            'El 2026-11-26 a las 10:30',
            'El 26/11/2026',
            'Versión 0.55.0',
            'De 100 a 200 elementos',
            'Código 123456',
        ]) {
            expect(added('Rows', text), text).toEqual([]);
        }
        expect(contentItems('1234567')).toEqual([{ kind: 'phone', text: '1234567' }]);
        // Grouped with spaces, a number looks like a phone number (912 345 678): it passes only
        // when the source has the same digits.
        expect(added('Rows', 'Hasta 1\u202f000\u202f000 filas')).toEqual(['phone:1 000 000']);
        expect(added('Up to 1,000,000 rows', 'Hasta 1\u202f000\u202f000 filas')).toEqual([]);
    });

    it('takes abbreviations and file-like words for words', () => {
        for (const text of ['EE.UU. y p.ej. el Sr.García', 'Configuración.Idioma, etc.', 'a.m. o p.m.', 'i.e. e.g.']) {
            expect(added('Text', text), text).toEqual([]);
        }
        // But a word ending in a real top-level domain is a domain.
        expect(added('Text', 'el archivo.zip')).toEqual(['domain:archivo.zip']);
    });

    it('ignores variables and nesting', () => {
        expect(added('Hello {{name}}', 'Hola {{name}}, $t(common:product)')).toEqual([]);
        expect(added('{{count}} rows', '{{count, number}} filas')).toEqual([]);
    });
});

describe('markup', () => {
    it("allows the source's <Trans> tags, in any order", () => {
        expect(newMarkup('Read <0>the guide</0> and <1/>', 'Lee <1/> y <0>la guía</0>')).toEqual([]);
        expect(newMarkup('Read <bold>this</bold>', 'Lee <bold>esto</bold>')).toEqual([]);
        expect(newMarkup('Read <0>the guide</0>', 'Lee la guía')).toEqual([]);
    });

    it('refuses any other tag, markup, entity or invisible character', () => {
        expect(newMarkup('Read <0>the guide</0>', 'Lee <1>la guía</1>')).toEqual(['tag <1>', 'tag </1>']);
        expect(newMarkup('Read <0>the guide</0>', 'Lee <0>la</0> <0>guía</0>')).toEqual(['tag <0>', 'tag </0>']);
        expect(newMarkup('Read', 'Lee <a href="https://example.org">aquí</a>')).toContain(
            'markup "<a href=\\"https://example.org\\">"',
        );
        expect(newMarkup('Read', 'Lee <img src=x onerror=alert(1)>')).toHaveLength(1);
        expect(newMarkup('Read', 'Lee <!-- nota -->')).toHaveLength(1);
        expect(newMarkup('Read', 'Lee ＜b＞esto＜/b＞')).toEqual(['tag <b>', 'tag </b>']);
        expect(newMarkup('Read', 'Lee &lt;b&gt;')).toEqual(['entity &lt;', 'entity &gt;']);
        expect(newMarkup('Read', 'Lee\u202eesto')).toEqual(['invisible character U+202E']);
        expect(newMarkup('Read', 'Lee\u200besto')).toEqual(['invisible character U+200B']);
    });

    it('lets comparisons and arrows be text', () => {
        expect(newMarkup('a < b', 'a < b')).toEqual([]);
        expect(newMarkup('Settings', 'Ajustes > Idioma <3')).toEqual([]);
    });
});

describe('the locales folder', () => {
    const scratch: string[] = [];
    afterEach(() => {
        for (const dir of scratch.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    function setup(files: Record<string, unknown>) {
        const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-guard-'));
        scratch.push(dir);
        for (const [path, json] of Object.entries(files)) {
            mkdirSync(join(dir, path, '..'), { recursive: true });
            writeFileSync(join(dir, path), typeof json === 'string' ? json : JSON.stringify(json));
        }
        return dir;
    }

    it('checks every translation against its en-US string, plural forms against all the forms', () => {
        const dir = setup({
            'en-US/common.json': {
                help: 'See socio.sh',
                nested: { link: 'Read <0>more</0>' },
                files_one: 'One file',
                files_other: '{{count}} files',
            },
            'es-419/common.json': {
                help: 'Mira socio.sh',
                nested: { link: 'Lee <0>más</0> en example.org' },
                files_many: '{{count}} archivos en evil.example.com',
            },
            'es-US/common.json': { help: 'Llama al 555 010 0199' },
            // A key en-US doesn't have, and a file that isn't JSON, are the build's to report.
            'pt-BR/common.json': { unknown: 'https://example.org' },
            'pt-BR/broken.json': '{',
        });
        expect(checkLocales(dir)).toEqual([
            'es-419/common.json: nested.link: domain "example.org" is not in the en-US source',
            'es-419/common.json: files_many: domain "evil.example.com" is not in the en-US source',
            'es-US/common.json: help: phone "555 010 0199" is not in the en-US source',
        ]);
        expect(translationProblems('See socio.sh', 'Mira socio.sh')).toEqual([]);
    });

    it('runs with nothing installed, and fails with the problems', () => {
        const clean = setup({ 'en-US/common.json': { a: 'Hello' }, 'es-419/common.json': { a: 'Hola' } });
        const ok = spawnSync(process.execPath, ['scripts/i18n-content-guard.mjs', '--locales', clean], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(ok.status, ok.stderr).toBe(0);
        const bad = setup({
            'en-US/common.json': { a: 'Hello' },
            'es-419/common.json': { a: 'Hola, visita example.org' },
        });
        const failed = spawnSync(process.execPath, ['scripts/i18n-content-guard.mjs', '--locales', bad], {
            cwd: root,
            encoding: 'utf8',
        });
        expect(failed.status).toBe(1);
        expect(failed.stderr).toContain('es-419/common.json: a: domain "example.org" is not in the en-US source');
    });

    it("passes the repository's own translations", () => {
        expect(checkLocales(join(root, 'packages/i18n/locales'))).toEqual([]);
    });
});
