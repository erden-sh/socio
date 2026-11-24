/**
 * A new Space's input, as the create dialog sends it (`POST /api/spaces`,
 * CB-181) and a socio's `create_space` asks for it (CB-271): its limits,
 * the refusal for a bad name, who it is for, and the zod schema. Moved
 * from `src/server/spaces/create.ts`, which re-exports them.
 */
import { z } from 'zod';

import { SPACE_ROLES } from '../space-memory.js';

export const SPACE_NAME_MAX = 60;
export const SPACE_DESCRIPTION_MAX = 500;
export const SPACE_NAME_ERROR = `Enter a Space name (up to ${SPACE_NAME_MAX} characters).`;

/**
 * A Space's name, trimmed, 1 to `SPACE_NAME_MAX` characters: the one rule
 * for a new Space and a renamed one (CB-366).
 */
export const spaceNameInput = z.string().trim().min(1).max(SPACE_NAME_MAX);

/** `PATCH /api/spaces/:id`: a new name for the Space (CB-366). */
export const spaceRenameInput = z.object({ name: spaceNameInput }).strict();

/** `POST /api/spaces`: a new Space, as the create dialog sends it (CB-181). */
export const spaceCreateInput = z
    .object({
        name: spaceNameInput,
        description: z.string().max(SPACE_DESCRIPTION_MAX).default(''),
        private: z.boolean().optional(),
        people: z
            .array(
                z
                    .object({
                        userId: z.string().min(1).max(200),
                        role: z.enum(SPACE_ROLES),
                    })
                    .strict(),
            )
            .max(500)
            .optional(),
    })
    .strict();

/** A parsed `spaceCreateInput`. */
export type SpaceCreateRequest = z.output<typeof spaceCreateInput>;

/** Who a new Space is for: only its people, or the whole workspace. */
export const SPACE_VISIBILITIES = ['private', 'workspace'] as const;
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];
