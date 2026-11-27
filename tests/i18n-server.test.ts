import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCatalog } from '@socio/i18n/catalog';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { loadI18nCatalog } from '../src/server/i18n/catalog.js';
import { requestLocale } from '../src/server/i18n/request-locale.js';
import { i18nRoutes } from '../src/server/i18n/routes.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// The dictionaries' routes (src/server/i18n): public, outside /api, immutable
// files with their hash as a strong ETag, a revalidated manifest; and the
// locale preference (`PATCH /api/preferences`, `locale`).

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) {
        await step();
    }
    vi.restoreAllMocks();
});

const SOURCES = {
    'en-US': {
        common: { product: 'Socio' },
        // Over 1 kB, so it is precompressed.
        'settings.language': Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [`line${i}`, `The language line number ${i}`]),
        ),
    },
    // Fully translated: over the coverage gate, as es-US is through it.
    'es-419': {
        common: { product: 'Socio (es)' },
        'settings.language': Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [`line${i}`, `La línea de idioma número ${i}`]),
        ),
    },
    'es-US': {},
    // Barely started: under the gate, so nothing picks it.
    'pt-BR': { common: { product: 'Socio (pt)' } },
};

function sourceDir() {
    const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-src-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const [locale, namespaces] of Object.entries(SOURCES)) {
        mkdirSync(join(dir, locale), { recursive: true });
        for (const [ns, dictionary] of Object.entries(namespaces)) {
            writeFileSync(join(dir, locale, `${ns}.json`), JSON.stringify(dictionary));
        }
    }
    return dir;
}

const catalog = () =>
    loadI18nCatalog({ buildDir: join(tmpdir(), 'no-such-build'), sourceDir: sourceDir(), release: '1.2.3' });

const app = () => new Hono().route('/i18n', i18nRoutes(catalog()));

describe('GET /i18n/<locale>/<ns>.<hash>.json', () => {
    const entry = (ns: string) => catalog().manifest().locales['en-US']!.ns[ns]!;

    it('serves the file for good, with its hash as a strong ETag, and 304 on a match', async () => {
        const server = app();
        const { hash } = entry('common');
        const response = await server.request(`/i18n/en-US/common.${hash}.json`);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('etag')).toBe(`"${hash}"`);
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(await response.json()).toEqual({ product: 'Socio' });
        const again = await server.request(`/i18n/en-US/common.${hash}.json`, {
            headers: { 'If-None-Match': `W/"other", "${hash}"` },
        });
        expect(again.status).toBe(304);
        expect(await again.text()).toBe('');
        expect(again.headers.get('etag')).toBe(`"${hash}"`);
    });

    it('sends the precompressed copy the browser takes', async () => {
        const server = app();
        const { hash } = entry('settings.language');
        const path = `/i18n/en-US/settings.language.${hash}.json`;
        const br = await server.request(path, { headers: { 'Accept-Encoding': 'gzip, br' } });
        expect(br.headers.get('content-encoding')).toBe('br');
        expect(JSON.parse(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).line0).toBe(
            'The language line number 0',
        );
        const gzip = await server.request(path, { headers: { 'Accept-Encoding': 'gzip, br;q=0' } });
        expect(gzip.headers.get('content-encoding')).toBe('gzip');
        expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toContain('line59');
        const plain = await server.request(path);
        expect(plain.headers.get('content-encoding')).toBeNull();
        expect(plain.headers.get('vary')).toBe('Accept-Encoding');
    });

    it('answers 404, never cached, for an unknown hash, namespace, locale or name', async () => {
        const server = app();
        const { hash } = entry('common');
        for (const path of [
            '/i18n/en-US/common.000000000000.json',
            `/i18n/en-US/chat.${hash}.json`,
            `/i18n/fr-FR/common.${hash}.json`,
            `/i18n/en-US/common.json`,
            `/i18n/en-US/../common.${hash}.json`,
            '/i18n/anything',
        ]) {
            const response = await server.request(path);
            expect(response.status, path).toBe(404);
            expect(response.headers.get('cache-control'), path).toBe('no-store');
        }
    });
});

describe('GET /i18n/manifest.json', () => {
    it('revalidates: no-cache, an ETag, 304 on a match', async () => {
        const server = app();
        const response = await server.request('/i18n/manifest.json');
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-cache');
        const etag = response.headers.get('etag')!;
        expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
        const manifest = await response.json();
        expect(manifest.release).toBe('1.2.3');
        expect(Object.keys(manifest.locales)).toEqual(['en-US', 'es-419', 'es-US', 'pt-BR', 'en-XA']);
        const again = await server.request('/i18n/manifest.json', { headers: { 'If-None-Match': etag } });
        expect(again.status).toBe(304);
    });

    it('narrows to the locales asked for and their fallbacks, with an ETag of its own', async () => {
        const server = app();
        const narrow = await server.request('/i18n/manifest.json?locales=es-US');
        expect(Object.keys((await narrow.json()).locales)).toEqual(['en-US', 'es-419', 'es-US']);
        const whole = await server.request('/i18n/manifest.json');
        expect(narrow.headers.get('etag')).not.toBe(whole.headers.get('etag'));
    });
});

describe('the manifest’s cache', () => {
    it('keeps no entry for tags that aren’t registered', () => {
        const loaded = catalog();
        // One cached entry: the same object every time, whatever unknown tags come with it.
        const entries = new Set<object>();
        for (let i = 0; i < 50; i++) {
            entries.add(loaded.manifestBody([`xx-${i}`, 'es-US']));
            entries.add(loaded.manifestBody([`yy-${i}`]));
        }
        expect(entries.size).toBe(2);
        expect(loaded.manifestBody(['zz-ZZ'])).toBe(loaded.manifestBody([]));
        // Unknown tags alone: en-US, the end of every chain.
        expect(Object.keys(JSON.parse(loaded.manifestBody(['zz-ZZ']).body).locales)).toEqual(['en-US']);
        // The same set, however it is asked for, is one body.
        expect(loaded.manifestBody(['es-US'])).toBe(loaded.manifestBody(['es-419', 'es-US', 'es-US']));
    });
});

describe('the catalog', () => {
    it('reads a build’s files, as the script writes them', () => {
        const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-build-'));
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
        const built = buildCatalog({ 'en-US': { common: { product: 'Socio' } } }, '9.9.9');
        for (const file of built.files) {
            mkdirSync(join(dir, file.locale), { recursive: true });
            writeFileSync(join(dir, file.locale, `${file.ns}.${file.hash}.json`), file.text);
        }
        writeFileSync(join(dir, 'manifest.json'), JSON.stringify(built.manifest));
        const loaded = loadI18nCatalog({ buildDir: dir, release: 'ignored' });
        expect(loaded.manifest().release).toBe('9.9.9');
        const { hash } = built.manifest.locales['en-US']!.ns.common!;
        expect(Buffer.from(loaded.file('en-US', 'common', hash)!.body).toString()).toBe('{"product":"Socio"}');
        expect(loaded.file('en-US', 'common', '0'.repeat(12))).toBeUndefined();
    });

    it('resolves a page’s locale and inlines only the namespaces asked for, with their fallbacks', () => {
        const page = catalog().page({ acceptLanguage: 'es-MX' }, ['common']);
        expect(page.locale).toBe('es-419');
        expect(page.dir).toBe('ltr');
        expect(page.resources).toEqual({
            'es-419': { common: { product: 'Socio (es)' } },
            'en-US': { common: { product: 'Socio' } },
        });
        expect(Object.keys(page.manifest.locales)).toEqual(['en-US', 'es-419']);
        // The offered set is the one the request was negotiated over.
        expect(page.offered).toEqual(['en-US', 'es-419', 'es-US']);
        // es-US has no file of its own: it falls through to es-419's strings.
        const us = catalog().page({ preference: 'es-US' }, ['common']);
        expect(us.locale).toBe('es-US');
        expect(Object.keys(us.resources)).toEqual(['es-419', 'en-US']);
    });

    it('never picks a locale under the coverage gate, from a browser, a cookie or a preference', () => {
        const loaded = catalog();
        expect(loaded.manifest().locales['pt-BR']!.coverage).toBeGreaterThan(0);
        for (const sources of [
            { acceptLanguage: 'pt-BR,pt;q=0.9' },
            { cookie: 'pt-BR', acceptLanguage: 'pt-BR' },
            { preference: 'pt-BR', acceptLanguage: 'pt-BR' },
        ]) {
            const page = loaded.page(sources, ['common']);
            expect(page.locale, JSON.stringify(sources)).toBe('en-US');
            expect(page.offered).not.toContain('pt-BR');
        }
        // The pseudo-locale only when named.
        expect(loaded.page({ cookie: 'en-XA' }, ['common']).locale).toBe('en-XA');
        expect(loaded.page({ acceptLanguage: 'en-XA' }, ['common']).locale).toBe('en-US');
    });

    it('resolves a request: preference, cookie, Accept-Language, en-US', async () => {
        const server = new Hono().get('/', (c) =>
            c.text(requestLocale(c, ['en-US', 'es-419', 'es-US'], c.req.query('pref') || null)),
        );
        const get = async (query: string, headers: Record<string, string>) =>
            (await server.request(`/${query}`, { headers })).text();
        expect(await get('?pref=es-US', { cookie: 'socio_locale=es-419', 'accept-language': 'en' })).toBe('es-US');
        expect(await get('', { cookie: 'socio_locale=es-419', 'accept-language': 'en' })).toBe('es-419');
        expect(await get('', { 'accept-language': 'es-AR' })).toBe('es-419');
        expect(await get('', {})).toBe('en-US');
    });
});

describe('the app', () => {
    async function runtime() {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const { app, dispose } = await makeTestRuntime({
            config: { baseUrl: 'https://model.invalid/v1' },
            app: {
                i18n: catalog(),
                auth: {
                    provider: new MockAuthProvider(DEFAULT_MOCK_USERS, 'secret-0123456789abcdef-xyz'),
                    secureCookies: false,
                },
            },
        });
        cleanup.push(dispose);
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'alice' }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const preferences = (body?: unknown) =>
            app.request('/api/preferences', {
                method: body === undefined ? 'GET' : 'PATCH',
                headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        return { app, preferences };
    }

    it('serves the dictionaries without a session', async () => {
        const { app } = await runtime();
        const response = await app.request('/i18n/manifest.json');
        expect(response.status).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        const { hash } = (await response.json()).locales['en-US'].ns.common;
        expect((await app.request(`/i18n/en-US/common.${hash}.json`)).status).toBe(200);
    });

    it('saves a registered locale or null, and refuses anything else', async () => {
        const { preferences } = await runtime();
        expect((await (await preferences()).json()).locale).toBeUndefined();
        const saved = await preferences({ locale: 'es-US' });
        expect(saved.status).toBe(200);
        expect((await saved.json()).locale).toBe('es-US');
        expect((await (await preferences()).json()).locale).toBe('es-US');
        for (const locale of ['es-us', 'fr-FR', 'en', '', 42, ['es-US']]) {
            expect((await preferences({ locale })).status, JSON.stringify(locale)).toBe(400);
        }
        expect((await (await preferences()).json()).locale).toBe('es-US');
        const cleared = await preferences({ locale: null });
        expect((await cleared.json()).locale).toBeNull();
    });
});
