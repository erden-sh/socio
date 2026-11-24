import '@socio/foundation/no-vendor-telemetry';
import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { STANDING_MAX_DAYS } from './extract.js';
import { gitGatewayOf } from './git.js';
import type { GatewaySources } from './sources.js';

/**
 * `repo_extract` (CB-267, CB-239): a socio asks to give a workspace
 * app a read-only copy of part of a listed repository, at one commit,
 * each time with the person's approval, or within a standing grant the
 * person made on a separate card (`standing_days`). The socio never holds
 * a credential or the files; the app reads them through Socio. Gated by
 * the flag `repo-extraction` (its tool list names `repo_extract`) and,
 * inside, `socio-actor-access`.
 */
export const EXTRACT_TOOL_NAMES: readonly string[] = ['repo_extract'];

const input = z
    .object({
        repository: z.string().min(3).max(141).describe('A listed repository, as owner/name.'),
        ref: z
            .string()
            .min(1)
            .max(200)
            .describe('A branch, tag or commit id. It is resolved to one commit before the person is asked.'),
        paths: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(20)
            .describe(
                'Path prefixes or globs relative to the repository root, e.g. "src/" or "docs/**/*.md". No "..", no absolute paths.',
            ),
        app: z.string().min(1).max(100).describe('The workspace app that gets the copy: its id, label or name.'),
        task: z.string().min(1).max(500).describe('What the app will do with it, shown to the person as your words.'),
        standing_days: z
            .number()
            .int()
            .min(1)
            .max(STANDING_MAX_DAYS)
            .optional()
            .describe(
                'Ask instead for standing access (1 to 7 days) to this repository, these paths and this app, on its own card. Approving it extracts nothing; later repo_extract calls that fit skip the card.',
            ),
    })
    .strict();

export function extractTools(sources: GatewaySources, turn: DotTurn): ToolDefinition[] {
    return [
        defineTool({
            name: 'repo_extract',
            description:
                'Ask to give a workspace app (one that accepts repository extractions, e.g. Repomix) a read-only copy of some paths of a listed private repository, at one commit. The person approves every extraction unless they gave standing access. You never get the files or any credential; the app reads them through Socio once. Returns a pending approval, or "done" with an extraction id to hand the app. Not available in group chats.',
            parameters: input,
            execute: async (data) => {
                turn.check();
                return gitGatewayOf(sources).extractions.request(turn, data);
            },
        }) as unknown as ToolDefinition,
    ];
}
