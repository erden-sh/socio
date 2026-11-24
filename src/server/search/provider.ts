import { z } from 'zod';

import { MAX_SOURCE_CHARS, MAX_SOURCES, type GatherRequest, type SearchProvider, type WebSource } from './contract.js';

export const sourceSchema = z.object({
    url: z
        .string()
        .url()
        .refine((value) => {
            const url = new URL(value);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
        }),
    title: z.string().nullable().optional(),
    excerpts: z.array(z.string()).default([]),
});
const dataSchema = z.object({
    results: z.array(z.unknown()),
    errors: z.array(z.unknown()).optional(),
    warnings: z.array(z.unknown()).nullable().optional(),
});

export function sourcesFromData(data: unknown, warn: (message: string) => void = () => {}): WebSource[] {
    const parsed = dataSchema.parse(data);
    if (parsed.errors?.length) {
        warn(`The provider reported ${parsed.errors.length} source extraction error(s); coverage is incomplete.`);
    }
    if (parsed.warnings?.length) {
        warn('The provider returned warnings; some source evidence may be incomplete.');
    }
    let discarded = 0;
    const seen = new Set<string>();
    const sources = parsed.results
        .flatMap((item) => {
            const parsedSource = sourceSchema.safeParse(item);
            if (!parsedSource.success) {
                discarded++;
                return [];
            }
            const value = parsedSource.data;
            if (seen.has(value.url)) {
                return [];
            }
            if (!value.excerpts.some((text) => text.trim())) {
                discarded++;
                return [];
            }
            seen.add(value.url);
            return [
                {
                    title: value.title || value.url,
                    url: value.url,
                    text: value.excerpts.join('\n').slice(0, MAX_SOURCE_CHARS),
                },
            ];
        })
        .slice(0, MAX_SOURCES);
    if (discarded) {
        warn(`Skipped ${discarded} malformed or empty source result(s); coverage is incomplete.`);
    }
    return sources;
}

/** Search (unless URLs are given), then read the sources, within one session. */
export async function gatherSources(
    provider: SearchProvider,
    request: GatherRequest,
    signal: AbortSignal,
): Promise<WebSource[]> {
    signal.throwIfAborted();
    const label = provider.label;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    // Send only the requested research objective and URLs, never memories or the full transcript.
    const objective = request.objective;
    const queries = request.searchQueries ?? [objective];
    const warn = request.onWarning ?? (() => {});
    if (request.urls?.length && !provider.canRead) {
        throw new Error(`${label} cannot read a specific page. Search for the topic instead.`);
    }
    const session = await provider.open(request.sessionId, boundedSignal);
    try {
        let urls = request.urls;
        if (!urls?.length) {
            const found = sourcesFromData(await session.search(objective, queries, boundedSignal), warn);
            if (!found.length) {
                throw new Error(`${label} found no usable sources. Try a more specific research request.`);
            }
            if (!session.read) {
                return found;
            }
            urls = found.map((page) => page.url);
        }
        for (const url of urls) {
            sourceSchema.shape.url.parse(url);
        }
        const pages = sourcesFromData(
            await session.read!(
                urls.slice(0, MAX_SOURCES),
                objective.length <= 200
                    ? objective
                    : 'Extract source evidence relevant to the supplied research queries.',
                queries,
                boundedSignal,
            ),
            warn,
        );
        if (urls.length > MAX_SOURCES) {
            warn('Only the first five URLs were read; coverage is limited.');
        }
        if (pages.length < Math.min(urls.length, MAX_SOURCES)) {
            warn('Some requested sources could not be read; coverage is incomplete.');
        }
        boundedSignal.throwIfAborted();
        if (!pages.length) {
            throw new Error(`${label} could not extract usable source evidence.`);
        }
        return pages;
    } finally {
        await session.close().catch(() => {});
    }
}
