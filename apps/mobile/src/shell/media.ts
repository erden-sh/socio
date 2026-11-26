import { dateTimeFormat } from '@socio/shared/locale';
import {
    attachmentContentUrl,
    type AttachmentView,
    type MediaItem,
    type MediaKind,
    type MediaListing,
    mediaContentUrl,
} from '@socio/shared/media-types';
import { formatSize } from '@socio/shared/text/format-size';

import type { SymbolName } from '../ui/symbols';

// Media (CB-558), the web's MediaPage, MediaGrid, MediaList and MediaPreview on
// a phone, with no React Native: tests/shell runs them under Node.
// - The list is one folder of the person's own files, as `/api/media` answers
//   it: its subfolders, then its files newest first, in a grid or a list, with
//   the web's kind filter, search (which looks under the whole folder) and
//   "Load more". A folder opens as a page of its own (drill-in), so Back is the
//   breadcrumb.
// - A file's page previews it by kind and says what the web's preview says
//   (type, size, where it was attached, who saved it, when), with Share and
//   Save in place of the web's Download. It opens by library item, by chat
//   attachment (a file chip in a chat or room) or by issue attachment.
// - Upload, move, rename, delete, new folders and folder access are the web's
//   for now (a follow-up brings them).
// Never "Dot" in copy: the person's agents are socios.

export const MEDIA_TITLE = 'Media';
/** The web's page description, without the drop and drag lines a phone has no use for. */
export const MEDIA_INTRO = 'Files you and your socios keep, and what you attached in chats.';
export const MEDIA_LOAD_FAILED = 'Could not load your files.';
export const MEDIA_MORE_FAILED = 'Could not load more files.';
export const MEDIA_OFFLINE = 'Your files show once you’re online.';
export const MEDIA_NOTHING_MATCHES = 'Nothing matches.';
export const MEDIA_EMPTY = 'No files here yet.';
export const MEDIA_SEARCH_OFFLINE = 'Search needs a connection.';
export const LOAD_MORE = 'Load more';
export const TRY_AGAIN = 'Try again';

/** The web's kind filter, in its order. */
export const MEDIA_KINDS: readonly { readonly value: MediaKind | ''; readonly label: string }[] = [
    { value: '', label: 'All' },
    { value: 'image', label: 'Images' },
    { value: 'text', label: 'Text' },
    { value: 'pdf', label: 'PDFs' },
    { value: 'file', label: 'Other' },
];

export const kindLabel = (kind: MediaKind | '') => MEDIA_KINDS.find((entry) => entry.value === kind)?.label ?? 'All';

/** The two layouts, the web's Grid and List. */
export type MediaLayout = 'grid' | 'list';
export const MEDIA_LAYOUTS: readonly { readonly value: MediaLayout; readonly label: string }[] = [
    { value: 'grid', label: 'Grid' },
    { value: 'list', label: 'List' },
];
/** The scope's `kv` key for the layout the person last chose. */
export const MEDIA_LAYOUT_KEY = 'media.layout';
export const mediaLayout = (value: string | null | undefined): MediaLayout => (value === 'list' ? 'list' : 'grid');

/** `reports/q3/` → `q3`; '' for the root. */
export const folderName = (folder: string) => folder.slice(0, -1).split('/').pop() ?? '';

/** `reports/q3/` → `reports/`; '' at the root. */
export function parentFolder(folder: string) {
    const trimmed = folder.slice(0, -1);
    const slash = trimmed.lastIndexOf('/');
    return slash < 0 ? '' : trimmed.slice(0, slash + 1);
}

/** `dots/<id>/` for a socio's own folder, else undefined. */
export const socioFolderId = (folder: string) => /^dots\/([^/]+)\/$/.exec(folder)?.[1];

export type SocioName = (id: string) => string | undefined;

/**
 * A folder as people read it (the web's `folderLabel`): the root is "All files", `attachments/` is
 * "Chat attachments", a socio's folder carries the socio's name.
 */
export function folderLabel(folder: string, socioName: SocioName): string {
    if (folder === '') {
        return 'All files';
    }
    if (folder === 'attachments/') {
        return 'Chat attachments';
    }
    if (folder === 'dots/') {
        return 'Socios';
    }
    const socioId = socioFolderId(folder);
    if (socioId !== undefined) {
        return socioName(socioId) ?? 'A deleted socio';
    }
    return folderName(folder);
}

/** The folders from the root down to `folder`, as the web's breadcrumbs list them: `a/`, `a/b/`. */
export function folderCrumbs(folder: string): string[] {
    if (folder === '') {
        return [];
    }
    const parts = folder.slice(0, -1).split('/');
    return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`);
}

/** The page's first line: the module's description at the root, the folder's place under it. */
export function mediaIntro(folder: string, socioName: SocioName): string {
    if (folder === '') {
        return MEDIA_INTRO;
    }
    return ['All files', ...folderCrumbs(folder).map((crumb) => folderLabel(crumb, socioName))].join(' › ');
}

export const searchLabel = (folder: string) => (folder === '' ? 'Search files' : 'Search this folder');

/** A folder param as the server takes it: '' for the root, else ending in one `/`. */
export function folderParam(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed === '' ? '' : `${trimmed}/`;
}

/** The web's usage line under its bar: how much of the person's space is used. */
export function usageView(listing: Pick<MediaListing, 'usage' | 'limits'>): { share: number; line: string } {
    const used = listing.usage.totalBytes;
    const max = listing.limits.userMaxBytes;
    const share = Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
    return { share, line: `${formatSize(used)} of ${formatSize(max)} used (${share}%)` };
}

/** The picture types the app draws (the server serves these inline): the image cache's. */
const PICTURE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The type as people say it (the web's `typeLabel`): PNG, Markdown, PDF, or the media type. */
export function typeLabel(mediaType: string): string {
    const type = mediaType.split(';')[0] ?? '';
    const known: Record<string, string> = {
        'text/markdown': 'Markdown',
        'text/plain': 'Text',
        'text/csv': 'CSV',
        'application/json': 'JSON',
        'application/pdf': 'PDF',
        'application/octet-stream': 'File',
    };
    const label = known[type];
    if (label !== undefined) {
        return label;
    }
    if (type.startsWith('image/')) {
        return type.slice(6).replace('svg+xml', 'SVG').toUpperCase();
    }
    if (type.startsWith('text/x-')) {
        return type.slice(7);
    }
    return type === '' ? 'File' : type;
}

/** The icon for a file that isn't drawn as a picture (the web's `typeIcon`), by the app's symbol names. */
export function typeSymbol(file: { readonly kind: MediaKind; readonly mediaType: string }): SymbolName {
    const type = file.mediaType;
    if (file.kind === 'pdf') {
        return 'file-text';
    }
    if (/csv|tab-separated|spreadsheet|excel/.test(type)) {
        return 'table';
    }
    if (/zip|tar|gzip|7z|rar|compressed|bzip/.test(type)) {
        return 'archive';
    }
    if (/^text\/x-|json|xml|yaml|javascript|html/.test(type)) {
        return 'file-code';
    }
    if (type.startsWith('image/')) {
        return 'image';
    }
    if (file.kind === 'text') {
        return 'file-text';
    }
    return 'file';
}

/** "Nov 8, 2026, 3:45 PM": the web's `formatTime` (medium date, short time). */
export const mediaTime = (at: number, timeZone?: string): string =>
    dateTimeFormat({
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(at));

/** Who saved a file: the person, a socio by name, or a socio that is gone. */
export const savedBy = (item: Pick<MediaItem, 'createdByDotId' | 'dotName'>) =>
    item.createdByDotId === null ? 'You' : (item.dotName ?? 'A deleted socio');

/** Where a file came from (the web's AttachedFrom): its words, and the chat it opens, if any. */
export interface AttachedFrom {
    readonly label: string;
    readonly threadId: string | null;
}

export function attachedFrom(item: Pick<MediaItem, 'attachments'>): AttachedFrom | null {
    const from = item.attachments[0];
    if (from === undefined) {
        return null;
    }
    if (from.source === 'telegram' && from.threadTitle === null) {
        return { label: 'Telegram', threadId: null };
    }
    if (from.threadId === null) {
        return { label: 'A chat not sent yet', threadId: null };
    }
    if (from.threadTitle === null) {
        return { label: 'A deleted conversation', threadId: null };
    }
    return {
        label: `${from.threadTitle}${from.dotName === null ? '' : ` · ${from.dotName}`}${from.source === 'telegram' ? ' (Telegram)' : ''}`,
        threadId: from.threadId,
    };
}

export interface MediaFolderRow {
    readonly path: string;
    readonly label: string;
    readonly testID: string;
}

export interface MediaFileRow {
    readonly id: string;
    readonly name: string;
    /** The grid's line: its size. */
    readonly size: string;
    /** The list's line: type, size and when it changed. */
    readonly line: string;
    /** The list's second line: where it was attached and who saved it, when not just the person. */
    readonly note: string | null;
    /** A picture the grid draws; other files draw `symbol`. */
    readonly picture: boolean;
    readonly symbol: SymbolName;
    readonly updatedAt: number;
    readonly accessibilityLabel: string;
    readonly testID: string;
    readonly item: MediaItem;
}

const slug = (text: string) =>
    text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

export function folderRows(folders: readonly string[], socioName: SocioName): MediaFolderRow[] {
    return folders.map((path) => ({
        path,
        label: folderLabel(path, socioName),
        testID: `media-folder-${slug(path)}`,
    }));
}

export function fileRow(item: MediaItem, timeZone?: string): MediaFileRow {
    const type = typeLabel(item.mediaType);
    const size = formatSize(item.size);
    const from = attachedFrom(item);
    const by = savedBy(item);
    const notes = [from === null ? null : `From ${from.label}`, by === 'You' ? null : `Saved by ${by}`].filter(
        (part): part is string => part !== null,
    );
    return {
        id: item.id,
        name: item.name,
        size,
        line: `${type} · ${size} · ${mediaTime(item.updatedAt, timeZone)}`,
        note: notes.length === 0 ? null : notes.join(' · '),
        picture: item.kind === 'image' && PICTURE_TYPES.has(item.mediaType),
        symbol: typeSymbol(item),
        updatedAt: item.updatedAt,
        accessibilityLabel: `Open ${item.name}, ${type}, ${size}`,
        testID: `media-file-${slug(item.name)}`,
        item,
    };
}

/** What the list shows, or why it shows nothing. */
export type MediaListState =
    | { readonly state: 'loading' }
    | { readonly state: 'failed'; readonly line: string }
    | { readonly state: 'empty'; readonly line: string }
    | { readonly state: 'rows' };

/**
 * The list's state from what is held: rows as soon as there is a listing with something in it, the
 * web's two empty lines, a wait before the first answer, and a failure only with nothing to show.
 */
export function mediaListState(input: {
    readonly listing: MediaListing | null;
    readonly settled: boolean;
    readonly failed: boolean;
    readonly searching: boolean;
    readonly kind: MediaKind | '';
    readonly files: number;
}): MediaListState {
    const { listing } = input;
    if (listing === null) {
        if (input.failed) {
            return { state: 'failed', line: input.searching ? MEDIA_SEARCH_OFFLINE : MEDIA_OFFLINE };
        }
        return input.settled ? { state: 'failed', line: MEDIA_LOAD_FAILED } : { state: 'loading' };
    }
    // A search lists no folders (the web's `q ? [] : listing.folders`).
    const folders = input.searching ? 0 : listing.folders.length;
    if (input.files === 0 && folders === 0) {
        return {
            state: 'empty',
            line: input.searching || input.kind !== '' ? MEDIA_NOTHING_MATCHES : MEDIA_EMPTY,
        };
    }
    return { state: 'rows' };
}

// ---- the file page ---------------------------------------------------------

/** What the file page opens: a library item, a chat attachment, or an issue's attachment. */
export type MediaFileSource =
    | { readonly kind: 'item'; readonly id: string }
    | { readonly kind: 'attachment'; readonly id: string }
    | { readonly kind: 'issue'; readonly id: string };

/** What a caller already knows of the file, so its page draws before any answer. */
export type MediaFileHint = {
    readonly name?: string;
    readonly mediaType?: string;
    readonly size?: number;
    readonly updatedAt?: number;
};

/** The file page's route params: one source id, and the hint. A type, so it is a route's params. */
export type MediaFileParams = MediaFileHint & {
    readonly item?: string;
    readonly attachment?: string;
    readonly issueFile?: string;
};

export function fileSource(params: MediaFileParams): MediaFileSource | null {
    if (typeof params.item === 'string' && params.item !== '') {
        return { kind: 'item', id: params.item };
    }
    if (typeof params.attachment === 'string' && params.attachment !== '') {
        return { kind: 'attachment', id: params.attachment };
    }
    if (typeof params.issueFile === 'string' && params.issueFile !== '') {
        return { kind: 'issue', id: params.issueFile };
    }
    return null;
}

/** How the page shows a file: a picture, text, or a file another app opens (a PDF, anything else). */
export type PreviewKind = 'image' | 'text' | 'pdf' | 'other';

export function previewKind(file: { readonly kind?: MediaKind | undefined; readonly mediaType: string }): PreviewKind {
    const type = (file.mediaType.split(';')[0] ?? '').trim().toLowerCase();
    if (PICTURE_TYPES.has(type) && (file.kind === undefined || file.kind === 'image')) {
        return 'image';
    }
    if (file.kind === 'pdf' || type === 'application/pdf') {
        return 'pdf';
    }
    if (file.kind === 'text' || (file.kind === undefined && type.startsWith('text/'))) {
        return 'text';
    }
    return 'other';
}

export interface FileDetail {
    readonly label: string;
    readonly value: string;
    /** A chat the row opens (the web's From link). */
    readonly threadId?: string;
    /** A library folder the row opens. */
    readonly folder?: string;
    readonly testID: string;
}

/** A file as its page shows it, from whichever record the page read. */
export interface MediaFileView {
    readonly name: string;
    readonly mediaType: string;
    /** -1 when not known yet. */
    readonly size: number;
    readonly preview: PreviewKind;
    readonly symbol: SymbolName;
    /** Where its bytes are on the workspace. */
    readonly url: string;
    /** The file cache's key: what it is and which version. */
    readonly cacheKey: string;
    readonly details: readonly FileDetail[];
}

const sizeDetail = (size: number): FileDetail[] =>
    size < 0 ? [] : [{ label: 'Size', value: formatSize(size), testID: 'media-file-size' }];

const typeDetail = (mediaType: string): FileDetail => {
    const label = typeLabel(mediaType);
    return {
        label: 'Type',
        value: label === mediaType || mediaType === '' ? label : `${label} (${mediaType})`,
        testID: 'media-file-type',
    };
};

/**
 * A library item's page: the web's MediaPreview rows. Opened by a chat attachment (`attachmentId`),
 * its bytes stay the attachment's (its path and cache key), so the copy the page began to
 * download as the attachment is the one it shows.
 */
export function itemFileView(
    item: MediaItem,
    socioName: SocioName,
    timeZone?: string,
    attachmentId?: string,
): MediaFileView {
    const from = attachedFrom(item);
    return {
        name: item.name,
        mediaType: item.mediaType,
        size: item.size,
        preview: previewKind(item),
        symbol: typeSymbol(item),
        url: attachmentId === undefined ? mediaContentUrl(item.id) : attachmentContentUrl(attachmentId),
        cacheKey:
            attachmentId === undefined
                ? `item-${item.id}-${Math.max(0, Math.floor(item.updatedAt))}`
                : `att-${attachmentId}`,
        details: [
            typeDetail(item.mediaType),
            ...sizeDetail(item.size),
            ...(from === null
                ? []
                : [
                      {
                          label: 'From',
                          value: from.label,
                          ...(from.threadId === null ? {} : { threadId: from.threadId }),
                          testID: 'media-file-from',
                      },
                  ]),
            { label: 'Saved by', value: savedBy(item), testID: 'media-file-saved-by' },
            { label: 'Updated', value: mediaTime(item.updatedAt, timeZone), testID: 'media-file-updated' },
            {
                label: 'In Media',
                value: folderLabel(item.folder, socioName),
                folder: item.folder,
                testID: 'media-file-folder',
            },
        ],
    };
}

/** The chat a thread id names, for an attachment's From row: its title, or null when the phone holds none. */
export type ChatTitle = (threadId: string) => string | null;

/**
 * A chat attachment's page, when the library has no item for it (someone else's file in a room, or
 * one not in the person's files): what the attachment's own record says.
 */
export function attachmentFileView(attachment: AttachmentView, chatTitle: ChatTitle, timeZone?: string): MediaFileView {
    const kind: MediaKind =
        attachment.kind === 'file' && attachment.mediaType === 'application/pdf' ? 'pdf' : attachment.kind;
    const file = { kind, mediaType: attachment.mediaType };
    const title = attachment.threadId === null ? null : chatTitle(attachment.threadId);
    return {
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.size,
        preview: previewKind(file),
        symbol: typeSymbol(file),
        url: attachmentContentUrl(attachment.id),
        cacheKey: `att-${attachment.id}`,
        details: [
            typeDetail(attachment.mediaType),
            ...sizeDetail(attachment.size),
            ...(attachment.threadId === null || title === null
                ? []
                : [{ label: 'From', value: title, threadId: attachment.threadId, testID: 'media-file-from' }]),
            { label: 'Attached', value: mediaTime(attachment.createdAt, timeZone), testID: 'media-file-updated' },
        ],
    };
}

export const issueFileUrl = (id: string) => `/api/issue-attachments/${encodeURIComponent(id)}`;

/** The view from the hint alone: before the record answers, and all an issue's attachment has. */
export function hintFileView(source: MediaFileSource, hint: MediaFileHint): MediaFileView {
    const mediaType = hint.mediaType ?? '';
    const size = hint.size ?? -1;
    const file = { mediaType };
    const kind = previewKind(file);
    return {
        name: hint.name ?? 'File',
        mediaType,
        size,
        preview: kind,
        symbol: typeSymbol({ kind: kind === 'image' ? 'image' : kind === 'other' ? 'file' : kind, mediaType }),
        url:
            source.kind === 'item'
                ? mediaContentUrl(source.id)
                : source.kind === 'attachment'
                  ? attachmentContentUrl(source.id)
                  : issueFileUrl(source.id),
        cacheKey:
            source.kind === 'item'
                ? `item-${source.id}-${Math.max(0, Math.floor(hint.updatedAt ?? 0))}`
                : source.kind === 'attachment'
                  ? `att-${source.id}`
                  : `issue-${source.id}`,
        details: [...(mediaType === '' ? [] : [typeDetail(mediaType)]), ...sizeDetail(size)],
    };
}

export const FILE_GONE = 'This file was removed.';
export const FILE_GONE_LINE = 'It may have been deleted, or it isn’t shared with you.';
export const FILE_OFFLINE = 'This file shows once you’re online.';
export const FILE_TOO_LARGE = 'This file is too large to open here.';
export const FILE_DOWNLOADING = 'Downloading…';
/** The web's "No preview for this file. Download it to open it on your device.", in the phone's words. */
export const NO_PREVIEW = 'No preview for this file. Open it in another app, or save it to your phone.';
export const PREVIEW_FAILED = 'The preview could not be loaded.';
/** The web's text preview shows this much; the rest is a save away. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;
export const TEXT_PREVIEW_MORE = '(The first 256 KB. Save it for the rest.)';
export const OPEN_FILE = 'Open';
export const SHARE_FILE = 'Share';
export const SAVE_FILE = 'Save';
export const NO_APP_OPENS = 'No app on this phone opens this file. You can still share or save it.';
export const SHARE_UNAVAILABLE = 'Sharing isn’t available on this phone.';
export const SAVE_FAILED = 'Could not save the file.';
export const OPEN_FAILED = 'Could not open the file.';
export const SHARE_FAILED = 'Could not share the file.';
export const savedLine = (name: string) => `Saved ${name}.`;

/** The file page's actions. */
export type FileAction = 'open' | 'share' | 'save';

/**
 * What an action came to: the system's answer, or `no-copy` when the page's copy was gone and could
 * not be downloaded again first.
 */
export type ActionOutcome =
    | 'no-copy'
    | 'shown'
    | 'no-app'
    | 'unavailable'
    | 'shared'
    | 'failed'
    | 'saved'
    | 'cancelled';

/** The line under the actions after one, and whether it offers Try again: null when there is nothing to say. */
export interface ActionNotice {
    readonly line: string;
    /** The action Try again runs, or null when trying again can't help (no app takes the type). */
    readonly retry: FileAction | null;
}

export function actionNotice(action: FileAction, outcome: ActionOutcome, name: string): ActionNotice | null {
    if (outcome === 'no-copy') {
        return { line: FILE_OFFLINE, retry: action };
    }
    switch (action) {
        case 'open':
            return outcome === 'shown'
                ? null
                : outcome === 'no-app'
                  ? { line: NO_APP_OPENS, retry: null }
                  : { line: OPEN_FAILED, retry: 'open' };
        case 'share':
            return outcome === 'shared'
                ? null
                : outcome === 'unavailable'
                  ? { line: SHARE_UNAVAILABLE, retry: null }
                  : { line: SHARE_FAILED, retry: 'share' };
        case 'save':
            return outcome === 'saved'
                ? { line: savedLine(name), retry: null }
                : outcome === 'cancelled'
                  ? null
                  : { line: SAVE_FAILED, retry: 'save' };
    }
}

/** What the file page's bytes are doing, as its actions and preview read it. */
export type FileBytes =
    | { readonly state: 'loading' }
    | { readonly state: 'ready'; readonly uri: string }
    | { readonly state: 'gone' }
    | { readonly state: 'too-large' }
    | { readonly state: 'failed' };

/** The line the page says in place of a preview while it has no copy, or null when it has one. */
export function bytesLine(bytes: FileBytes): string | null {
    switch (bytes.state) {
        case 'ready':
            return null;
        case 'loading':
            return FILE_DOWNLOADING;
        case 'gone':
            return FILE_GONE;
        case 'too-large':
            return FILE_TOO_LARGE;
        case 'failed':
            return FILE_OFFLINE;
    }
}
