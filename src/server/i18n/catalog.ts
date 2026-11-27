import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

import { buildCatalog, type Sources } from '@socio/i18n/catalog';
import {
    eligibleLocales,
    explicitLocales,
    namespaceEntry,
    narrowManifest,
    type I18nManifest,
} from '@socio/i18n/manifest';
import { resolveRequestLocale } from '@socio/i18n/negotiate';
import { isSupportedLocale, localeDir, resolutionChain } from '@socio/i18n/registry';

import type { I18nCatalogShape, I18nFile } from './contract.js';

/** A namespace file's name: `<ns>.<sha256-12>.json`. */
export const FILE_NAME = /^([a-z][a-z0-9.-]*)\.([0-9a-f]{12})\.json$/;

/** Under 1 kB a file is sent as it is, as scripts/precompress.mjs does. */
const MIN_COMPRESSED = 1024;

/** Reads a build's dictionaries (dist/i18n, from scripts/i18n-build.mjs), lazily, each file once. */
function fromBuild(dir: string): {
    manifest: I18nManifest;
    read: (locale: string, ns: string, hash: string) => I18nFile | undefined;
} {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as I18nManifest;
    const files = new Map<string, I18nFile>();
    const optional = (path: string) => (existsSync(path) ? readFileSync(path) : undefined);
    return {
        manifest,
        read(locale, ns, hash) {
            if (!isSupportedLocale(locale) || namespaceEntry(manifest, locale, ns)?.hash !== hash) {
                return undefined;
            }
            const path = join(dir, locale, `${ns}.${hash}.json`);
            let file = files.get(path);
            if (!file) {
                file = { body: readFileSync(path), gzip: optional(`${path}.gz`), brotli: optional(`${path}.br`) };
                files.set(path, file);
            }
            return file;
        },
    };
}

/** The parsed source files under packages/i18n/locales: `<locale>/<ns>.json`. */
export function readSources(dir: string): Sources {
    const sources: Sources = {};
    for (const locale of readdirSync(dir).sort()) {
        if (!statSync(join(dir, locale)).isDirectory()) {
            continue;
        }
        sources[locale] = {};
        for (const name of readdirSync(join(dir, locale)).sort()) {
            if (name.endsWith('.json')) {
                sources[locale][name.slice(0, -'.json'.length)] = JSON.parse(
                    readFileSync(join(dir, locale, name), 'utf8'),
                );
            }
        }
    }
    return sources;
}

/** Builds the dictionaries from source, in memory: development and tests, which have no build. */
function fromSources(dir: string, release: string) {
    const { manifest, files } = buildCatalog(readSources(dir), release);
    const byPath = new Map(
        files.map((file) => {
            const body = Buffer.from(file.text);
            const compressed: I18nFile =
                body.byteLength < MIN_COMPRESSED
                    ? { body }
                    : {
                          body,
                          gzip: gzipSync(body, { level: constants.Z_BEST_COMPRESSION }),
                          brotli: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
                      };
            return [`${file.locale}/${file.ns}.${file.hash}`, compressed] as const;
        }),
    );
    return { manifest, read: (locale: string, ns: string, hash: string) => byPath.get(`${locale}/${ns}.${hash}`) };
}

export interface CatalogLocation {
    /** The build's output (dist/i18n). */
    readonly buildDir: string;
    /** The source files (packages/i18n/locales), built in memory when `preferSources` or there is no build. */
    readonly sourceDir?: string;
    readonly preferSources?: boolean;
    /** Socio's version, for a manifest built in memory. */
    readonly release: string;
}

const etagOf = (body: string) => `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

/**
 * The dictionaries this server serves: its build's, or (development,
 * tests) its source built in memory. With neither, an empty catalog: every
 * page renders en-US from the client's keys... which is why `pnpm build`
 * always writes dist/i18n.
 */
export function loadI18nCatalog(location: CatalogLocation): I18nCatalogShape {
    const { buildDir, sourceDir, preferSources, release } = location;
    const hasBuild = existsSync(join(buildDir, 'manifest.json'));
    const hasSources = !!sourceDir && existsSync(sourceDir);
    const loaded =
        hasSources && (preferSources || !hasBuild)
            ? fromSources(sourceDir, release)
            : hasBuild
              ? fromBuild(buildDir)
              : { manifest: { release, locales: {} } as I18nManifest, read: () => undefined };
    const { manifest, read } = loaded;
    const bodies = new Map<string, { body: string; etag: string }>();
    const eligible = eligibleLocales(manifest);
    const explicit = explicitLocales(manifest);
    const parsed = new Map<string, unknown>();
    const dictionary = (locale: string, ns: string) => {
        const hash = namespaceEntry(manifest, locale, ns)?.hash;
        if (!hash) {
            return undefined;
        }
        const key = `${locale}/${ns}`;
        if (!parsed.has(key)) {
            const file = read(locale, ns, hash);
            parsed.set(key, file && JSON.parse(Buffer.from(file.body).toString('utf8')));
        }
        return parsed.get(key);
    };
    return {
        manifest: () => manifest,
        manifestBody(locales) {
            // Only registered locales, with their fallbacks, name a body: the
            // query is anyone's, so unknown tags never make a cache entry of
            // their own (at most one per set of registered locales).
            const known = locales?.filter(isSupportedLocale).flatMap(resolutionChain);
            const key = known ? [...new Set(known)].sort().join(',') : '*';
            let found = bodies.get(key);
            if (!found) {
                const body = JSON.stringify(narrowManifest(manifest, known));
                found = { body, etag: etagOf(body) };
                bodies.set(key, found);
            }
            return found;
        },
        file: read,
        page(sources, namespaces) {
            const locale = resolveRequestLocale(sources, eligible, explicit);
            const chain = resolutionChain(locale);
            const resources: Record<string, Record<string, unknown>> = {};
            for (const tag of chain) {
                for (const ns of namespaces) {
                    const found = dictionary(tag, ns);
                    if (found !== undefined) {
                        (resources[tag] ??= {})[ns] = found;
                    }
                }
            }
            return {
                locale,
                dir: localeDir(locale),
                manifest: narrowManifest(manifest, [locale]),
                resources,
                offered: eligible,
            };
        },
    };
}
