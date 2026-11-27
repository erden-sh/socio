import { Hono, type Context } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { FILE_NAME } from './catalog.js';
import type { I18nCatalogShape, I18nFile } from './contract.js';

/** A content-hashed file: its URL changes with its content. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Whether a request's If-None-Match names `etag` (or `*`). */
const matches = (header: string | undefined, etag: string) =>
    !!header &&
    header
        .split(',')
        .map((tag) => tag.trim().replace(/^W\//, ''))
        .some((tag) => tag === etag || tag === '*');

const missing = (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: 'Not found.' }, 404);
};

/** The body for the request's Accept-Encoding: Brotli, then gzip, then plain. */
function encoded(c: Context<AppEnv>, file: I18nFile) {
    const accepts = (c.req.header('Accept-Encoding') ?? '').toLowerCase();
    const takes = (name: string) =>
        accepts.split(',').some((entry) => {
            const [token, ...params] = entry.trim().split(';');
            return token === name && !params.some((param) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param));
        });
    if (file.brotli && takes('br')) {
        return { body: file.brotli, encoding: 'br' };
    }
    if (file.gzip && takes('gzip')) {
        return { body: file.gzip, encoding: 'gzip' };
    }
    return { body: file.body, encoding: undefined };
}

/**
 * The dictionaries, public and without a session (they hold only UI
 * strings): `GET /i18n/manifest.json?locales=es-US` (revalidated: no-cache
 * and an ETag) and `GET /i18n/<locale>/<ns>.<hash>.json` (immutable, its
 * hash as a strong ETag). Outside `/api`: the native app counts a 2xx
 * under `/api` as signed-in contact.
 */
export function i18nRoutes(catalog: I18nCatalogShape) {
    const app = new Hono<AppEnv>();
    app.get('/manifest.json', (c) => {
        const raw = c.req.query('locales');
        const locales =
            raw === undefined
                ? undefined
                : raw
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean)
                      .slice(0, 16);
        const { body, etag } = catalog.manifestBody(locales);
        c.header('Cache-Control', 'no-cache');
        c.header('ETag', etag);
        c.header('Vary', 'Accept-Encoding');
        if (matches(c.req.header('If-None-Match'), etag)) {
            return c.body(null, 304);
        }
        c.header('Content-Type', 'application/json; charset=utf-8');
        return c.body(body);
    });
    app.get('/:locale/:file', (c) => {
        const name = FILE_NAME.exec(c.req.param('file'));
        const file = name && catalog.file(c.req.param('locale'), name[1]!, name[2]!);
        if (!name || !file) {
            return missing(c);
        }
        const etag = `"${name[2]}"`;
        c.header('Cache-Control', IMMUTABLE);
        c.header('ETag', etag);
        c.header('Vary', 'Accept-Encoding');
        if (matches(c.req.header('If-None-Match'), etag)) {
            return c.body(null, 304);
        }
        const { body, encoding } = encoded(c, file);
        c.header('Content-Type', 'application/json; charset=utf-8');
        if (encoding) {
            c.header('Content-Encoding', encoding);
        }
        return c.body(body as Uint8Array<ArrayBuffer>);
    });
    app.all('*', (c) => missing(c));
    return app;
}
