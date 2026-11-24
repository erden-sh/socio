// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { filingCause, type GoalOfTask } from '@socio/foundation/issues/filing-cause';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { NOTIFY_LIMITS, type NotificationDailyLimits } from '@socio/shared/notifications';

import type { ResolvedImage } from './images.js';
import type { NotificationService } from './service.js';

export const NOTIFY_TOOL_NAMES = ['notify_user'] as const;

/** Turns that act for their person: chats, schedules and goals, an approval's continuation. */
const NOTIFYING = new Set(['chat', 'scheduled', 'approval']);

/**
 * A path in the brain from what the Dot gave: a path, or a URL on the
 * brain's own origin. Anything else is refused.
 */
export function brainPath(link: string, origin: string) {
    const trimmed = link.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        const url = new URL(trimmed, origin);
        return `${url.pathname}${url.search}${url.hash}`;
    }
    try {
        const url = new URL(trimmed);
        if (url.origin === new URL(origin).origin) {
            return `${url.pathname}${url.search}${url.hash}`;
        }
    } catch {
        // Not a URL.
    }
    return undefined;
}

/**
 * `notify_user` (CB-114): the turn's Dot notifies the person the turn acts
 * for, and nobody else: the recipient comes from the turn, never from the
 * model. Text-only turns have no tools, so they get none of this.
 */
export function notifyTools(
    service: NotificationService,
    turn: DotTurn,
    options: {
        limits: NotificationDailyLimits;
        goalOf?: GoalOfTask;
        image: (url: string) => Promise<ResolvedImage>;
    },
): ToolDefinition[] {
    if (!NOTIFYING.has(turn.purpose)) {
        return [];
    }
    return [
        defineTool({
            name: 'notify_user',
            description:
                'Notify the person you work for on their devices or Telegram, for something worth interrupting them: unattended work that finished or needs them, a problem you found, a decision only they can make. Not for routine progress. Keep it short and never include secrets. It goes only to them, on the channels they chose, and only when they are not using Socio: if they are looking at this chat nothing is sent (say it in your reply); if they are elsewhere in Socio it shows there. Some people get only "<your name> needs you", without your text. The image shows on some devices only, so the message must make sense without it.',
            parameters: z.object({
                message: z
                    .string()
                    .trim()
                    .min(1)
                    .max(NOTIFY_LIMITS.message)
                    .describe('What they need to know, in one or two short sentences.'),
                title: z
                    .string()
                    .trim()
                    .min(1)
                    .max(NOTIFY_LIMITS.title)
                    .optional()
                    .describe('Optional: a few words, shown after your name.'),
                link: z
                    .string()
                    .trim()
                    .max(NOTIFY_LIMITS.link)
                    .optional()
                    .describe(
                        'Optional: the page in Socio it opens, as a path (/spaces/…, /schedules/…). This chat when not given.',
                    ),
                image: z
                    .string()
                    .trim()
                    .max(2000)
                    .optional()
                    .describe(
                        'Optional: an image URL (an attachment or Media item in Socio, or a public image), PNG, JPEG, GIF or WebP, 1 MB at most.',
                    ),
            }),
            execute: async (input) => {
                turn.check();
                let path: string | undefined;
                if (input.link) {
                    path = brainPath(input.link, service.origin);
                    if (!path) {
                        return {
                            outcome: 'invalid',
                            message: 'The link must be a page in Socio (a path).',
                        };
                    }
                }
                let image: { bytes: Buffer; mediaType: string } | undefined;
                let imageNote: string | undefined;
                if (input.image) {
                    const resolved = await options.image(input.image);
                    if (resolved.ok) {
                        image = { bytes: resolved.bytes, mediaType: resolved.mediaType };
                    } else {
                        imageNote = `Sent without the image: ${resolved.message}`;
                    }
                }
                turn.check();
                const { trigger, causeId } = await filingCause(turn, options.goalOf);
                const result = await service.notify(
                    {
                        userId: turn.userId,
                        dot: { id: turn.dot.id, name: turn.dot.name },
                        threadId: turn.threadId,
                        trigger,
                        causeId,
                        title: input.title,
                        message: input.message,
                        path,
                        image,
                    },
                    options.limits,
                );
                return {
                    ...result,
                    ...(imageNote && result.outcome === 'sent' ? { imageNote } : {}),
                };
            },
        }),
    ];
}
