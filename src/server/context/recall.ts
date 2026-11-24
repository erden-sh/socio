// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import type { Message } from '@ag-ui/client';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { messageText } from '@socio/foundation/turns/media-parts';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { withoutInlineImages } from '@socio/shared/tool-images';

import { INLINE_IMAGE_TOOL, inlineImageNote } from './images.js';

/**
 * `recall` (CB-129): a Dot re-reads what compaction set aside, from the
 * stored conversation, so a stub is only a pointer. A ref is a tool call's
 * id (its result), `<id>:args` (its arguments) or `message:<id>` (a message
 * a search found). Results this turn produced are not stored until the turn
 * ends; compaction hands them over here as it sets them aside. A read by
 * ref is recorded as the turn's grounding (CB-194); a search is not.
 */

/** Characters a page of a long result holds unless compaction says less. */
const DEFAULT_PAGE_CHARS = 12_000;
/** Threads whose current turn's results are kept here. */
const LIVE_THREADS = 32;
const SEARCH_HITS = 8;
const SNIPPET_CHARS = 320;

interface Live {
    originals: Map<string, { tool: string; text: string }>;
    pageChars: number;
}
const live = new Map<string, Live>();

/** Compaction's hand-over: originals it cut or set aside, and the page size that fits. */
export function rememberOriginals(
    threadId: string,
    originals: ReadonlyMap<string, { tool: string; text: string }>,
    pageChars: number,
) {
    let entry = live.get(threadId);
    if (!entry) {
        entry = { originals: new Map(), pageChars };
    }
    live.delete(threadId);
    live.set(threadId, entry);
    entry.pageChars = pageChars;
    for (const [ref, original] of originals) {
        entry.originals.set(ref, original);
    }
    while (live.size > LIVE_THREADS) {
        live.delete(live.keys().next().value!);
    }
}

interface Entry {
    ref: string;
    from: string;
    text: string;
}

/** Everything a thread's stored messages can be recalled by. */
function entriesOf(messages: readonly Message[]): Entry[] {
    const names = new Map<string, string>();
    const entries: Entry[] = [];
    for (const message of messages) {
        if (message.role === 'assistant') {
            const said = typeof message.content === 'string' ? message.content : '';
            if (said.trim()) {
                entries.push({
                    ref: `message:${message.id}`,
                    from: 'Socio',
                    text: said,
                });
            }
            for (const call of message.toolCalls ?? []) {
                names.set(call.id, call.function.name);
                entries.push({
                    ref: `${call.id}:args`,
                    from: `${call.function.name} arguments`,
                    text: call.function.arguments ?? '',
                });
            }
        } else if (message.role === 'tool') {
            entries.push({
                ref: message.toolCallId,
                from: `${names.get(message.toolCallId) ?? 'tool'} result`,
                // An older version's screenshot as base64 is a note (CB-157).
                text:
                    typeof message.content !== 'string'
                        ? ''
                        : names.get(message.toolCallId) === INLINE_IMAGE_TOOL
                          ? withoutInlineImages(message.content, inlineImageNote)
                          : message.content,
            });
        } else if (message.role === 'user') {
            const said = messageText(message.content);
            if (said.trim()) {
                entries.push({
                    ref: `message:${message.id}`,
                    from: 'person',
                    text: said,
                });
            }
        }
    }
    return entries;
}

function snippet(text: string, terms: string[]) {
    const lower = text.toLowerCase();
    const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
    const start = Math.max(0, at - SNIPPET_CHARS / 3);
    return `${start ? '…' : ''}${text.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, ' ')}${start + SNIPPET_CHARS < text.length ? '…' : ''}`;
}

/** The recall tool for one turn, reading the turn's own thread only. */
export function recallTool(
    turn: Pick<DotTurn, 'threadId' | 'check' | 'ref'>,
    storedMessages: (threadId: string) => Promise<Message[]>,
) {
    return defineTool({
        name: 'recall',
        description:
            'Re-read earlier parts of this conversation that were set aside to keep it within the model’s limits. With a ref (from a "call recall with ref …" note, or a search hit), returns that tool result, arguments or message in full, a page at a time (pass offset for the next page). With a query, searches the older messages and tool results by words and returns refs with snippets.',
        parameters: z.object({
            ref: z.string().min(1).max(200).optional(),
            query: z.string().min(1).max(300).optional(),
            offset: z.number().int().min(0).optional(),
        }),
        execute: async ({ ref, query, offset = 0 }) => {
            turn.check();
            if (!ref && !query) {
                return { error: 'Give a ref to read, or a query to search.' };
            }
            const current = live.get(turn.threadId);
            const pageChars = current?.pageChars ?? DEFAULT_PAGE_CHARS;
            const entries = entriesOf(await storedMessages(turn.threadId));
            for (const [key, original] of current?.originals ?? []) {
                if (!entries.some((entry) => entry.ref === key)) {
                    entries.push({
                        ref: key,
                        from: key.endsWith(':args')
                            ? `${original.tool} arguments`
                            : key.startsWith('message:')
                              ? 'person'
                              : `${original.tool} result`,
                        text: original.text,
                    });
                }
            }
            turn.check();
            if (ref) {
                const found = entries.find((entry) => entry.ref === ref.trim());
                if (!found) {
                    return {
                        error: `Nothing in this conversation has the ref ${ref.slice(0, 80)}. Search with a query instead.`,
                    };
                }
                // Grounding (CB-194): what it re-read, by ref, once per turn. Not a
                // Space's: Operations' heatmap leaves recalls out.
                turn.ref?.({ kind: 'recall', spaceId: null, refId: found.ref });
                const text = found.text.slice(offset, offset + pageChars);
                const next = offset + text.length;
                return {
                    ref: found.ref,
                    from: found.from,
                    totalChars: found.text.length,
                    offset,
                    text,
                    ...(next < found.text.length
                        ? {
                              nextOffset: next,
                              note: `More follows: call recall with this ref and offset ${next}.`,
                          }
                        : {}),
                };
            }
            const terms = [
                ...new Set(
                    query!
                        .toLowerCase()
                        .split(/[^\p{L}\p{N}_.-]+/u)
                        .filter((term) => term.length >= 2),
                ),
            ];
            if (!terms.length) {
                return { error: 'The query has no words to search.' };
            }
            const hits = entries
                .map((entry, index) => {
                    const lower = entry.text.toLowerCase();
                    return {
                        entry,
                        index,
                        score: terms.filter((term) => lower.includes(term)).length,
                    };
                })
                .filter((hit) => hit.score > 0)
                // Most terms first, then the newest.
                .sort((a, b) => b.score - a.score || b.index - a.index)
                .slice(0, SEARCH_HITS);
            return {
                query,
                hits: hits.map(({ entry }) => ({
                    ref: entry.ref,
                    from: entry.from,
                    chars: entry.text.length,
                    snippet: snippet(entry.text, terms),
                })),
                ...(hits.length ? {} : { note: 'Nothing earlier in this conversation matches.' }),
            };
        },
    });
}
