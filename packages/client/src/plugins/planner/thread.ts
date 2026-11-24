/**
 * Paragraph packing for auto thread splits, adapted from coollabsio/shoutrrr
 * (Apache-2.0), resources/js/lib/compose/section-split.ts (`packSections`).
 * Length uses Socio's weighted X count instead of UTF-16 length.
 * Copyright Shoutrrr contributors. SPDX-License-Identifier: Apache-2.0
 */
import { X_POST_LIMIT, weightedLength } from '@socio/shared/x-post';

/** Standard X accounts. Every suggested account uses this limit. */
export function accountLimit(_account: string) {
    return X_POST_LIMIT;
}

export interface DraftPart {
    text: string;
    xId: string;
}

/**
 * Split `text` into pieces that fit `limit`. Breaks on whitespace first.
 * A single token longer than the limit is cut by weighted length.
 */
export function splitToLimit(text: string, limit: number) {
    const trimmed = text.trim();
    if (!trimmed) {
        return [''];
    }
    if (weightedLength(trimmed) <= limit) {
        return [trimmed];
    }
    const pieces: string[] = [];
    let rest = trimmed;
    while (rest && weightedLength(rest) > limit && pieces.length < 25) {
        const cut = findCut(rest, limit);
        const next = rest.slice(0, cut).trimEnd();
        if (!next) {
            break;
        }
        pieces.push(next);
        rest = rest.slice(cut).trimStart();
    }
    if (rest) {
        pieces.push(rest);
    }
    return pieces.length ? pieces : [''];
}

function findCut(text: string, limit: number) {
    const words = text.split(/(\s+)/);
    let acc = '';
    for (const word of words) {
        const joined = acc + word;
        if (weightedLength(joined) > limit) {
            break;
        }
        acc = joined;
    }
    if (acc.trim()) {
        return acc.length;
    }
    let lo = 1;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (weightedLength(text.slice(0, mid)) <= limit) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return Math.max(1, lo);
}

/** Expand each part that is over the limit. The first piece keeps the X id. */
export function expandParts(parts: DraftPart[], limit: number) {
    const out: DraftPart[] = [];
    for (const part of parts) {
        const pieces = splitToLimit(part.text, limit);
        pieces.forEach((text, index) => {
            out.push({ text, xId: index === 0 ? part.xId : '' });
        });
    }
    return out.length ? out : parts;
}

/** Next free half-hour between 9:00 and 17:30, or 9:00 the next day. */
export function nextQueueSlot(taken: readonly string[], from: string) {
    const day = from.slice(0, 10);
    const slots: string[] = [];
    for (let hour = 9; hour <= 17; hour += 1) {
        slots.push(`${day}T${String(hour).padStart(2, '0')}:00`);
        slots.push(`${day}T${String(hour).padStart(2, '0')}:30`);
    }
    const used = new Set(taken);
    return slots.find((slot) => slot >= from && !used.has(slot)) ?? slots[0]!;
}
