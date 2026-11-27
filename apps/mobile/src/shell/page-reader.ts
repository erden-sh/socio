import { DATASET_VIEW_LANG, parseViewSpec, type ViewQueryResult, type ViewSpec } from '@socio/shared/dataset-view';
import { EMBED_CARD_LANG, EMBED_MEDIA_ID, type EmbedCard, embedCard } from '@socio/shared/embed-card';
import { dateTimeFormat } from '@socio/shared/locale';
import { pageHierarchy } from '@socio/shared/pages/page-hierarchy';
import type { Page, PageSummary } from '@socio/shared/pages/page-library';

import { markdownParts, type MarkdownPart } from '../chat/markdown';
import { isFolder, knowsFolders } from '../sync/page-manage';

import { UNTITLED_PAGE } from './space-library';

// Reading a page: what the `Page`
// route draws, with no React Native, so tests/shell runs it under Node.
// - The page as the phone holds it: its summary from the Space's list, its body
//   when one was read (`pageView`), with its parents (the web's phone crumbs)
//   and its subpages (the web's "Child pages"), from shared's `pageHierarchy`.
// - Its body cut into Markdown, which the chat's renderer draws by its rule
//   (images become links: nothing a page names is fetched), and the blocks the
//   web draws from fences: dataset views, link cards and pictures (`pageParts`).
// - Links to the workspace's pages and Spaces, in the path form and the old
//   hash form (`/#/spaces/…`), open in the app (`pageLink`, the web's
//   `resolveLink` for those paths); other links keep the chat's rules.
// - A folder (CB-426) is read as what it holds: its pages and folders, and no
//   body, excerpt or anything else of the text it keeps hidden.

/** What the reader says of a page the phone has no body of, offline. */
export const OPEN_ONLINE = 'Open it once you’re online';
/** The web's words for a page that isn't there (MissingPage.tsx). */
export const PAGE_NOT_FOUND = 'Page not found';
export const PAGE_NOT_FOUND_LINE = 'It isn’t in this Space. Check the link, or find the page in the library.';
/** A dataset view with no result kept, offline. */
export const VIEW_OPEN_TO_LOAD = 'Open the page online to load this view';
/** The web's line for a view that returned nothing. */
export const VIEW_EMPTY = 'The query returned no rows.';
/** The web's line for a picture or link card media it can't show. */
export const PICTURE_LABEL = 'Picture';

/** A picture in a page (an ```image fence): a media embed of the page's Space, never a URL. */
export interface PagePicture {
    readonly id: string;
    readonly alt?: string;
    readonly width?: number;
    readonly height?: number;
}

/** A GFM table, cut out of the page's Markdown: each cell its own inline Markdown (already made safe). */
export interface PageTable {
    readonly header: readonly string[];
    readonly align: readonly ('left' | 'center' | 'right' | null)[];
    /** Each row has as many cells as the header (GFM pads a short row and drops the excess). */
    readonly rows: readonly (readonly string[])[];
}

/**
 * A block the reader draws in place of Markdown: a fenced block's, or a table,
 * which the reader draws full width, as editor.css's `.document-prose table`
 * (`width: 100%; table-layout: fixed`), where the renderer's own table is only
 * as wide as its text.
 */
export type PageBlock =
    | { readonly kind: 'dataset-view'; readonly spec: ViewSpec }
    | { readonly kind: 'embed'; readonly card: EmbedCard }
    | { readonly kind: 'image'; readonly picture: PagePicture }
    | { readonly kind: 'table'; readonly table: PageTable };

/** The fence of a picture (shared's `PAGE_IMAGE_LANG`). */
export const PAGE_PICTURE_LANG = 'image';

const side = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000 ? value : undefined;

/**
 * A picture fence's JSON, read as shared's `pageImage` reads it (the same
 * fields, nothing else allowed), until the reader uses that module: the id of a
 * media embed, an optional alt (blank is none) and the image's size.
 */
export function pagePicture(body: string): PagePicture | null {
    let value: unknown;
    try {
        value = JSON.parse(body);
    } catch {
        return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const { id, alt, width, height, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof id !== 'string' || !EMBED_MEDIA_ID.test(id)) {
        return null;
    }
    if ((alt !== undefined && typeof alt !== 'string') || (typeof alt === 'string' && alt.length > 1000)) {
        return null;
    }
    if ((width !== undefined && side(width) === undefined) || (height !== undefined && side(height) === undefined)) {
        return null;
    }
    const picture: { id: string; alt?: string; width?: number; height?: number } = { id };
    if (typeof alt === 'string' && alt.trim() !== '') {
        picture.alt = alt.trim();
    }
    if (side(width) !== undefined) {
        picture.width = side(width);
    }
    if (side(height) !== undefined) {
        picture.height = side(height);
    }
    return picture;
}

function blockOf(lang: string, body: string): PageBlock | null {
    if (lang === DATASET_VIEW_LANG) {
        const spec = parseViewSpec(body);
        return spec === undefined ? null : { kind: 'dataset-view', spec };
    }
    if (lang === EMBED_CARD_LANG) {
        try {
            const card = embedCard(JSON.parse(body));
            return card === undefined ? null : { kind: 'embed', card };
        } catch {
            return null;
        }
    }
    if (lang === PAGE_PICTURE_LANG) {
        const picture = pagePicture(body);
        return picture === null ? null : { kind: 'image', picture };
    }
    return null;
}

/**
 * A page's body as the reader draws it: safe Markdown, and its blocks between:
 * a fenced block's that reads (one that doesn't stays code), and each top-level
 * table outside code.
 */
export function pageParts(content: string): MarkdownPart<PageBlock>[] {
    return markdownParts(content, (lang, block) => (block === null ? null : blockOf(lang, block.body))).flatMap(
        (part) => (part.kind === 'markdown' ? tableParts(part.text, part.key) : [part]),
    );
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_CELL = /^:?-+:?$/;

/** A row's cells: split on the pipes that aren't escaped, the outer ones dropped, `\|` read as a pipe. */
export function tableCells(line: string): string[] {
    let row = line.trim();
    if (row.startsWith('|')) {
        row = row.slice(1);
    }
    if (row.endsWith('|') && !row.endsWith('\\|')) {
        row = row.slice(0, -1);
    }
    const cells: string[] = [];
    let cell = '';
    for (let index = 0; index < row.length; index++) {
        const char = row[index];
        if (char === '\\' && row[index + 1] === '|') {
            cell += '|';
            index++;
        } else if (char === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += char;
        }
    }
    cells.push(cell.trim());
    return cells;
}

/** The delimiter row's alignments, or null when the line isn't one for `columns` columns. */
function delimiterRow(line: string, columns: number): PageTable['align'] | null {
    if (!line.includes('-')) {
        return null;
    }
    const cells = tableCells(line);
    if (cells.length !== columns || !cells.every((cell) => DELIMITER_CELL.test(cell))) {
        return null;
    }
    return cells.map((cell) =>
        cell.startsWith(':') && cell.endsWith(':')
            ? 'center'
            : cell.endsWith(':')
              ? 'right'
              : cell.startsWith(':')
                ? 'left'
                : null,
    );
}

/** A table row's line: top level (not indented as code, not quoted), with a pipe in it. */
const isRowLine = (line: string) => line.trim() !== '' && line.includes('|') && !/^( {4}|\t|\s*>)/.test(line);

/**
 * Markdown cut around its top-level GFM tables: a header row, the delimiter
 * row with as many cells, then the rows up to a blank line or a line with no
 * pipe. Lines inside a code fence are never a table.
 */
function tableParts(text: string, key: string): MarkdownPart<PageBlock>[] {
    const lines = text.split('\n');
    const parts: MarkdownPart<PageBlock>[] = [];
    let kept: string[] = [];
    const flush = () => {
        if (kept.some((line) => line.trim() !== '')) {
            parts.push({ kind: 'markdown', key: `${key}.${parts.length}`, text: kept.join('\n') });
        }
        kept = [];
    };
    let fence: string | null = null;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        const marker = FENCE_LINE.exec(line)?.[1];
        if (fence !== null) {
            if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
                fence = null;
            }
            kept.push(line);
            continue;
        }
        if (marker !== undefined) {
            fence = marker;
            kept.push(line);
            continue;
        }
        const header = isRowLine(line) ? tableCells(line) : null;
        const align = header === null ? null : delimiterRow(lines[index + 1] ?? '', header.length);
        if (header === null || align === null) {
            kept.push(line);
            continue;
        }
        const rows: string[][] = [];
        let end = index + 2;
        for (; end < lines.length && isRowLine(lines[end] ?? ''); end++) {
            const cells = tableCells(lines[end] ?? '');
            rows.push(header.map((_, column) => cells[column] ?? ''));
        }
        flush();
        parts.push({
            kind: 'block',
            key: `${key}.${parts.length}`,
            value: { kind: 'table', table: { header, align, rows } },
        });
        index = end - 1;
    }
    flush();
    return parts.length === 1 && parts[0]?.kind === 'markdown' ? [{ ...parts[0], key }] : parts;
}

/** A page another page links to: in the app, the Page route (or a Space's library). */
export type PageLink =
    | { readonly kind: 'page'; readonly spaceId: string; readonly pageId: string }
    | { readonly kind: 'space'; readonly spaceId: string };

const LINKABLE = /^\/spaces\/([^/?#]+)(?:\/pages\/([^/?#]+))?$/;

function linkOfPath(path: string): PageLink | null {
    const match = LINKABLE.exec(path);
    if (!match) {
        return null;
    }
    try {
        const spaceId = decodeURIComponent(match[1] ?? '');
        const pageId = match[2] === undefined ? null : decodeURIComponent(match[2]);
        if (spaceId === '' || pageId === '') {
            return null;
        }
        return pageId === null ? { kind: 'space', spaceId } : { kind: 'page', spaceId, pageId };
    } catch {
        return null;
    }
}

/**
 * The page or Space a link opens in the app, as the web's `resolveLink` keeps
 * them in the app: on the workspace's origin, `/spaces/:id` and
 * `/spaces/:id/pages/:pageId` with no query or fragment, or the old hash
 * route (`/#/spaces/…`, `#/spaces/…`); null for anything else, which the
 * chat's link rules take.
 */
export function pageLink(href: string | null | undefined, origin: string): PageLink | null {
    const value = href?.trim() ?? '';
    if (value === '' || value.startsWith('//') || value.includes('\\')) {
        return null;
    }
    let url: URL;
    try {
        url = new URL(value, origin);
    } catch {
        return null;
    }
    if (url.origin !== origin || url.search !== '') {
        return null;
    }
    if (url.pathname === '/' && url.hash.startsWith('#/')) {
        return linkOfPath(url.hash.slice(1));
    }
    return url.hash === '' ? linkOfPath(url.pathname) : null;
}

/** A page another links to, by its title as the web shows it. */
export interface PageRef {
    readonly id: string;
    readonly title: string;
    /** A folder (CB-426): its icon. */
    readonly folder?: boolean;
}

/** The folder view's words (the web's `FolderContents`, CB-426). */
export const IN_THIS_FOLDER = 'In this folder';
export const FOLDER_EMPTY = 'This folder is empty.';
export const FOLDER_KEPT_TEXT = 'This folder keeps its page text. Turn it back into a page to see it.';
/** The editor's line for a folder: it has no editor, its text is kept as it was. */
export const FOLDER_NO_EDITOR = 'This is a folder: it has no text to edit. Turn it back into a page to edit it.';

/** What the reader shows of a page. */
export interface PageView {
    readonly title: string;
    /** "Edited Nov 8", or null with nothing to date it. */
    readonly edited: string | null;
    /** The cover's media embed id, or null. */
    readonly coverId: string | null;
    /** The parents, root first. */
    readonly ancestors: readonly PageRef[];
    /** The subpages, by the list's order. */
    readonly children: readonly PageRef[];
    /** The body, or null when the phone holds none; always null for a folder, whose body is hidden. */
    readonly content: string | null;
    /** The excerpt, shown with no body; always empty for a folder. */
    readonly excerpt: string;
    /** A folder (CB-426): the reader lists what it holds, with no editor and no body. */
    readonly folder: boolean;
    /** Whether the server knows folders (it sent the mark): only then may the page be turned into one. */
    readonly foldersKnown: boolean;
    /** A folder that still keeps text from when it was a page (the web's muted line); never the text. */
    readonly keptText: boolean;
}

const titleOf = (page: { readonly title: string }) => page.title.trim() || UNTITLED_PAGE;
const editedDate = dateTimeFormat({ month: 'short', day: 'numeric' });

/**
 * The page from the Space's list (`pages`) and its body, either of which may
 * be missing (a cold start offline has the list; a link may come before it);
 * null when the phone has neither. The newer of the two gives the title and
 * cover, so a list poll that saw an edit shows it before the body is read.
 * A save of the page still waiting on the phone (`pending`, the page save's
 * overlay, from `pendingPageText`) shows its draft over both, so words typed
 * offline are in the reader after Back too.
 */
export function pageView(
    pages: readonly PageSummary[],
    spaceId: string,
    pageId: string,
    body: Page | null,
    pending: { readonly title: string; readonly content: string } | null = null,
    /** A folder toggle of this phone still waiting (page-manage.ts's `pendingFolder`), or null. */
    pendingFolder: boolean | null = null,
): PageView | null {
    const own = pages.filter((page) => page.spaceId === spaceId);
    const summary = own.find((page) => page.id === pageId) ?? null;
    const usable = body !== null && body.spaceId === spaceId && body.id === pageId ? body : null;
    const newest = summary !== null && (usable === null || summary.revision > usable.revision) ? summary : usable;
    if (newest === null) {
        return null;
    }
    const hierarchy = pageHierarchy(own, spaceId);
    const node = summary ?? newest;
    // A folder hides its body (CB-426): the newer copy says whether it is one, a toggle still
    // waiting on the phone over both. A copy with no mark (a server before folders) is a page.
    const folder = pendingFolder ?? isFolder(newest);
    const text = pending?.content ?? usable?.content ?? null;
    return {
        title: titleOf(pending ?? newest),
        edited: newest.updatedAt > 0 ? `Edited ${editedDate.format(newest.updatedAt)}` : null,
        coverId: newest.cover?.id ?? null,
        ancestors: hierarchy.ancestors(node).map((page) => ({ id: page.id, title: titleOf(page) })),
        children:
            summary === null
                ? []
                : hierarchy
                      .children(summary)
                      .map((page) => ({ id: page.id, title: titleOf(page), folder: isFolder(page) })),
        content: folder ? null : text,
        excerpt: folder ? '' : (summary?.excerpt.trim() ?? ''),
        folder,
        foldersKnown: knowsFolders(newest) || knowsFolders(summary) || knowsFolders(usable),
        keptText: folder && text !== null && text.trim() !== '',
    };
}

/** How many rows of a view's result the reader lists (the web's page of a view's table). */
export const VIEW_ROWS_SHOWN = 25;

/** A cell as the reader shows it: the web's `formatCell` for what a result may hold. */
export function cellText(value: ViewQueryResult['rows'][number][number]): string {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return 'Binary data';
    }
    return String(value);
}

const updatedTime = dateTimeFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "Updated Nov 8, 3:04 PM": when the server ran the view's query. */
export const viewUpdated = (result: Pick<ViewQueryResult, 'at'>) => `Updated ${updatedTime.format(result.at)}`;

/** "Showing 25 of 140 rows", or null when every row shows. */
export function viewRowsNote(result: Pick<ViewQueryResult, 'rows' | 'truncated' | 'maxRows'>): string | null {
    const total = result.rows.length;
    if (total <= VIEW_ROWS_SHOWN && !result.truncated) {
        return null;
    }
    return result.truncated
        ? `Showing ${Math.min(total, VIEW_ROWS_SHOWN)} of the first ${total} rows: views stop at ${result.maxRows} rows (or 256 KB).`
        : `Showing ${VIEW_ROWS_SHOWN} of ${total} rows.`;
}

/** A view's bar or line chart as the chat's chart draws it (`socio-chart`'s shape), or a line saying why there is none. */
export function viewChart(
    result: Pick<ViewQueryResult, 'columns' | 'rows'>,
    spec: Pick<ViewSpec, 'display' | 'x' | 'y' | 'title'>,
    datasetName: string,
):
    | {
          readonly version: 1;
          readonly kind: 'bar' | 'line';
          readonly title: string;
          readonly description: string;
          readonly xLabel: string;
          readonly yLabel: string;
          readonly points: { label: string; value: number | null }[];
      }
    | string {
    const { columns, rows } = result;
    const number = (value: unknown) => {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : null;
        }
        if (typeof value === 'boolean') {
            return value ? 1 : 0;
        }
        if (typeof value === 'string' && value.trim() !== '') {
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
        }
        return null;
    };
    const xi = spec.x ? columns.indexOf(spec.x) : 0;
    const yi = spec.y
        ? columns.indexOf(spec.y)
        : columns.findIndex((_, index) => index !== xi && rows.some((row) => number(row[index]) !== null));
    if (xi < 0) {
        return `The query has no column “${spec.x}” for the chart’s x axis.`;
    }
    if (yi < 0) {
        return spec.y
            ? `The query has no column “${spec.y}” for the chart’s values.`
            : 'The query has no column of numbers to chart.';
    }
    const points = rows
        .slice(0, 100)
        .map((row) => ({ label: cellText(row[xi] ?? null) || ' ', value: number(row[yi]) }));
    if (!points.some((point) => point.value !== null)) {
        return `Column “${columns[yi]}” has no numbers to chart.`;
    }
    return {
        version: 1,
        kind: spec.display === 'line' ? 'line' : 'bar',
        title: spec.title || 'Dataset view',
        description: datasetName,
        xLabel: columns[xi] ?? '',
        yLabel: columns[yi] ?? '',
        points,
    };
}
