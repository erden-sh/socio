import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

import { LOCALE_COOKIE, resolveRequestLocale, type LocaleSources } from '@socio/i18n/negotiate';

/**
 * What a request says about its locale, beside the saved preference: the
 * `socio_locale` cookie and Accept-Language. `resolveRequestLocale` (or the
 * catalog's `page`) weighs them: preference, cookie, Accept-Language, en-US.
 */
export function requestLocaleSources(c: Context, preference?: string | null): LocaleSources {
    return {
        preference,
        cookie: getCookie(c, LOCALE_COOKIE) ?? null,
        acceptLanguage: c.req.header('Accept-Language') ?? null,
    };
}

/** The request's locale among `available` (`availableLocales(manifest)`). */
export const requestLocale = (c: Context, available: readonly string[], preference?: string | null) =>
    resolveRequestLocale(requestLocaleSources(c, preference), available);
