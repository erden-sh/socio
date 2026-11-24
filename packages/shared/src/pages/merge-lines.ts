/**
 * A three-way merge on Markdown lines, for a page saved on a phone while
 * it changed elsewhere, and for any other titled text (an issue's edits). No dependency, nothing Hermes lacks.
 *
 * Text is cut into units: a line with its own ending (`\n` or `\r\n`, kept
 * as written, and a last line may have none), except that a fenced block
 * holding a dataset view, a link card or a picture (`dataset-view`,
 * `embed`, `image`) is one unit from its opening fence to its closing one
 * (or to the end), at any depth of blockquotes and list items. A merge takes
 * each unit whole from one side, so such a block is never split or stitched
 * from two versions. Fences are read by `findFences` (`fences.ts`), which
 * fails closed: a misread can only make a unit larger, so it can cause an
 * extra conflict but never let two competing edits inside one block merge
 * clean.
 */

import { findFences, textLines } from './fences.js';

/** The fenced blocks a merge treats as one unit. */
export const MERGE_UNIT_FENCES = ['dataset-view', 'embed', 'image'] as const;

/** A unit-level difference past this many edits is taken as one change, to keep time and memory bounded. */
export const MERGE_DIFF_MAX_EDITS = 2000;

const fenceNames: ReadonlySet<string> = new Set(MERGE_UNIT_FENCES);

/**
 * The text's merge units: lines, with each dataset-view, embed or image
 * fence as one, also inside blockquotes and list items. A block runs to its
 * closing fence or, unclosed, to the end of the text.
 */
export function mergeUnits(text: string): string[] {
    const all = textLines(text);
    const out: string[] = [];
    let index = 0;
    for (const fence of findFences(text, (info) => fenceNames.has(info.split(/\s+/)[0]))) {
        out.push(...all.slice(index, fence.open));
        index = (fence.close ?? all.length - 1) + 1;
        out.push(all.slice(fence.open, index).join(''));
    }
    out.push(...all.slice(index));
    return out;
}

/** A run of `a`'s units `[aStart, aEnd)` that became `b`'s `[bStart, bEnd)`. */
interface Region {
    aStart: number;
    aEnd: number;
    bStart: number;
    bEnd: number;
}

/** Myers' O(ND) difference between two id lists, as the changed regions in order. */
function diffRegions(a: readonly number[], b: readonly number[]): Region[] {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) {
        head += 1;
    }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
        tail += 1;
    }
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n === 0 && m === 0) {
        return [];
    }
    const whole = [{ aStart: head, aEnd: head + n, bStart: head, bEnd: head + m }];
    if (n === 0 || m === 0) {
        return whole;
    }
    const limit = Math.min(n + m, MERGE_DIFF_MAX_EDITS);
    const offset = limit + 1;
    const v = new Int32Array(2 * limit + 3);
    const trace: Int32Array[] = [];
    let found = -1;
    for (let d = 0; d <= limit && found < 0; d += 1) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x =
                k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
                    ? v[offset + k + 1]
                    : v[offset + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[head + x] === b[head + y]) {
                x += 1;
                y += 1;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = d;
                break;
            }
        }
    }
    if (found < 0) {
        return whole;
    }
    // Walk back from the end, one edit per step, collecting the matched pairs.
    const pairs: number[] = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d -= 1) {
        const prior = trace[d];
        const k = x - y;
        const down = k === -d || (k !== d && prior[offset + k - 1] < prior[offset + k + 1]);
        const priorK = down ? k + 1 : k - 1;
        const priorX = prior[offset + priorK];
        const priorY = priorX - priorK;
        while (x > (down ? priorX : priorX + 1) && y > (down ? priorY + 1 : priorY)) {
            x -= 1;
            y -= 1;
            pairs.push(x, y);
        }
        x = priorX;
        y = priorY;
    }
    while (x > 0 && y > 0) {
        x -= 1;
        y -= 1;
        pairs.push(x, y);
    }
    const regions: Region[] = [];
    let ai = 0;
    let bi = 0;
    for (let index = pairs.length - 2; index >= -2; index -= 2) {
        const pa = index >= 0 ? pairs[index] : n;
        const pb = index >= 0 ? pairs[index + 1] : m;
        if (pa > ai || pb > bi) {
            regions.push({ aStart: head + ai, aEnd: head + pa, bStart: head + bi, bEnd: head + pb });
        }
        ai = pa + 1;
        bi = pb + 1;
    }
    return regions;
}

/** Ids for units, equal for equal text, shared across every list given. */
function ids(...lists: string[][]) {
    const seen = new Map<string, number>();
    return lists.map((list) =>
        list.map((unit) => {
            let id = seen.get(unit);
            if (id === undefined) {
                id = seen.size;
                seen.set(unit, id);
            }
            return id;
        }),
    );
}

/** One stretch of a line diff: text both have, or text only one has. */
export interface LineChange {
    kind: 'same' | 'removed' | 'added';
    text: string;
}

/**
 * How `b` differs from `a`, unit by unit, for Compare and "See what
 * changed". Joining the `same` and `removed` texts gives `a`; joining the
 * `same` and `added` ones gives `b`. A changed stretch lists what was
 * removed before what was added.
 */
export function lineChanges(a: string, b: string): LineChange[] {
    const ua = mergeUnits(a);
    const ub = mergeUnits(b);
    const [ia, ib] = ids(ua, ub);
    const out: LineChange[] = [];
    const push = (kind: LineChange['kind'], text: string) => {
        if (!text) {
            return;
        }
        const last = out[out.length - 1];
        if (last?.kind === kind) {
            last.text += text;
        } else {
            out.push({ kind, text });
        }
    };
    let at = 0;
    for (const region of diffRegions(ia, ib)) {
        push('same', ua.slice(at, region.aStart).join(''));
        push('removed', ua.slice(region.aStart, region.aEnd).join(''));
        push('added', ub.slice(region.bStart, region.bEnd).join(''));
        at = region.aEnd;
    }
    push('same', ua.slice(at).join(''));
    return out;
}

/**
 * A stretch of the base that changed on one side or both: `ours` or
 * `theirs` when only that side changed it (that side's text was taken),
 * `both` when both made the same change, and `conflict` when they made
 * different ones. Texts are whole units, endings included.
 */
export interface MergeHunk {
    kind: 'ours' | 'theirs' | 'both' | 'conflict';
    base: string;
    ours: string;
    theirs: string;
}

/**
 * A merge's outcome. When clean, `text` is the merge. When not, `text` is
 * `ours` unchanged, so nothing of this side's is lost or half-merged; the
 * `conflict` hunks say where the sides disagree.
 */
export interface MergeResult {
    clean: boolean;
    text: string;
    hunks: MergeHunk[];
}

/**
 * The three-way merge of two edits of `base`, on lines (fenced blocks
 * whole). Changes from the two sides that overlap or touch (adjacent lines,
 * or two insertions at one place) form one hunk, clean only if both sides
 * wrote the same text there, as in git.
 */
export function mergeLines(base: string, ours: string, theirs: string): MergeResult {
    if (ours === theirs) {
        return { clean: true, text: ours, hunks: ours === base ? [] : [{ kind: 'both', base, ours, theirs }] };
    }
    const ub = mergeUnits(base);
    const uo = mergeUnits(ours);
    const ut = mergeUnits(theirs);
    const [ib, io, it] = ids(ub, uo, ut);
    const sides = [diffRegions(ib, io), diffRegions(ib, it)];
    const units = [uo, ut];
    const next = [0, 0];
    // Each side's index minus the base's, past the regions already used.
    const shift = [0, 0];
    const hunks: MergeHunk[] = [];
    const text: string[] = [];
    let clean = true;
    let at = 0;
    while (next[0] < sides[0].length || next[1] < sides[1].length) {
        const first = (side: number) => sides[side][next[side]]?.aStart ?? Number.POSITIVE_INFINITY;
        const start = Math.min(first(0), first(1));
        // Regions that overlap or touch, from either side, form one hunk.
        let end = start;
        const taken: Region[][] = [[], []];
        let grew = true;
        while (grew) {
            grew = false;
            for (const side of [0, 1]) {
                const region = sides[side][next[side]];
                if (region && region.aStart <= end) {
                    taken[side].push(region);
                    next[side] += 1;
                    end = Math.max(end, region.aEnd);
                    grew = true;
                }
            }
        }
        text.push(ub.slice(at, start).join(''));
        const span = [0, 1].map((side) => {
            const regions = taken[side];
            if (!regions.length) {
                return units[side].slice(start + shift[side], end + shift[side]).join('');
            }
            const firstRegion = regions[0];
            const lastRegion = regions[regions.length - 1];
            const from = firstRegion.bStart - (firstRegion.aStart - start);
            const to = lastRegion.bEnd + (end - lastRegion.aEnd);
            shift[side] = lastRegion.bEnd - lastRegion.aEnd;
            return units[side].slice(from, to).join('');
        });
        const hunk = { base: ub.slice(start, end).join(''), ours: span[0], theirs: span[1] };
        if (!taken[1].length) {
            hunks.push({ kind: 'ours', ...hunk });
            text.push(hunk.ours);
        } else if (!taken[0].length) {
            hunks.push({ kind: 'theirs', ...hunk });
            text.push(hunk.theirs);
        } else if (hunk.ours === hunk.theirs) {
            hunks.push({ kind: 'both', ...hunk });
            text.push(hunk.ours);
        } else {
            hunks.push({ kind: 'conflict', ...hunk });
            clean = false;
        }
        at = end;
    }
    text.push(ub.slice(at).join(''));
    return { clean, text: clean ? text.join('') : ours, hunks };
}

/** A text with a one-line title: a page (`content`) or an issue (`description`), mapped by the caller. */
export interface TitledText {
    title: string;
    body: string;
}

/** A title merged on its own: one side's change wins, the same change is clean, two different changes aren't (ours kept). */
export function mergeTitle(base: string, ours: string, theirs: string) {
    if (ours === theirs || theirs === base) {
        return { clean: true, title: ours };
    }
    if (ours === base) {
        return { clean: true, title: theirs };
    }
    return { clean: false, title: ours };
}

/**
 * A titled text merged: the title on its own, the body on lines. Clean only
 * if both are; `titleClean` and `body.clean` say which wasn't. When not
 * clean, the title and the body text are ours wherever a conflict is.
 */
export function mergeTitledText(base: TitledText, ours: TitledText, theirs: TitledText) {
    const title = mergeTitle(base.title, ours.title, theirs.title);
    const body = mergeLines(base.body, ours.body, theirs.body);
    return { clean: title.clean && body.clean, title: title.title, titleClean: title.clean, body };
}
