import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson } from '@socio/foundation/http/conditional';
import {
    EPISODES_PAGE_MAX,
    MEMORY_TEXT_MAX,
    type EpisodesState,
    PROFILE_FIELD_MAX,
    PROFILE_FIELDS,
    type MemoriesState,
    type ProfileField,
} from '@socio/shared/memory';
import { ianaTimeZone } from '@socio/shared/time-zone';

import type { WorkspaceAuditEntry } from '../workspace/contract.js';

import {
    DEFAULT_EPISODE_RETENTION_DAYS,
    type EpisodeRepository,
    type MemoriesViewShape,
    type MemoryRepository,
    type ProfileRepository,
    type TimeZoneNoteRepository,
} from './contract.js';
import { movedTimeZone } from './time-zone.js';

/**
 * `/api/memories` (CB-106): each person's own profile and memories, and
 * the proposals their socios made. Every route acts on the signed-in
 * person's rows only; anyone else's id is "not found".
 */

/** The repositories the Memories page reads (the store holds them). */
type MemoriesRepositories = {
    readonly memoryItems: MemoryRepository;
    readonly profiles: ProfileRepository;
    readonly timeZoneNotes: TimeZoneNoteRepository;
};

const TEXT_ERROR = `Memory must be between 1 and ${MEMORY_TEXT_MAX.toLocaleString('en')} characters.`;
const TIME_ZONE_ERROR = 'Time zone must be a time zone name, like Europe/Madrid or America/New_York.';
const memoryBody = z
    .object({
        text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
        shareable: z.boolean().optional(),
    })
    .strict();
const memoryPatch = z
    .object({
        text: z.string().trim().min(1).max(MEMORY_TEXT_MAX).optional(),
        shareable: z.boolean().optional(),
    })
    .strict();
const profileBody = z
    .object({
        fields: z
            .object(
                Object.fromEntries(
                    PROFILE_FIELDS.map((field) => [field, z.string().max(PROFILE_FIELD_MAX[field]).optional()]),
                ) as Record<ProfileField, z.ZodOptional<z.ZodString>>,
            )
            .strict(),
        shareable: z.boolean(),
    })
    .strict();

/** `GET /api/memories`: what the Memories page shows its person. */
export async function memoriesView(store: MemoriesRepositories, userId: string): Promise<MemoriesState> {
    const [profile, items, moved] = await Promise.all([
        store.profiles.get(userId),
        store.memoryItems.list(userId),
        movedTimeZone(store.profiles, store.timeZoneNotes, userId, 'page'),
    ]);
    return {
        profile,
        memories: items.filter((item) => item.status === 'active'),
        proposals: items.filter((item) => item.status === 'proposed'),
        ...(moved ? { timeZoneMoved: moved } : {}),
    };
}

/** `MemoriesView` (the contract's) over `memoriesView`, on the store's repositories. */
export const memoriesViews = (store: MemoriesRepositories): MemoriesViewShape => ({
    view: (userId) => memoriesView(store, userId),
});

/** `GET /api/memories/episodes`: the person's episodes (CB-180). */
export async function episodesView(
    store: { readonly episodes: EpisodeRepository },
    userId: string,
    options: { query?: string; limit?: number; retentionDays: number },
): Promise<EpisodesState> {
    const [episodes, total] = await Promise.all([
        store.episodes.list(userId, {
            query: options.query,
            limit: options.limit ?? EPISODES_PAGE_MAX,
        }),
        store.episodes.count(userId),
    ]);
    return { episodes, total, retentionDays: options.retentionDays };
}

export function memoryRoutes(
    store: MemoriesRepositories & {
        readonly episodes: EpisodeRepository;
        /**
         * The live counters' `read` (`live/`'s `CountersShape`, by its shape:
         * live is above memory in the folder order): `key=n` for each key.
         */
        readonly counters: { read(keys: readonly string[]): string };
    },
    audit?: (entry: WorkspaceAuditEntry) => void,
    /** The episodes' retention in force (CB-180), for the page to say. */
    retentionDays: () => number = () => DEFAULT_EPISODE_RETENTION_DAYS,
) {
    const app = new Hono<AppEnv>();
    const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
    app.get('/memories', async (c) => {
        const user = c.get('user');
        const state = await memoriesView(store, user.id);
        return conditionalJson(
            c,
            () => state,
            () => `${user.id}|${store.counters.read([`memories:${user.id}`])}|${state.timeZoneMoved ?? ''}`,
        );
    });
    // The page showed the note of a moved time zone (CB-176): not again.
    app.post('/memories/time-zone-note/seen', async (c) => {
        const parsed = z
            .object({ zone: z.string().min(1).max(64) })
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Send the zone shown.' }, 400);
        }
        await store.timeZoneNotes.shown(c.get('user').id, 'page', parsed.data.zone);
        return c.json({ ok: true });
    });
    // Episodes (CB-180): before `/memories/:id`, which would take the name
    // for an id. Only the signed-in person's; anyone else's is not found.
    app.get('/memories/episodes', async (c) => {
        const parsed = z
            .object({
                q: z.string().max(300).optional(),
                limit: z.coerce.number().int().min(1).max(EPISODES_PAGE_MAX).optional(),
            })
            .safeParse(c.req.query());
        if (!parsed.success) {
            return c.json({ error: 'Search with up to 300 characters.' }, 400);
        }
        return c.json(
            await episodesView(store, c.get('user').id, {
                query: parsed.data.q,
                limit: parsed.data.limit,
                retentionDays: retentionDays(),
            }),
        );
    });
    // Deleting is real: the row goes, from the person, their socios and
    // every turn at once (backups keep it until they age out).
    app.delete('/memories/episodes/:id', async (c) => {
        const userId = c.get('user').id;
        if (!(await store.episodes.remove(c.req.param('id'), userId))) {
            return c.json({ error: 'Episode not found.' }, 404);
        }
        audit?.({
            actor: userId,
            action: 'delete',
            targetKind: 'episode',
            targetId: c.req.param('id'),
        });
        return c.json({ ok: true });
    });
    // All of the person's episodes, or one chat's (`threadId`).
    app.delete('/memories/episodes', async (c) => {
        const userId = c.get('user').id;
        const threadId = c.req.query('threadId')?.trim() || undefined;
        if (threadId && threadId.length > 200) {
            return c.json({ error: 'Episode not found.' }, 404);
        }
        const deleted = await store.episodes.removeAll(userId, { threadId });
        if (deleted) {
            audit?.({
                actor: userId,
                action: 'delete',
                targetKind: 'episode',
                targetId: threadId ? `thread:${threadId}` : '*',
                detail: `${deleted}`,
            });
        }
        return c.json({ ok: true, deleted });
    });
    // A memory the person adds is in use at once.
    app.post('/memories', async (c) => {
        const parsed = memoryBody.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: TEXT_ERROR }, 400);
        }
        const memory = await store.memoryItems.add({
            userId: c.get('user').id,
            text: parsed.data.text,
            shareable: parsed.data.shareable,
            source: 'person',
        });
        return c.json(memory, 201);
    });
    // The profile: before `/memories/:id`, which would take its name for an id.
    app.put('/memories/profile', async (c) => {
        const parsed = profileBody.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'A profile field is too long.' }, 400);
        }
        // A time zone the person enters is one the clock can use (CB-159):
        // an IANA name. One saved before zones were checked, in their own
        // words, stays as it is until they change it.
        const { fields } = parsed.data;
        const entered = fields.timezone?.trim();
        const saved = (await store.profiles.get(c.get('user').id))?.fields.timezone;
        if (entered && entered !== saved) {
            const zone = ianaTimeZone(entered);
            if (!zone) {
                return c.json({ error: TIME_ZONE_ERROR }, 400);
            }
            fields.timezone = zone;
        }
        return c.json((await store.profiles.save(c.get('user').id, parsed.data)) ?? null);
    });
    // CB-64: cleared, the profile is no longer used and every version is kept.
    app.delete('/memories/profile', async (c) => {
        await store.profiles.clear(c.get('user').id);
        return c.json({ ok: true });
    });
    app.put('/memories/:id', async (c) => {
        const parsed = memoryPatch.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: TEXT_ERROR }, 400);
        }
        const memory = await store.memoryItems.update(c.req.param('id'), c.get('user').id, parsed.data);
        return memory ? c.json(memory) : c.json({ error: 'Memory not found.' }, 404);
    });
    // A socio's proposal is used only once its person approves it.
    app.post('/memories/:id/approve', async (c) => {
        const memory = await store.memoryItems.approve(c.req.param('id'), c.get('user').id);
        return memory ? c.json(memory) : c.json({ error: 'Memory not found.' }, 404);
    });
    // "Still true": the person confirms it, which keeps it fresh.
    app.post('/memories/:id/confirm', async (c) => {
        const memory = await store.memoryItems.confirm(c.req.param('id'), c.get('user').id);
        return memory ? c.json(memory) : c.json({ error: 'Memory not found.' }, 404);
    });
    // CB-64: forgotten (or a proposal turned down), the memory is hidden from
    // the person and their socios, and kept.
    app.delete('/memories/:id', async (c) => {
        const userId = c.get('user').id;
        if (!(await store.memoryItems.forget(c.req.param('id'), userId))) {
            return c.json({ error: 'Memory not found.' }, 404);
        }
        audit?.({
            actor: userId,
            action: 'delete',
            targetKind: 'memory',
            targetId: c.req.param('id'),
        });
        return c.json({ ok: true });
    });
    return app;
}
