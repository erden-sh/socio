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
    tagStructure,
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

    it("compares a URL's scheme and host without case, and the rest with it", () => {
        expect(added('See https://example.com/Team?token=AbC', 'Mira HTTPS://Example.COM/Team?token=AbC')).toEqual([]);
        expect(added('See https://example.com/Team?token=AbC', 'Mira https://example.com/team?token=abc')).toEqual([
            'url:https://example.com/team?token=abc',
        ]);
        expect(added('See www.example.com/Docs', 'Mira WWW.Example.com/docs')).toEqual(['url:www.example.com/docs']);
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
    const ok = (source: string, translation: string) => expect(newMarkup(source, translation), translation).toEqual([]);
    const refused = (source: string, translation: string) =>
        expect(newMarkup(source, translation).length, translation).toBeGreaterThan(0);

    it("allows exactly the source's <Trans> tags, siblings in any order", () => {
        ok('Read <0>the guide</0> and <1/>', 'Lee <1/> y <0>la guía</0>');
        ok('Read <bold>this</bold>', 'Lee <bold>esto</bold>');
        ok('Read <0>the <1>whole</1> guide</0>', 'Lee <0>la guía <1>entera</1></0>');
        ok('a < b', 'a < b');
    });

    it('refuses any attribute, on numeric and named tags alike', () => {
        for (const translation of [
            'Lee <0 href="/logout">la guía</0>',
            "Lee <0 href='/logout'>la guía</0>",
            'Lee <0 href=/logout>la guía</0>',
            'Lee <0 onclick="steal()">la guía</0>',
            'Lee <0 style="display:none">la guía</0>',
            'Lee <0 >la guía</0>',
            'Lee <0>la guía</0 >',
            'Lee < 0>la guía</0>',
        ]) {
            refused('Read <0>the guide</0>', translation);
        }
        refused('Read <bold>this</bold>', 'Lee <bold class="x">esto</bold>');
        refused('Read <bold>this</bold>', 'Lee <bold onclick=x>esto</bold>');
        refused('Read <1/>', 'Lee <1 href="/logout"/>');
        expect(newMarkup('Read <0>the guide</0>', 'Lee <0 href="/logout">la guía</0>')).toContain(
            'markup "<0 href=\\"/logout\\">" is not allowed: a tag holds only its name, as in <0> or <0/>',
        );
    });

    it('refuses extra, missing, renamed and renested tags, and self-closing for paired', () => {
        refused('Read <0>the guide</0>', 'Lee <1>la guía</1>');
        refused('Read <0>the guide</0>', 'Lee <0>la</0> <0>guía</0>');
        refused('Read <0>the guide</0>', 'Lee <0>la guía</0><1/>');
        refused('Read <0>the guide</0>', 'Lee la guía');
        refused('Read <0>the guide</0> and <1/>', 'Lee <0>la guía</0>');
        refused('Read <0>the <1>whole</1> guide</0>', 'Lee <0>la guía</0> <1>entera</1>');
        refused('Read <0>the guide</0> and <1>more</1>', 'Lee <0>la guía y <1>más</1></0>');
        refused('Read <0>the guide</0>', 'Lee <0/>la guía');
        refused('Read <0/>', 'Lee <0></0>');
        refused('Read <0>the guide</0>', 'Lee <0>la guía');
        refused('Read <0>the guide</0>', 'Lee </0>la guía<0>');
        expect(newMarkup('Read <0>the guide</0>', 'Lee <1>la guía</1>')).toEqual([
            'tags "<1></1>" don\'t match the en-US source\'s "<0></0>"',
        ]);
    });

    it('refuses other markup, entities, look-alike brackets and invisible characters', () => {
        refused('Read', 'Lee <a href="https://example.org">aquí</a>');
        refused('Read', 'Lee <img src=x onerror=alert(1)>');
        refused('Read', 'Lee <!-- nota -->');
        refused('Settings', 'Ajustes > Idioma');
        expect(newMarkup('Read', 'Lee &lt;b&gt;')).toEqual([
            'entity &lt; is not in the en-US source',
            'entity &gt; is not in the en-US source',
        ]);
        expect(newMarkup('Read', 'Lee ＜b＞esto＜/b＞')).toEqual([
            'look-alike bracket "＜" is not in the en-US source',
            'look-alike bracket "＞" is not in the en-US source',
        ]);
        expect(newMarkup('Read', 'Lee ﹤b﹥')).toHaveLength(2);
        // Look-alikes aren't tags to <Trans>: they can't stand in for the source's.
        refused('Read <0>the guide</0>', 'Lee ＜0＞la guía＜/0＞');
        expect(newMarkup('Read', 'Lee\u202eesto')).toEqual(['invisible character U+202E is not in the en-US source']);
        expect(newMarkup('Read', 'Lee\u200besto')).toEqual(['invisible character U+200B is not in the en-US source']);
    });

    it('reads the structure of a text', () => {
        expect(tagStructure('<1/> y <0>la <2>guía</2></0>')).toEqual({
            canonical: '0(2()),1/',
            sequence: '<1/><0><2></2></0>',
            stray: [],
        });
        expect(tagStructure('<0 href="x">a</0>').stray).toEqual(['<0 href="x">']);
        expect(tagStructure('a < b > c').stray).toEqual(['<', '>']);
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

    it("holds each plural form's tags to its own source form, and a form en-US lacks to _other", () => {
        const dir = setup({
            'en-US/common.json': {
                files_one: 'One <0>file</0>',
                files_other: '{{count}} <0>files</0> in <1/>',
                edited_socio: 'Edited by <0>a socio</0>',
            },
            'es-419/common.json': {
                // The _one form may not borrow _other's <1/>.
                files_one: 'Un <0>archivo</0> en <1/>',
                files_many: '{{count}} de <0>archivos</0> en <1/>',
                files_other: '{{count}} <0>archivos</0>',
                edited_socio: 'Editado por <0 href="/x">un socio</0>',
            },
        });
        expect(checkLocales(dir)).toEqual([
            'es-419/common.json: files_one: tags "<0></0><1/>" don\'t match the en-US source\'s "<0></0>"',
            'es-419/common.json: files_other: tags "<0></0>" don\'t match the en-US source\'s "<0></0><1/>"',
            'es-419/common.json: edited_socio: markup "<0 href=\\"/x\\">" is not allowed: a tag holds only its name, as in <0> or <0/>',
            'es-419/common.json: edited_socio: tags "</0>" don\'t match the en-US source\'s "<0></0>"',
        ]);
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
