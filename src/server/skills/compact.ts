// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { convertInputToTanStackAI } from '@copilotkit/runtime/v2';
import type { TextOptions } from '@tanstack/ai';
import { resolveDebugOption } from '@tanstack/ai/adapter-internals';

import { withTimeMarkers } from '@socio/foundation/context/time-markers';
import { modelDebug, reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { withoutSkillActions } from '@socio/foundation/skills/skill-actions';
import { modelReadableMessages } from '@socio/foundation/turns/media-parts';

import type { ContextFittingShape } from '../context/contract.js';

import type { CompactShape, CompactTurn } from './contract.js';

const FAILED =
    'This chat couldn’t be compacted just now. Nothing changed; it still compacts on its own when it grows long.';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * `/compact`: folds the conversation's earlier turns into its notes now
 * (the fitting's `compactNow`), from the conversation as the Dot's next
 * turn will send it (the same messages, attachments and time markers,
 * without action skills' turns), and says what it did. Only what the
 * notes' model summarized is kept: never the plain fallback an automatic
 * fold keeps when a summary fails. It never fails the chat: a failure is
 * said as the answer, and the chat stays as it was (or as far as it got,
 * said so). Only a stop ends it.
 *
 * Over the context's fitting (`ContextFitting`), as the `Compact` tag
 * offers it (`layer.ts`). The callers that don't reach it through the tag
 * yet (`dots/dot-agent.ts`) hand it `context/fit.ts`'s
 * `compactNow` themselves.
 */
export const compactWith = (fitting: Pick<ContextFittingShape, 'compactNow'>): CompactShape => ({
    compact: (turn) => compactThrough(fitting, turn),
});

async function compactThrough(fitting: Pick<ContextFittingShape, 'compactNow'>, turn: CompactTurn): Promise<string> {
    try {
        const messages = withoutSkillActions(
            turn.messages.filter((message) => message.role !== 'system' && message.role !== 'developer'),
        );
        const readable = modelReadableMessages(turn.resolve ? await turn.resolve(messages) : messages, turn.maxImages);
        const converted = convertInputToTanStackAI({
            ...turn.input,
            messages: readable,
            tools: [],
        });
        // Only the markers the conversation was told: a new one would change
        // a message the next turn sends as it was.
        const userIds = readable.filter((message) => message.role === 'user').map((message) => message.id);
        const stored = turn.markers.all(turn.input.threadId, turn.fit.shared);
        const result = await fitting.compactNow(turn.adapter, turn.fit, {
            model: turn.model,
            modelOptions: turn.modelOptions,
            messages: withTimeMarkers(converted.messages, userIds, stored),
            systemPrompts: [],
            tools: [],
            request: { signal: turn.signal },
            threadId: turn.input.threadId,
            logger: resolveDebugOption(modelDebug),
        } as TextOptions);
        if (result.stopped && !result.folded) {
            return FAILED;
        }
        if (result.folded) {
            return `Compacted: ${plural(result.folded, 'earlier turn')} folded into this chat’s notes.${result.left ? ` ${plural(result.left, 'more')} couldn’t be summarized just now: send /compact again to fold ${result.left === 1 ? 'it' : 'them'}.` : ''}`;
        }
        return result.turns
            ? 'Nothing new to compact: the earlier turns are in this chat’s notes already.'
            : 'Nothing to compact yet: this chat is short enough to keep whole.';
    } catch (error) {
        if (turn.signal.aborted) {
            throw error;
        }
        reportFailure('Compact', [safeFailure(error)]);
        return FAILED;
    }
}
