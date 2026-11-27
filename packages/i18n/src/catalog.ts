import { pluralRules } from '@socio/shared/locale';

import { flatten, pluralForm, sourceHash, variablesOf, type Dictionary } from './keys.js';
import type { I18nManifest, LocaleEntry } from './manifest.js';
import { pseudoDictionary } from './pseudo.js';
import { LOCALES, PSEUDO_LOCALE, SOURCE_LOCALE, isSupportedLocale, resolutionChain } from './registry.js';
import { sha256Hex } from './sha256.js';

/**
 * The dictionaries' build (`scripts/i18n-build.mjs` writes it to
 * dist/i18n; the server builds it in memory when there is no build): it
 * checks every locale against en-US, computes coverage through each
 * locale's fallback chain, generates en-XA, and names each file by its
 * content's hash.
 */

/** The parsed files: `sources[locale][ns]`. */
export type Sources = Record<string, Record<string, unknown>>;

export interface BuiltFile {
    readonly locale: string;
    readonly ns: string;
    readonly hash: string;
    /** The file's body: the dictionary as compact JSON. */
    readonly text: string;
}

export interface Catalog {
    readonly manifest: I18nManifest;
    readonly files: readonly BuiltFile[];
}

/** Every problem found, one line each; the build fails on any. */
export class CatalogError extends Error {
    constructor(readonly problems: readonly string[]) {
        super(`The dictionaries have ${problems.length} problem(s):\n${problems.join('\n')}`);
        this.name = 'CatalogError';
    }
}

/** Namespace names: lower-case words, dotted for a screen inside a feature (`settings.language`). */
export const NAMESPACE_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/** The plural categories a locale's CLDR rules use. */
const categoriesOf = (locale: string, ordinal: boolean) =>
    new Set(pluralRules({ type: ordinal ? 'ordinal' : 'cardinal' }, locale).resolvedOptions().pluralCategories);

/** A plural group's id: its base, and whether it is ordinal. */
const groupId = (base: string, ordinal: boolean) => `${base}${ordinal ? '#ordinal' : ''}`;

interface Units {
    /** Plain keys and plural groups: what coverage counts. */
    readonly units: Set<string>;
    readonly plain: Map<string, string>;
    /** Group id → its forms' variables, together. */
    readonly plurals: Map<string, Set<string>>;
}

function unitsOf(keys: Map<string, string>): Units {
    const units = new Set<string>();
    const plain = new Map<string, string>();
    const plurals = new Map<string, Set<string>>();
    for (const [key, text] of keys) {
        const form = pluralForm(key);
        if (form) {
            const id = groupId(form.base, form.ordinal);
            units.add(id);
            const vars = plurals.get(id) ?? new Set<string>();
            for (const name of variablesOf(text)) {
                vars.add(name);
            }
            plurals.set(id, vars);
        } else {
            units.add(key);
            plain.set(key, text);
        }
    }
    return { units, plain, plurals };
}

/** One locale's namespace against en-US's: the problems, as `locale/ns: …`. */
function checkNamespace(locale: string, ns: string, keys: Map<string, string>, source: Units | undefined): string[] {
    const at = `${locale}/${ns}`;
    const problems: string[] = [];
    const forms = new Map<string, Set<string>>();
    for (const [key, text] of keys) {
        if (!text.trim()) {
            problems.push(`${at}: ${key} is empty (leave a key out to fall back)`);
        }
        const form = pluralForm(key);
        if (form) {
            const id = groupId(form.base, form.ordinal);
            forms.set(id, (forms.get(id) ?? new Set()).add(form.category));
            if (source && !source.plurals.has(id)) {
                problems.push(`${at}: ${key} is a plural form of ${form.base}, which en-US doesn't have as a plural`);
            } else if (source) {
                const allowed = new Set([...source.plurals.get(id)!, 'count']);
                const extra = variablesOf(text).filter((name) => !allowed.has(name));
                if (extra.length) {
                    problems.push(`${at}: ${key} uses ${extra.join(', ')}, which en-US's ${form.base} doesn't pass`);
                }
            }
        } else if (source) {
            const expected = source.plain.get(key);
            if (expected === undefined) {
                problems.push(`${at}: ${key} isn't in en-US`);
            } else {
                const want = variablesOf(expected).join(', ');
                const got = variablesOf(text).join(', ');
                if (want !== got) {
                    problems.push(`${at}: ${key} interpolates {${got}}, en-US {${want}}`);
                }
            }
        }
    }
    for (const [id, present] of forms) {
        const ordinal = id.endsWith('#ordinal');
        const missing = [...categoriesOf(locale, ordinal)].filter((category) => !present.has(category));
        if (missing.length) {
            const base = ordinal ? id.slice(0, -'#ordinal'.length) : id;
            problems.push(`${at}: ${base} lacks the ${locale} plural form(s) ${missing.join(', ')}`);
        }
    }
    return problems;
}

/** Rounded to a hundredth of a percent, so a manifest doesn't change with float noise. */
const share = (covered: number, total: number) => (total ? Math.round((covered / total) * 10000) / 10000 : 1);

/**
 * Builds the catalog from the parsed files; throws a `CatalogError` with
 * every problem. `release` is Socio's version.
 */
export function buildCatalog(sources: Sources, release: string): Catalog {
    const problems: string[] = [];
    const english = sources[SOURCE_LOCALE];
    if (!english || !Object.keys(english).length) {
        throw new CatalogError([`${SOURCE_LOCALE} has no namespaces: it is the source every locale falls back to`]);
    }
    const flat: Record<string, Record<string, Map<string, string>>> = {};
    for (const [locale, namespaces] of Object.entries(sources)) {
        if (!isSupportedLocale(locale)) {
            problems.push(`${locale}: not a registered locale (packages/i18n/src/registry.ts)`);
            continue;
        }
        if (locale === PSEUDO_LOCALE) {
            problems.push(`${locale}: generated from en-US, so it has no files`);
            continue;
        }
        flat[locale] = {};
        for (const [ns, dictionary] of Object.entries(namespaces)) {
            if (!NAMESPACE_NAME.test(ns)) {
                problems.push(`${locale}/${ns}: not a namespace name (lower case, dotted: settings.language)`);
                continue;
            }
            if (locale !== SOURCE_LOCALE && !english[ns]) {
                problems.push(`${locale}/${ns}: en-US has no such namespace`);
                continue;
            }
            try {
                flat[locale][ns] = flatten(dictionary);
            } catch (error) {
                problems.push(`${locale}/${ns}: ${(error as Error).message}`);
            }
        }
    }
    const sourceUnits = Object.fromEntries(
        Object.entries(flat[SOURCE_LOCALE] ?? {}).map(([ns, keys]) => [ns, unitsOf(keys)]),
    );
    for (const [locale, namespaces] of Object.entries(flat)) {
        for (const [ns, keys] of Object.entries(namespaces)) {
            problems.push(...checkNamespace(locale, ns, keys, locale === SOURCE_LOCALE ? undefined : sourceUnits[ns]));
        }
    }
    if (problems.length) {
        throw new CatalogError(problems);
    }

    const dictionaries: Record<string, Record<string, Dictionary>> = {};
    for (const [locale, namespaces] of Object.entries(sources)) {
        dictionaries[locale] = namespaces as Record<string, Dictionary>;
    }
    dictionaries[PSEUDO_LOCALE] = Object.fromEntries(
        Object.entries(english).map(([ns, dictionary]) => [ns, pseudoDictionary(dictionary as Dictionary)]),
    );
    const sourceHashes = Object.fromEntries(
        Object.entries(english).map(([ns, dictionary]) => [ns, sourceHash(dictionary as Dictionary)]),
    );
    const total = Object.values(sourceUnits).reduce((sum, units) => sum + units.units.size, 0);
    const files: BuiltFile[] = [];
    const locales: Record<string, LocaleEntry> = {};
    for (const locale of Object.keys(LOCALES)) {
        const own = dictionaries[locale] ?? {};
        const ns: Record<string, { hash: string; sourceHash: string }> = {};
        for (const name of Object.keys(own).sort()) {
            const text = JSON.stringify(own[name]);
            const hash = sha256Hex(text).slice(0, 12);
            files.push({ locale, ns: name, hash, text });
            ns[name] = { hash, sourceHash: sourceHashes[name]! };
        }
        let covered = total;
        if (locale !== SOURCE_LOCALE && locale !== PSEUDO_LOCALE) {
            const chain = resolutionChain(locale).filter((tag) => tag !== SOURCE_LOCALE);
            covered = 0;
            for (const [name, units] of Object.entries(sourceUnits)) {
                const translated = chain.map((tag) => {
                    const keys = flat[tag]?.[name];
                    return keys ? unitsOf(keys).units : new Set<string>();
                });
                for (const unit of units.units) {
                    if (translated.some((set) => set.has(unit))) {
                        covered++;
                    }
                }
            }
        }
        locales[locale] = { coverage: share(covered, total), ns };
    }
    return { manifest: { release, locales }, files };
}
