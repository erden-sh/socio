// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import { toolError } from '@socio/foundation/http/tool-error';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { canEditSoul, SOUL_FIELD_MAX, SOUL_INSTRUCTIONS_MIN } from '@socio/shared/soul';

import { SoulError } from './contract.js';
import type { SoulServices } from './services.js';
import { selfSoulActor } from './souls.js';

const soulInput = z.object({
    instructions: z
        .string()
        .min(SOUL_INSTRUCTIONS_MIN)
        .max(SOUL_FIELD_MAX.instructions)
        .describe('What you are for and always do. Required.'),
    voice: z.string().max(SOUL_FIELD_MAX.voice).optional().describe('How you sound: tone, warmth, length, formality.'),
    values: z.string().max(SOUL_FIELD_MAX.values).optional().describe('What you care about and weigh when you decide.'),
    style: z
        .string()
        .max(SOUL_FIELD_MAX.style)
        .optional()
        .describe('How you work with people: questions first, plans, check-ins.'),
    baseVersion: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .describe('The version in use now; refuses if it changed since (reload to see it).'),
});

/**
 * The socio tool to edit its own Soul (CB-330): `edit_own_soul`. A socio
 * may rewrite its own persona — its standing instructions, voice, values
 * and working style — adding a new version (history is kept). The actor
 * is fixed to the turn's own socio (`dot:<turn.dot.id>`); a socio can
 * never edit another socio's Soul through this tool. The person the socio
 * acts for must be someone who may edit this socio's Soul on the human
 * path (`canEditSoul`): the owner of a personal socio, an admin for a
 * company socio — so a member using a shared company socio can't prompt it
 * to rewrite a persona only admins may change. An archived socio's Soul
 * is read-only until it is unarchived, as on the human edit path.
 */
export function soulTools(services: SoulServices, turn: DotTurn) {
    const { souls, socios, people } = services;
    const dot = socios.dot(turn.dot.id);
    // An archived socio, or one a concurrent transaction deleted, gets no
    // tool: its Soul is read-only until it is unarchived (CB-179), as on the
    // human edit path. The person the socio acts for must also be someone
    // who may edit this socio's Soul (`canEditSoul`): the owner of a
    // personal socio, an admin for a company socio — so a member on a
    // shared company socio can't prompt it to rewrite a persona only admins
    // may change.
    const user = people.users().find((person) => person.id === turn.userId);
    if (!dot || dot.archivedAt || !canEditSoul(user, dot)) {
        return [];
    }
    const actor = selfSoulActor(turn.dot.id);
    const version = dot.soul?.version ?? 1;
    return [
        defineTool({
            name: 'edit_own_soul',
            description: `Rewrite your own Soul: the role and standing instructions you always follow, and optionally your voice, values and working style. It shapes your tone and style, never Socio's rules, your tools' permissions or approvals. Your current Soul is version ${version}; pass baseVersion as that. A new version is saved only when the parts changed, so the history stays. Use this when the person asks you to change how you work with them, or you've agreed a new role. Don't use it to change another socio's Soul, your settings (name, spaces, model), or anything but your own persona.`,
            parameters: soulInput,
            execute: async (input) => {
                turn.check();
                const { baseVersion, ...fields } = input;
                try {
                    const soul = await souls.saveSelf(turn.dot.id, fields, actor, baseVersion);
                    return {
                        status: 'saved',
                        version: soul.version,
                        message: `Your Soul is now version ${soul.version}.`,
                    };
                } catch (error) {
                    if (error instanceof SoulError) {
                        return toolError({ message: error.message, status: error.status });
                    }
                    throw error;
                }
            },
        }),
    ];
}
