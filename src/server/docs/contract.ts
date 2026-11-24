/**
 * What other features may know of the documentation catalog: its tag, its
 * shape and plain types. It imports only `effect` and `@socio/*`, and holds
 * no logic.
 *
 * Moved here from `catalog.ts`: `AUDIENCES` and `DocsFile`.
 *
 * Written out here for the first time (`catalog.ts` inferred it): the
 * catalog's shape, `DocsCatalogShape`. `buildDocsCatalog` now returns it,
 * and `catalog.ts`'s `DocsCatalog` type is the same shape.
 *
 * Not here, on purpose:
 * - `readDocs`, `buildDocsCatalog` and `getDocsCatalog` (`catalog.ts`): only
 *   the composition (`composition/lifecycle/docs.ts`) and tests build the
 *   catalog. Other folders get the `Docs` tag below.
 * - `mountDocsExports` (`http.ts`): route mounting, which `web/mount.ts`
 *   calls today. It moves to the composition's route files with the web
 *   routes, not behind a tag.
 * - No `DocsConfig`: docs reads no `PlatformConfig` field (the content root
 *   is `content/docs` under the working directory).
 */
import { Context } from 'effect';

import type { DocsScreen, DocsTree } from '@socio/shared/docs';
import type { Role } from '@socio/shared/types';

// ── Plain types and constants ────────────────────────────────────────────

/** The content directories under `content/docs`, least to most privileged. */
export const AUDIENCES = ['user', 'admin', 'operate'] as const;

/** Who a guide is for: everyone, admins, or operators. */
export type DocsAudience = (typeof AUDIENCES)[number];

/** One Markdown file read from `content/docs/<audience>/<name>`. */
export interface DocsFile {
    audience: DocsAudience;
    name: string;
    markdown: string;
}

/** A guide in a reader's list: what agents and `llms.txt` show. */
export interface DocsPageSummary {
    url: string;
    title: string;
    description: string;
}

/** One search hit (Fumadocs' `SortedResult`), already limited to the reader's guides. */
export interface DocsSearchResult {
    id: string;
    url: string;
    type: 'page' | 'heading' | 'text';
    content: string;
    breadcrumbs?: string[];
    table?: string;
}

// ── Docs ─────────────────────────────────────────────────────────────────

/**
 * The compiled documentation, filtered by the reader's role on every call
 * (no role reads as a member). It is built once before serving; `web` reads
 * pages, navigation, Markdown, search and `llms.txt` from it, and `agents`
 * reads `list`, `markdown` and `search` (its `AgentDocsCatalog` is a slice
 * of this shape, and `Ports.docs` is typed with that slice).
 */
export interface DocsCatalogShape {
    /** A SHA-256 of the files the catalog was built from. */
    readonly digest: string;
    /** A guide and the reader's navigation, or null if it isn't theirs to open. */
    screen(url: string, role?: Role): DocsScreen | null;
    /** The reader's navigation alone, for a page that isn't theirs to open. */
    tree(role?: Role): DocsTree;
    /** The reader's guides. */
    list(role?: Role): DocsPageSummary[];
    /** A guide's Markdown source, or null if it isn't theirs to open. */
    markdown(url: string, role?: Role): string | null;
    /** `llms.txt` (an index) or `llms-full.txt` (every guide in full) for the reader. */
    llms(full: boolean, role?: Role): string;
    /** Up to 20 hits; queries are at most 128 characters, eight at a time. */
    search(query: string, role?: Role): Promise<DocsSearchResult[]>;
}

export class Docs extends Context.Service<Docs, DocsCatalogShape>()('socio/docs/Docs') {}
