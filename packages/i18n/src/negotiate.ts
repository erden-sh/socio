import { LOCALES, SOURCE_LOCALE, isSupportedLocale } from './registry.js';

/**
 * Locale negotiation (BCP 47 lookup with Socio's regional fallbacks). Each
 * requested tag, in order, is tried against `supported`:
 *
 * 1. the tag itself (`es-US`);
 * 2. its regional group (`es-MX` → `es-419`, Spanish in the Americas);
 * 3. its language's default (`es` → `es-419`, `pt-PT` → `pt-BR`, `en-GB` → `en-US`);
 *
 * and the first that matches wins; with none, `fallback` (en-US). Tags are
 * compared case-insensitively and `_` reads as `-`.
 */

/** Spanish outside Spain in the Americas reads es-419 (CLDR's Latin America and the Caribbean). */
const LATIN_AMERICA = new Set('AR BO BR BZ CL CO CR CU DO EC GT HN MX NI PA PE PR PY SV US UY VE 419'.split(' '));

/** What a bare language (or one in another region) falls back to. */
const LANGUAGE_DEFAULTS: Record<string, readonly string[]> = {
    en: ['en-US'],
    es: ['es-419', 'es-US'],
    pt: ['pt-BR'],
};

/** `es_mx` → `es-MX`, `zh-hant-tw` → `zh-Hant-TW`; null for something that isn't a tag. */
export function normalizeTag(tag: string): string | null {
    const parts = tag.trim().replaceAll('_', '-').split('-');
    if (!parts[0] || !/^[a-z]{2,3}$/i.test(parts[0]) || parts.some((part) => !/^[a-z0-9]{1,8}$/i.test(part))) {
        return null;
    }
    return parts
        .map((part, index) => {
            if (index === 0) {
                return part.toLowerCase();
            }
            if (/^[a-z]{4}$/i.test(part)) {
                return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
            }
            if (/^(?:[a-z]{2}|\d{3})$/i.test(part)) {
                return part.toUpperCase();
            }
            return part.toLowerCase();
        })
        .join('-');
}

const regionOf = (parts: string[]) => parts.slice(1).find((part) => /^(?:[A-Z]{2}|\d{3})$/.test(part));

/** The candidates one requested tag stands for, best first. */
function candidates(tag: string): string[] {
    const normal = normalizeTag(tag);
    if (!normal) {
        return [];
    }
    const parts = normal.split('-');
    const language = parts[0]!;
    const region = regionOf(parts);
    const found = [normal];
    if (region) {
        found.push(`${language}-${region}`);
    }
    if (language === 'es' && region && LATIN_AMERICA.has(region)) {
        found.push('es-419');
    }
    // An own key only: the language comes from a request.
    const defaults = Object.prototype.hasOwnProperty.call(LANGUAGE_DEFAULTS, language)
        ? LANGUAGE_DEFAULTS[language]!
        : [];
    found.push(language, ...defaults);
    return found;
}

/**
 * The best of `supported` for the tags asked for, in order of preference
 * (`navigator.languages`, a parsed Accept-Language); `fallback` when none
 * matches.
 */
export function negotiateLocale(
    requested: readonly string[],
    supported: readonly string[] = Object.keys(LOCALES),
    fallback: string = SOURCE_LOCALE,
): string {
    const byLower = new Map(supported.map((tag) => [tag.toLowerCase(), tag]));
    for (const tag of requested) {
        for (const candidate of candidates(tag)) {
            const match = byLower.get(candidate.toLowerCase());
            if (match) {
                return match;
            }
        }
    }
    return fallback;
}

/** An Accept-Language header's tags, most wanted first (q=0 and `*` dropped; ties keep their order). */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
    if (!header) {
        return [];
    }
    return header
        .split(',')
        .slice(0, 32)
        .map((entry, index) => {
            const [tag = '', ...params] = entry.trim().split(';');
            const q = params.map((param) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
            const weight = q === undefined ? 1 : Number(q);
            return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
        })
        .filter(({ tag, weight }) => tag && tag !== '*' && weight > 0)
        .sort((a, b) => b.weight - a.weight || a.index - b.index)
        .map(({ tag }) => tag);
}

/** What a request's locale comes from, strongest first. */
export interface LocaleSources {
    /** The saved preference (`user_preferences.locale`); null or unset: match the device. */
    preference?: string | null;
    /** The `socio_locale` cookie. */
    cookie?: string | null;
    /** The Accept-Language header. */
    acceptLanguage?: string | null;
}

/** The cookie that keeps a chosen locale for signed-out pages. */
export const LOCALE_COOKIE = 'socio_locale';

/**
 * The request's locale: the preference, then the cookie, then
 * Accept-Language, then en-US. A preference or cookie names a registered
 * locale exactly, and is taken when `explicit` holds it; Accept-Language
 * negotiates over `eligible`. Both come from the manifest
 * (`eligibleLocales`, `explicitLocales`): the locales over the coverage
 * gate, so a partly translated one is never picked.
 */
export function resolveRequestLocale(
    sources: LocaleSources,
    eligible: readonly string[],
    explicit: readonly string[] = eligible,
): string {
    for (const chosen of [sources.preference, sources.cookie]) {
        if (isSupportedLocale(chosen) && explicit.includes(chosen)) {
            return chosen;
        }
    }
    return negotiateLocale(parseAcceptLanguage(sources.acceptLanguage), eligible);
}
