import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { isAdmin } from '@socio/shared/roles';
import { canEditSoul, SOUL_FIELD_MAX, type SoulVersion, type SoulView } from '@socio/shared/soul';

import { SoulError } from './contract.js';
import { soulServicesOf, type SoulServices, type SoulsWorkspace } from './services.js';

const version = z.number().int().min(1).max(1_000_000);
const soulInput = z
    .object({
        instructions: z.string().max(SOUL_FIELD_MAX.instructions + 200),
        voice: z
            .string()
            .max(SOUL_FIELD_MAX.voice + 200)
            .optional(),
        values: z
            .string()
            .max(SOUL_FIELD_MAX.values + 200)
            .optional(),
        style: z
            .string()
            .max(SOUL_FIELD_MAX.style + 200)
            .optional(),
        /** The version the editor started from: a 409 if it's no longer in use. */
        baseVersion: version,
    })
    .strict();
const restoreInput = z.object({ version, baseVersion: version }).strict();

/**
 * A socio's Soul (CB-179): `/api/dots/:id/soul`. Anyone who may use a
 * socio reads its Soul and every version (a company socio: everyone; a
 * personal one: its owner, and admins, who see every socio). Only its
 * owner edits a personal socio's Soul, only admins a company socio's
 * (`canEditSoul`); a socio never edits one (`SoulStore.append`).
 */
export function soulRoutesOver(services: SoulServices) {
    const app = new Hono<AppEnv>();
    const { souls, socios, people } = services;
    /** The socio, when the signed-in person may read its Soul. */
    const readable = (c: Context<AppEnv>) => {
        const user = c.get('user');
        const dot = socios.dot(c.req.param('id') ?? '');
        if (!dot) {
            return undefined;
        }
        if (dot.ownerId && dot.ownerId !== user.id && !isAdmin(user)) {
            return undefined;
        }
        return dot;
    };
    const missing = (c: Context<AppEnv>) => c.json({ error: 'Socio not found.' }, 404);
    /** The socio, when the signed-in person may change its Soul. */
    const editable = (c: Context<AppEnv>) => {
        const dot = readable(c);
        if (!dot) {
            return { refused: missing(c) };
        }
        if (!canEditSoul(c.get('user'), dot)) {
            return {
                refused: c.json(
                    {
                        error: dot.ownerId
                            ? 'Only its owner can change a personal socio’s Soul.'
                            : 'Only an admin can change a company socio’s Soul.',
                    },
                    403,
                ),
            };
        }
        if (dot.archivedAt) {
            return {
                refused: c.json({ error: 'This socio is archived: unarchive it first.' }, 409),
            };
        }
        return { dot };
    };
    const failed = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof SoulError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };

    app.get('/dots/:id/soul', (c) => {
        const dot = readable(c);
        if (!dot) {
            return missing(c);
        }
        const versions = souls.history(dot.id);
        const names = new Map(people.users().map((user) => [user.id, user.name]));
        return c.json<SoulView>({
            dot: {
                id: dot.id,
                name: dot.name,
                ownerId: dot.ownerId ?? null,
                archived: !!dot.archivedAt,
            },
            versions,
            canEdit: canEditSoul(c.get('user'), dot) && !dot.archivedAt,
            users: Object.fromEntries(
                [...new Set(versions.map((item) => item.createdBy))].map((id) => {
                    if (id === 'system') {
                        return [id, 'Socio'];
                    }
                    // CB-330: a socio editing its own Soul is `dot:<dotId>`.
                    if (id.startsWith('dot:')) {
                        const editor = socios.dot(id.slice(4));
                        return [id, editor ? `${editor.name} (self)` : 'Itself'];
                    }
                    return [id, names.get(id) ?? 'Someone'];
                }),
            ),
        });
    });

    app.put('/dots/:id/soul', async (c) => {
        const { dot, refused } = editable(c);
        if (!dot) {
            return refused;
        }
        const data = soulInput.safeParse(await c.req.json().catch(() => null));
        if (!data.success) {
            return c.json({ error: 'Send the Soul’s parts and its version.' }, 400);
        }
        const { baseVersion, ...fields } = data.data;
        try {
            const soul = await souls.save(dot.id, fields, c.get('user').id, baseVersion);
            return c.json<{ soul: SoulVersion }>({ soul });
        } catch (error) {
            return failed(c, error);
        }
    });

    app.post('/dots/:id/soul/restore', async (c) => {
        const { dot, refused } = editable(c);
        if (!dot) {
            return refused;
        }
        const data = restoreInput.safeParse(await c.req.json().catch(() => null));
        if (!data.success) {
            return c.json({ error: 'Say which version to restore.' }, 400);
        }
        try {
            const soul = await souls.restore(dot.id, data.data.version, c.get('user').id, data.data.baseVersion);
            return c.json<{ soul: SoulVersion }>({ soul });
        } catch (error) {
            return failed(c, error);
        }
    });
    return app;
}

/**
 * The Soul routes over a platform's workspace, which holds its Souls: how
 * the workspace's routes mount them until they move to
 * `composition/http`.
 */
export function soulRoutes(platform: { readonly workspace: SoulsWorkspace }) {
    return soulRoutesOver(soulServicesOf(platform.workspace));
}
