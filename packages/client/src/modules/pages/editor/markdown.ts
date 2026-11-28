import { Extension, getSchema, type JSONContent } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { MarkdownManager } from '@tiptap/markdown';
import { Fragment, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

import { simpleHtmlToMarkdown } from '@socio/shared/text/simple-html';

import { DatasetViewNode } from './dataset-view-node';
import { EmbedCardNode } from './embed-card-node';
import { PageImageNode } from './page-image-node';

export const documentExtensions = () => [
    // Before StarterKit: their ```dataset-view, ```embed and ```image fences
    // win over the code block.
    DatasetViewNode,
    EmbedCardNode,
    PageImageNode,
    StarterKit.configure({
        underline: false,
        link: { openOnClick: false, autolink: false },
        heading: { levels: [1, 2, 3] },
    }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // After `Markdown` (priority 100) has made the editor's manager.
    Extension.create({
        name: 'markdownWriting',
        priority: 1,
        onBeforeCreate() {
            if (this.editor.markdown) {
                tuneMarkdownWriting(this.editor.markdown);
            }
        },
    }),
];

/** `@tiptap/markdown`'s manager, as far as the tweaks below reach into it. */
interface ManagerInternals {
    encodeTextForMarkdown(text: string, node: JSONContent, parentNode?: JSONContent): string;
    renderNodeToMarkdown(
        node: JSONContent,
        parentNode?: JSONContent,
        index?: number,
        level?: number,
        meta?: Record<string, unknown>,
    ): string;
}
/** Text ending in what GFM may read as a bare link (`https://…`, `www.…`, an email address). */
const URL_BEFORE = /(?:^|\s)\S*(?::\/\/|www\.|@)\S*$/i;
/** Text that ends at the start of a line, indentation aside. */
const LINE_START = /(?:^|\n)[^\S\n]*$/;
/** An `&` the parser would read as the start of an entity (`&lt;`, `&#38;`, `&copy;`). */
const ENTITY_START = /&(?=#?[0-9A-Za-z]+;)/g;
const tunedManagers = new WeakSet<MarkdownManager>();
/**
 * How the editor writes the blocks it serializes, once per manager:
 *
 * - `<` in text as `\<` rather than `&lt;`, and `>` as `\>` at the start of
 *   a line (where it would start a quote), else as it is, not `&gt;`. Right
 *   after something GFM may read as a bare link, they stay `&lt;` and `&gt;`:
 *   a backslash there would become part of the link. `&` is written `&amp;`
 *   only where it would start an entity (`&lt;` typed as text), not in
 *   `AT&T`. Text in code is written as it is.
 * - A hard break inside a paragraph as a backslash and a newline, not two
 *   trailing spaces, which editors and formatters strip. A break with no
 *   text after it, or in a heading or a table cell (whose renderer turns
 *   newlines into `<br>`), keeps the library's two spaces.
 */
export function tuneMarkdownWriting(manager: MarkdownManager) {
    if (tunedManagers.has(manager)) {
        return manager;
    }
    tunedManagers.add(manager);
    const internals = manager as unknown as ManagerInternals;
    const encode = internals.encodeTextForMarkdown.bind(manager);
    internals.encodeTextForMarkdown = (text, node, parentNode) => {
        // The library leaves text in code alone: it returns a probe as it is.
        if (encode('<', node, parentNode) === '<') {
            return text;
        }
        return text
            .replace(/[\\`*_[\]~]/g, '\\$&')
            .replace(ENTITY_START, '&amp;')
            .replace(/[<>]/g, (char: string, at: number, all: string) => {
                const before = all.slice(0, at);
                // Right after a URL, a backslash would be read as part of it (GFM's bare links).
                if (URL_BEFORE.test(before)) {
                    return char === '<' ? '&lt;' : '&gt;';
                }
                // `>` only starts a quote at the start of a line; elsewhere it is plain text.
                return char === '<' || LINE_START.test(before) ? `\\${char}` : char;
            });
    };
    const render = internals.renderNodeToMarkdown.bind(manager);
    // Tables being written: a cell's paragraphs are written as any, then its newlines become <br>.
    let inTable = 0;
    internals.renderNodeToMarkdown = (node, parentNode, index = 0, level = 0, meta = {}) => {
        if (
            node.type === 'hardBreak' &&
            inTable === 0 &&
            parentNode?.type === 'paragraph' &&
            (parentNode.content ?? []).slice(index + 1).some((next) => next.type !== 'hardBreak')
        ) {
            return '\\\n';
        }
        if (node.type !== 'table') {
            return render(node, parentNode, index, level, meta);
        }
        inTable += 1;
        try {
            return render(node, parentNode, index, level, meta);
        } finally {
            inTable -= 1;
        }
    };
    return manager;
}

export const markdownManager = tuneMarkdownWriting(
    new MarkdownManager({
        extensions: documentExtensions(),
    }),
);
const schema = getSchema(documentExtensions());
/**
 * Whether two parsed documents are the same document as the editor holds
 * them. Compared as ProseMirror nodes, not JSON: the parser lists a text's
 * marks in the order the Markdown nested them (`**[a](b)**` is link, then
 * bold), while the schema keeps one order, so the same marks written the
 * other way round (`[**a**](b)`, as the editor saves them) are equal (CB-230).
 */
const sameDocument = (a: JSONContent, b: JSONContent) => schema.nodeFromJSON(a).eq(schema.nodeFromJSON(b));
const allowed = new Set([
    'space',
    'code',
    'heading',
    'table',
    'hr',
    'blockquote',
    'list',
    'list_item',
    'paragraph',
    'text',
    'escape',
    'strong',
    'em',
    'codespan',
    'br',
    'del',
    'link',
    'taskList',
    'taskItem',
]);
/**
 * Why a page needs Markdown source mode, for the web's words
 * (pages:document.source.reasons): extended Markdown, content the editor
 * can't show, formatting that wouldn't survive a round trip, or Markdown it
 * couldn't read.
 */
export type SourceReason = 'extended' | 'unsupported' | 'round-trip' | 'unreadable';

/**
 * Whether the rich editor can open this page. Simple HTML (a <blockquote>)
 * is read as its Markdown equivalent; the stored text is not rewritten
 * until the person edits (CB-201). `reason` is in English, for the app;
 * the web words `code`.
 */
export function inspectMarkdown(stored: string): {
    supported: boolean;
    reason?: string;
    code?: SourceReason;
} {
    const source = simpleHtmlToMarkdown(stored);
    try {
        if (
            /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source) ||
            /^\[\^[^\]]+\]:/m.test(source) ||
            /^\s*(\$\$|:::)/m.test(source)
        ) {
            return {
                supported: false,
                reason: 'This document contains extended Markdown. Source mode preserves it exactly.',
                code: 'extended',
            };
        }
        const tokens = markdownManager.instance.lexer(source);
        let unsupported = false;
        const pending: unknown[] = [tokens];
        while (pending.length) {
            const value = pending.pop();
            if (!value || typeof value !== 'object') {
                continue;
            }
            if (
                'type' in value &&
                typeof value.type === 'string' &&
                (!allowed.has(value.type) ||
                    (value.type === 'heading' &&
                        'depth' in value &&
                        typeof value.depth === 'number' &&
                        value.depth > 3))
            ) {
                unsupported = true;
            }
            pending.push(...Object.values(value));
        }
        if (unsupported) {
            return {
                supported: false,
                reason: 'This document contains images, HTML, or formatting that needs Markdown source mode. Nothing has been changed.',
                code: 'unsupported',
            };
        }
        const parsed = markdownManager.parse(source);
        const restored = markdownManager.parse(markdownManager.serialize(parsed));
        if (!sameDocument(parsed, restored)) {
            return {
                supported: false,
                reason: 'Some formatting cannot be safely round-tripped. Source mode keeps the original document intact.',
                code: 'round-trip',
            };
        }
        return { supported: true };
    } catch {
        return {
            supported: false,
            reason: 'This Markdown needs source mode to preserve its contents.',
            code: 'unreadable',
        };
    }
}

/** Past this many differences between the common ends, the blocks between them are one changed run. */
const BLOCK_DIFF_MAX_EDITS = 2_000;

/** A run of top-level blocks that differs: `a` children [aFrom, aTo) became `b` children [bFrom, bTo). */
export interface ChangedRun {
    aFrom: number;
    aTo: number;
    bFrom: number;
    bTo: number;
}

/**
 * The runs of top-level blocks that differ: a shortest edit script of equal
 * blocks (Myers' diff), so the cost grows with the number of changes, not the
 * document's size. An editor's unchanged blocks are the same node objects
 * from one state to the next, which `eq` compares at once.
 */
export function changedRuns(a: ProseMirrorNode, b: ProseMirrorNode): ChangedRun[] {
    return diffRange(a, b, { aFrom: 0, aTo: a.childCount, bFrom: 0, bTo: b.childCount }, (x, y) => x.eq(y));
}

/**
 * `changedRuns` for a document the editor derived from `a` itself: blocks are
 * first matched as the same node objects, then, within what differs, as
 * equal ones. Of two equal blocks, the one the person kept is the one
 * matched, not its twin they deleted (`__a__` and `**a**` are equal nodes).
 */
function changedRunsKeepingIdentity(a: ProseMirrorNode, b: ProseMirrorNode): ChangedRun[] {
    const whole = { aFrom: 0, aTo: a.childCount, bFrom: 0, bTo: b.childCount };
    return diffRange(a, b, whole, (x, y) => x === y).flatMap((run) => diffRange(a, b, run, (x, y) => x.eq(y)));
}

/** The runs that differ between `a` children [aFrom, aTo) and `b` children [bFrom, bTo), by `same`. */
function diffRange(
    a: ProseMirrorNode,
    b: ProseMirrorNode,
    range: ChangedRun,
    same: (x: ProseMirrorNode, y: ProseMirrorNode) => boolean,
): ChangedRun[] {
    let { aFrom, aTo, bFrom, bTo } = range;
    while (aFrom < aTo && bFrom < bTo && same(a.child(aFrom), b.child(bFrom))) {
        aFrom += 1;
        bFrom += 1;
    }
    while (aTo > aFrom && bTo > bFrom && same(a.child(aTo - 1), b.child(bTo - 1))) {
        aTo -= 1;
        bTo -= 1;
    }
    const rows = aTo - aFrom;
    const cols = bTo - bFrom;
    if (rows === 0 && cols === 0) {
        return [];
    }
    const whole = [{ aFrom, aTo, bFrom, bTo }];
    if (rows === 0 || cols === 0) {
        return whole;
    }
    const equal = (i: number, j: number) => same(a.child(aFrom + i), b.child(bFrom + j));
    const max = rows + cols;
    const limit = Math.min(max, BLOCK_DIFF_MAX_EDITS);
    // furthest[k + max]: how far along `a` the path on diagonal k (i - j) has come.
    const furthest = new Int32Array(2 * max + 2);
    // After each round d, the paths on diagonals -d..d, to walk back from the end.
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= limit && found < 0; d += 1) {
        for (let k = -d; k <= d; k += 2) {
            let i =
                k === -d || (k !== d && furthest[max + k - 1]! < furthest[max + k + 1]!)
                    ? furthest[max + k + 1]!
                    : furthest[max + k - 1]! + 1;
            let j = i - k;
            while (i < rows && j < cols && equal(i, j)) {
                i += 1;
                j += 1;
            }
            furthest[max + k] = i;
            if (i >= rows && j >= cols) {
                found = d;
                break;
            }
        }
        trace.push(furthest.slice(max - d, max + d + 1));
    }
    if (found < 0) {
        return whole;
    }
    // Walk back: the equal pairs, last first.
    const pairs: [number, number][] = [];
    let i = rows;
    let j = cols;
    for (let d = found; d > 0; d -= 1) {
        const previous = trace[d - 1]!;
        const at = (k: number) => previous[k + d - 1]!;
        const k = i - j;
        const from = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const fromI = at(from);
        const fromJ = fromI - from;
        while (i > fromI && j > fromJ) {
            i -= 1;
            j -= 1;
            pairs.push([i, j]);
        }
        i = fromI;
        j = fromJ;
    }
    while (i > 0 && j > 0) {
        i -= 1;
        j -= 1;
        pairs.push([i, j]);
    }
    pairs.reverse();
    const runs: ChangedRun[] = [];
    let lastI = -1;
    let lastJ = -1;
    for (const [pi, pj] of [...pairs, [rows, cols] as [number, number]]) {
        if (pi > lastI + 1 || pj > lastJ + 1) {
            runs.push({ aFrom: aFrom + lastI + 1, aTo: aFrom + pi, bFrom: bFrom + lastJ + 1, bTo: bFrom + pj });
        }
        lastI = pi;
        lastJ = pj;
    }
    return runs;
}

/** A top-level block of the source as the editor read it: its node and where its text is (LF offsets). */
interface SourceBlock {
    /** Null when the block was matched to the loaded document's node instead of parsed on its own. */
    readonly node: JSONContent | null;
    readonly from: number;
    readonly to: number;
}

/** A page's Markdown, read into its top-level blocks, for `preservedMarkdown`. */
interface SourceMap {
    /** The text as given: what untouched blocks and the space between them are copied from. */
    readonly text: string;
    /** The same text with LF line endings, as the parser reads it. */
    readonly normalized: string;
    readonly blocks: readonly SourceBlock[];
    /** For each offset in the LF text, the offset in `text`; null when the two are the same. */
    readonly offsets: Int32Array | null;
    /** The line ending new text is written with: CRLF only when every line of the source ends so. */
    readonly eol: '\n' | '\r\n';
    /** The blocks as a document of each editor's schema (null: they don't fit it). */
    readonly docs: WeakMap<Schema, ProseMirrorNode | null>;
    /** Whether the blocks, read one by one, are known to be the document the whole text reads as. */
    checked: boolean;
    /** The editor's document as loaded, when it is the blocks: its nodes are matched by identity first. */
    loaded: ProseMirrorNode | null;
}

/** A source whose blocks can't be read one by one. */
class SourceUnmapped extends Error {}

/** `@tiptap/markdown`'s blank lines that end a block, which it reads as a space of their own. */
const TRAILING_BLANK_LINES = /\n[^\S\n]*(?:\n[^\S\n]*)+$/;

/** The node types each marked token may read as, for matching tokens to the loaded document's blocks. */
const TOKEN_NODES: Record<string, readonly string[]> = {
    paragraph: ['paragraph'],
    heading: ['heading'],
    hr: ['horizontalRule'],
    code: ['codeBlock', 'datasetView', 'embedCard', 'pageImage'],
    blockquote: ['blockquote'],
    list: ['bulletList', 'orderedList', 'taskList'],
    taskList: ['taskList'],
    table: ['table'],
};

/**
 * Reads the source into its top-level blocks, each with the range of its own
 * text, the way `@tiptap/markdown` parses it: marked's top-level tokens, a
 * block's trailing blank lines split off, and runs of blank lines read as
 * empty paragraphs (zero-width ranges in the blank lines).
 *
 * With `loaded` (the editor's document as it read this source), each block is
 * matched to its node there, in order, by kind: one lexing pass and no parse.
 * The map is then checked, and its document is the editor's own nodes. Else,
 * or when the two don't line up, each block is parsed on its own (null when a
 * token isn't one block), and checked on first use (`checked`).
 */
function readSource(
    manager: MarkdownManager,
    text: string,
    loadedAs?: { doc: ProseMirrorNode; tokens: readonly Token[] | null },
): SourceMap | null {
    const loaded = loadedAs?.doc;
    const normalized = text.replace(/\r\n?/g, '\n');
    let offsets: Int32Array | null = null;
    if (normalized !== text) {
        offsets = new Int32Array(normalized.length + 1);
        let at = 0;
        for (let index = 0; index < normalized.length; index += 1) {
            offsets[index] = at;
            at += text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1;
        }
        offsets[normalized.length] = at;
    }
    let tokens = loadedAs?.tokens ?? null;
    if (!tokens || tokens.map((token) => token.raw).join('') !== normalized) {
        tokens = manager.instance.lexer(normalized);
    }
    if (tokens.map((token) => token.raw).join('') !== normalized) {
        return null;
    }
    // The tokens as @tiptap/markdown's parse sees them (its extractAbsorbedBlankLines).
    const items: { space: boolean; type: string; from: number; to: number; raw: string }[] = [];
    let at = 0;
    tokens.forEach((token, index) => {
        const from = at;
        at += token.raw.length;
        const space = token.type === 'space';
        const trailing = space || tokens[index + 1]?.type === 'space' ? null : TRAILING_BLANK_LINES.exec(token.raw);
        if (trailing) {
            const split = at - trailing[0].length;
            items.push({ space: false, type: token.type, from, to: split, raw: normalized.slice(from, split) });
            items.push({ space: true, type: 'space', from: split, to: at, raw: trailing[0] });
        } else {
            items.push({ space, type: token.type, from, to: at, raw: token.raw });
        }
    });
    // Each block's kind (its token's type, or an empty paragraph) and the range of its own text.
    const spans: { token: string | null; raw: string; from: number; to: number }[] = [];
    let before = false;
    const lastBlock = items.findLastIndex((item) => !item.space);
    items.forEach((item, index) => {
        if (!item.space) {
            // A block's own text, without the blank lines a tokenizer took in around it (the task list's).
            const lead = /^(?:[^\S\n]*\n)*/.exec(item.raw)![0].length;
            const trail = /(?:\n[^\S\n]*)*$/.exec(item.raw.slice(lead))![0].length;
            spans.push({ token: item.type, raw: item.raw, from: item.from + lead, to: item.to - trail });
            before = true;
            return;
        }
        const separators = (item.raw.match(/\n\n/g) ?? []).length;
        const empty = Math.max(separators - (before && index < lastBlock ? 1 : 0), 0);
        for (let count = 0; count < empty; count += 1) {
            const place = Math.min(item.from + 2 * (count + (before ? 1 : 0)), item.to);
            spans.push({ token: null, raw: '', from: place, to: place });
        }
    });
    const crlf = /\r\n/.test(text) && !/(?:^|[^\r])\n/.test(text) && !/\r(?!\n)/.test(text);
    const map = (blocks: SourceBlock[]): SourceMap => ({
        text,
        normalized,
        blocks,
        offsets,
        eol: crlf ? '\r\n' : '\n',
        docs: new WeakMap(),
        checked: false,
        loaded: null,
    });
    const own = loaded ? matchLoaded(spans, loaded) : null;
    // A code block's text may hold the blank lines its range leaves out (a fence never closed): each
    // is read alone and must be its node, else the blocks are read one by one.
    const codeHolds =
        own?.every((node, index) => {
            const { token, from, to } = spans[index]!;
            if (token !== 'code') {
                return true;
            }
            try {
                const [read, ...more] = manager.parse(normalized.slice(from, to)).content ?? [];
                return !!read && more.length === 0 && node.eq(node.type.schema.nodeFromJSON(read));
            } catch {
                return false;
            }
        }) ?? false;
    if (own && codeHolds) {
        const read = map(spans.map(({ from, to }) => ({ node: null, from, to })));
        const base = loaded!.copy(Fragment.fromArray(own));
        read.docs.set(base.type.schema, base);
        read.checked = true;
        read.loaded = base;
        return read;
    }
    return map(
        spans.map(({ token, raw, from, to }) => {
            if (token === null) {
                return { node: { type: 'paragraph', content: [] }, from, to };
            }
            // Blank lines a block took in before a space of its own read as nothing in the whole text.
            const nodes = manager.parse(raw.replace(TRAILING_BLANK_LINES, '')).content ?? [];
            if (nodes.length !== 1) {
                throw new SourceUnmapped();
            }
            return { node: nodes[0]!, from, to };
        }),
    );
}

/**
 * The loaded document's nodes for the source's blocks, in order, when each is
 * of its token's kind (an empty paragraph for blank lines) and only empty
 * paragraphs (the editor's trailing one) are left over. Null otherwise.
 */
function matchLoaded(spans: readonly { token: string | null }[], loaded: ProseMirrorNode) {
    if (loaded.childCount < spans.length) {
        return null;
    }
    const own: ProseMirrorNode[] = [];
    for (let index = 0; index < loaded.childCount; index += 1) {
        const node = loaded.child(index);
        const span = spans[index];
        const empty = node.type.name === 'paragraph' && node.childCount === 0;
        if (!span) {
            if (!empty) {
                return null;
            }
            continue;
        }
        if (span.token === null ? !empty : !TOKEN_NODES[span.token]?.includes(node.type.name)) {
            return null;
        }
        own.push(node);
    }
    return own;
}

/** A token of marked, the lexer `@tiptap/markdown` reads with. */
type Token = ReturnType<MarkdownManager['instance']['lexer']>[number];

const sourceMaps = new WeakMap<MarkdownManager, { source: string; map: SourceMap | null }>();
/** What each editor last loaded: the source, its document then, and the tokens its parse lexed. */
const loadedDocs = new WeakMap<
    MarkdownManager,
    { source: string; doc: ProseMirrorNode; tokens: readonly Token[] | null }
>();
/** The text each manager's parse last lexed, and its tokens: a load's, reused to read its source. */
const lastLexed = new WeakMap<MarkdownManager, { text: string; tokens: readonly Token[] }>();
{
    // Every parse lexes with a lexer from `createLexer` (private): its top-level `lex` is noted.
    const prototype = MarkdownManager.prototype as unknown as { createLexer(): { lex(text: string): Token[] } };
    const create = prototype.createLexer;
    prototype.createLexer = function createLexer(this: MarkdownManager) {
        const lexer = create.call(this);
        const lex = lexer.lex.bind(lexer);
        lexer.lex = (text: string) => {
            const tokens = lex(text);
            lastLexed.set(this, { text, tokens });
            return tokens;
        };
        return lexer;
    };
}

/** The source's map for this manager: the last one read is kept, as an editor saves the same source many times. */
function sourceMap(manager: MarkdownManager, source: string) {
    const cached = sourceMaps.get(manager);
    if (cached?.source === source) {
        return cached.map;
    }
    const loaded = loadedDocs.get(manager);
    let map: SourceMap | null;
    try {
        map = loaded?.source === source ? readSource(manager, source, loaded) : readSource(manager, source);
    } catch {
        map = null;
    }
    sourceMaps.set(manager, { source, map });
    return map;
}

/** Runs `work` once the page is idle (`requestIdleCallback`, else a timer). */
function whenIdle(work: () => void) {
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(work, { timeout: 2_000 });
    } else {
        setTimeout(work, 0);
    }
}

/**
 * Notes the source the editor has just loaded and its document as loaded, for
 * `preservedMarkdown`: no work now (opening costs what it did), and the source
 * is read when the page is idle, or at the first save if that comes first.
 * Call it after every load (the first content, `setContent`, a merge). With
 * `idle: false`, nothing is scheduled: the first save reads it.
 */
export function rememberLoadedMarkdown(editor: MarkdownEditor, source: string, { idle = true } = {}) {
    const manager = editor.markdown;
    if (!manager) {
        return;
    }
    // The load's own tokens, when its parse was of this text: reading the source then lexes nothing.
    const lexed = lastLexed.get(manager);
    const tokens = lexed && lexed.text.replace(/\r\n?/g, '\n') === source.replace(/\r\n?/g, '\n') ? lexed.tokens : null;
    loadedDocs.set(manager, { source, doc: editor.state.doc, tokens });
    if (idle) {
        whenIdle(() => {
            if (loadedDocs.get(manager)?.source === source) {
                sourceMap(manager, source);
            }
        });
    }
}

const isEmptyParagraph = (node: JSONContent | undefined) => node?.type === 'paragraph' && !node.content?.length;

/** The nodes without the empty paragraphs at their end, which hold nothing and the editor adds back. */
function withoutTrailingEmpty(nodes: readonly JSONContent[]) {
    let end = nodes.length;
    while (end > 0 && isEmptyParagraph(nodes[end - 1])) {
        end -= 1;
    }
    return nodes.slice(0, end);
}

/** Whether two runs of top-level nodes are the same blocks (as `sameDocument` compares them). */
const sameBlocks = (a: readonly JSONContent[], b: readonly JSONContent[]) =>
    a.length === b.length && sameDocument({ type: 'doc', content: [...a] }, { type: 'doc', content: [...b] });

/** What `preservedMarkdown` needs of an editor: its document and its Markdown manager. */
export interface MarkdownEditor {
    readonly state: { readonly doc: ProseMirrorNode };
    readonly markdown?: MarkdownManager;
}

/** `@tiptap/markdown`'s `isEmptyOutput`: a document of only empty paragraphs is written as nothing. */
const isEmptyMarkdown = (markdown: string) => markdown.replace(/&nbsp;|\u00A0/g, '').trim() === '';

/**
 * The editor's document as Markdown, keeping the source's own text wherever
 * the person didn't change it. `source` is the Markdown the editor loaded
 * (after `simpleHtmlToMarkdown`). Call `rememberLoadedMarkdown` after each
 * load: the source is then read against the document as loaded, with one
 * lexing pass and no parse, off the open path.
 *
 * The document's top-level blocks are matched with the source's (a shortest
 * edit script of equal nodes, `changedRuns`). Every block that is still there, unchanged, is
 * written as the source wrote it, byte for byte, with the text between such
 * neighbors (blank lines, CRLF, the trailing newline). Only a block the
 * person changed, added or moved is written by the serializer, in the
 * source's line ending. Empty paragraphs added at the very end (the editor's
 * trailing paragraph) write nothing.
 *
 * The result is checked where it changed: the text from the untouched block
 * before each change to the one after it must read back as those blocks of
 * the document. Failing that, the whole text must read as the document, or
 * as the serializer's own text does. When it doesn't, or the source can't be
 * read block by block, the serializer's text is used, as before.
 */
export function preservedMarkdown(editor: MarkdownEditor, source: string): string {
    const manager = editor.markdown;
    if (!manager) {
        throw new Error('The editor has no Markdown extension.');
    }
    tuneMarkdownWriting(manager);
    const doc = editor.state.doc;
    const json = doc.toJSON() as JSONContent;
    const children = json.content ?? [];
    // Each block's Markdown as the serializer writes it within the whole document (its `serialize`).
    const internals = manager as unknown as ManagerInternals;
    const rendered = children.map((child, index) => internals.renderNodeToMarkdown(child, json, index, 0));
    const joined = rendered.join('\n\n');
    const full = isEmptyMarkdown(joined) ? '' : joined;
    const map = sourceMap(manager, source);
    if (!map || map.blocks.length === 0) {
        return full;
    }
    let base = map.docs.get(doc.type.schema);
    if (base === undefined) {
        try {
            // Blocks matched to the loaded document carry no node of their own: that doc is set for its schema.
            base = map.blocks.every((block) => block.node)
                ? doc.type.schema.nodeFromJSON({ type: 'doc', content: map.blocks.map((block) => block.node!) })
                : null;
        } catch {
            base = null;
        }
        map.docs.set(doc.type.schema, base);
    }
    if (!base) {
        return full;
    }
    if (!map.checked) {
        const nodes = map.blocks.map((block) => block.node!);
        // Read against the document as loaded (cheap), else against the whole text read again.
        const loaded = withoutTrailingEmpty(nodes);
        const asLoaded = sameBlocks(loaded, withoutTrailingEmpty(children));
        map.checked = asLoaded || sameBlocks(loaded, withoutTrailingEmpty(manager.parse(map.normalized).content ?? []));
        if (!map.checked) {
            map.docs.set(doc.type.schema, null);
            return full;
        }
        if (asLoaded && doc.childCount >= nodes.length && sameBlocks(nodes, children.slice(0, nodes.length))) {
            // The editor's own nodes (its trailing paragraph aside): those it keeps compare at once.
            const own: ProseMirrorNode[] = [];
            doc.forEach((child, _offset, index) => {
                if (index < nodes.length) {
                    own.push(child);
                }
            });
            base = doc.copy(Fragment.fromArray(own));
            map.docs.set(doc.type.schema, base);
            map.loaded = base;
        }
    }
    const runs = base === map.loaded ? changedRunsKeepingIdentity(base, doc) : changedRuns(base, doc);
    if (runs.length === 0) {
        return map.text;
    }
    // Without the blank lines a renderer puts around its block (a table's): the source's spacing stays.
    const pieces = rendered.map((piece) => piece.replace(/^\n+|\n+$/g, ''));
    const { blocks, text, offsets } = map;
    const original = (at: number) => (offsets ? offsets[at]! : at);
    const n = blocks.length;
    const written = (value: string) => (map.eol === '\r\n' ? value.replace(/\n/g, '\r\n') : value);
    let output = '';
    let cursor = 0;
    /** The source's text copied as it is: [from, to) in the source, at `at` in the output. */
    const copied: { from: number; to: number; at: number }[] = [];
    const copy = (to: number) => {
        copied.push({ from: cursor, to, at: output.length });
        output += text.slice(cursor, to);
    };
    for (const run of runs) {
        let added = pieces.slice(run.bFrom, run.bTo);
        if (run.aTo === n) {
            // The editor's trailing empty paragraph, and any after it, write nothing.
            while (added.length > 0 && added.at(-1) === '') {
                added = added.slice(0, -1);
            }
        }
        let from: number;
        let to: number;
        let replacement: string;
        if (run.aTo > run.aFrom && added.length > 0) {
            from = blocks[run.aFrom]!.from;
            to = blocks[run.aTo - 1]!.to;
            replacement = added.join('\n\n');
        } else if (run.aTo > run.aFrom) {
            // Removed: with the space after them, or before them at the end.
            if (run.aTo < n) {
                from = blocks[run.aFrom]!.from;
                to = blocks[run.aTo]!.from;
            } else if (run.aFrom > 0) {
                from = blocks[run.aFrom - 1]!.to;
                to = blocks[run.aTo - 1]!.to;
            } else {
                return full;
            }
            replacement = '';
        } else if (added.length > 0) {
            if (run.aFrom < n) {
                from = to = blocks[run.aFrom]!.from;
                replacement = `${added.join('\n\n')}\n\n`;
            } else {
                from = to = blocks[n - 1]!.to;
                replacement = `\n\n${added.join('\n\n')}`;
            }
        } else {
            continue;
        }
        copy(original(from));
        output += written(replacement);
        cursor = original(to);
    }
    copy(text.length);
    if (output === full) {
        return full;
    }
    return checkedOutput(manager, { map, runs, children, copied, output, full }) ? output : full;
}

/**
 * Whether the kept text reads back right: each changed stretch, from the
 * untouched block with text before it (or the start) to the one after it (or
 * the end), read on its own, gives those blocks of the document (empty
 * paragraphs at the end aside). Failing that, the whole text must read as
 * the document, or as the serializer's own text does.
 */
function checkedOutput(
    manager: MarkdownManager,
    {
        map,
        runs,
        children,
        copied,
        output,
        full,
    }: {
        map: SourceMap;
        runs: readonly ChangedRun[];
        children: readonly JSONContent[];
        copied: readonly { from: number; to: number; at: number }[];
        output: string;
        /** The serializer's text for the whole document. */
        full: string;
    },
) {
    const { blocks, offsets } = map;
    const original = (at: number) => (offsets ? offsets[at]! : at);
    const n = blocks.length;
    // Each untouched source block's place in the document.
    const inDoc = new Int32Array(n).fill(-1);
    let a = 0;
    let b = 0;
    for (const run of [...runs, { aFrom: n, aTo: n, bFrom: children.length, bTo: children.length }]) {
        while (a < run.aFrom) {
            inDoc[a] = b;
            a += 1;
            b += 1;
        }
        a = run.aTo;
        b = run.bTo;
    }
    // An anchor: an untouched block with text of its own, whose place in the output is known.
    const anchor = (k: number) => inDoc[k]! >= 0 && blocks[k]!.from < blocks[k]!.to;
    const outAt = (k: number, edge: 'from' | 'to') => {
        const at = original(blocks[k]![edge]);
        const from = original(blocks[k]!.from);
        const to = original(blocks[k]!.to);
        const part = copied.find((piece) => piece.from <= from && to <= piece.to);
        return part ? part.at + at - part.from : -1;
    };
    // The stretches to read: [start anchor, end anchor] in source blocks, -1 and n for the ends.
    const stretches: [number, number][] = [];
    for (const run of runs) {
        let start = run.aFrom - 1;
        while (start >= 0 && !anchor(start)) {
            start -= 1;
        }
        let end = run.aTo;
        while (end < n && !anchor(end)) {
            end += 1;
        }
        const last = stretches.at(-1);
        if (last && start <= last[1]) {
            last[1] = Math.max(last[1], end);
        } else {
            stretches.push([start, end]);
        }
    }
    const readsBack = stretches.every(([start, end]) => {
        const from = start < 0 ? 0 : outAt(start, 'from');
        const to = end >= n ? output.length : outAt(end, 'to');
        if (from < 0 || to < 0) {
            return false;
        }
        const expected = children.slice(start < 0 ? 0 : inDoc[start], end >= n ? children.length : inDoc[end]! + 1);
        try {
            const read = manager.parse(output.slice(from, to)).content ?? [];
            return end >= n
                ? sameBlocks(withoutTrailingEmpty(read), withoutTrailingEmpty(expected))
                : sameBlocks(read, expected);
        } catch {
            return false;
        }
    });
    if (readsBack) {
        return true;
    }
    try {
        const read = withoutTrailingEmpty(manager.parse(output).content ?? []);
        if (sameBlocks(read, withoutTrailingEmpty(children))) {
            return true;
        }
        // The serializer's own text may not read back as the document either (two lists in a
        // row read as one): then the kept text must read as that does.
        return sameBlocks(read, withoutTrailingEmpty(manager.parse(full).content ?? []));
    } catch {
        return false;
    }
}
