import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { httpsUrlSchema } from '@socio/shared/https-url';
import {
    POST_STATUSES,
    REPLY_STATUSES,
    accountHandle,
    parseZonedLocal,
    type PostStatus,
    type ReplyStatus,
} from '@socio/shared/planner';
import type { ThreadPart } from '@socio/shared/x-post';

import { SqlitePlanner } from './infra/repository.js';

const part = z.object({
    text: z.string().max(4000),
    xId: z.string().trim().min(1).max(40).optional(),
});
const postBody = z.object({
    status: z.enum(POST_STATUSES).optional(),
    account: z.string().trim().min(1).max(40),
    plannedAt: z.number().int().positive().optional(),
    plannedLocal: z.string().max(20).optional(),
    topic: z.string().max(80).optional(),
    notes: z.string().max(4000).optional(),
    parts: z.array(part).min(1).max(25),
});
const postPatch = postBody.partial();
const replyBody = z.object({
    sourceUrl: httpsUrlSchema,
    sourceId: z.string().trim().min(1).max(40),
    author: z.string().trim().min(1).max(40),
    excerpt: z.string().max(500).optional(),
    why: z.string().max(2000).optional(),
    draft: z.string().max(4000).optional(),
    status: z.enum(REPLY_STATUSES).optional(),
});
const replyPatch = z.object({
    status: z.enum(REPLY_STATUSES).optional(),
    draft: z.string().max(4000).optional(),
    why: z.string().max(2000).optional(),
    excerpt: z.string().max(500).optional(),
});

function when(body: { plannedAt?: number; plannedLocal?: string }) {
    if (body.plannedAt !== undefined) {
        return body.plannedAt;
    }
    if (body.plannedLocal) {
        return parseZonedLocal(body.plannedLocal);
    }
    return undefined;
}

function partsOf(parts: { text: string; xId?: string }[]): ThreadPart[] {
    return parts.map((item) => ({
        text: item.text,
        ...(item.xId ? { xId: item.xId } : {}),
    }));
}

/**
 * `/api/plugins/social-strategy/data`. The plugin service calls it with its
 * proof; an admin's session can too. Nothing here reaches X.
 */
export function plannerData(db: DatabaseSync) {
    const repo = new SqlitePlanner(sqliteData(db));
    const app = new Hono<AppEnv>();
    const bad = (c: { json: (body: object, status: 400) => Response }, error: z.ZodError) =>
        c.json({ error: error.issues[0]?.message ?? 'Invalid request.' }, 400);

    app.get('/state', async (c) => {
        const status = c.req.query('status');
        const posts = await repo.posts({
            from: number(c.req.query('from')),
            to: number(c.req.query('to')),
            ...(status && (POST_STATUSES as readonly string[]).includes(status)
                ? { status: status as PostStatus }
                : {}),
        });
        const replyStatus = c.req.query('reply');
        return c.json({
            posts,
            replies: await repo.replies(
                replyStatus && (REPLY_STATUSES as readonly string[]).includes(replyStatus)
                    ? (replyStatus as ReplyStatus)
                    : undefined,
            ),
            voice: await repo.voice(),
        });
    });

    app.post('/posts', async (c) => {
        const parsed = postBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return bad(c, parsed.error);
        }
        const plannedAt = when(parsed.data);
        if (plannedAt === undefined) {
            return c.json({ error: 'Send a planned time.' }, 400);
        }
        const now = Date.now();
        const id = randomUUID();
        await repo.insertPost({
            id,
            status: parsed.data.status ?? 'draft',
            account: accountHandle(parsed.data.account),
            plannedAt,
            topic: parsed.data.topic?.trim() ?? '',
            notes: parsed.data.notes ?? '',
            parts: partsOf(parsed.data.parts),
            createdAt: now,
            updatedAt: now,
        });
        return c.json(await repo.post(id), 201);
    });

    app.patch('/posts/:postId', async (c) => {
        const id = c.req.param('postId');
        const current = await repo.post(id);
        if (!current) {
            return c.json({ error: 'No such post.' }, 404);
        }
        const parsed = postPatch.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return bad(c, parsed.error);
        }
        const plannedAt = when(parsed.data);
        await repo.updatePost(id, {
            updatedAt: Date.now(),
            ...(parsed.data.status ? { status: parsed.data.status } : {}),
            ...(parsed.data.account ? { account: accountHandle(parsed.data.account) } : {}),
            ...(plannedAt !== undefined ? { plannedAt } : {}),
            ...(parsed.data.topic !== undefined ? { topic: parsed.data.topic.trim() } : {}),
            ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
            ...(parsed.data.parts ? { parts: partsOf(parsed.data.parts) } : {}),
        });
        return c.json(await repo.post(id));
    });

    app.post('/replies', async (c) => {
        const parsed = replyBody.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return bad(c, parsed.error);
        }
        const now = Date.now();
        const id = randomUUID();
        await repo.insertReply({
            id,
            sourceUrl: parsed.data.sourceUrl,
            sourceId: parsed.data.sourceId,
            author: accountHandle(parsed.data.author),
            excerpt: parsed.data.excerpt?.trim() ?? '',
            why: parsed.data.why ?? '',
            draft: parsed.data.draft ?? '',
            status: parsed.data.status ?? 'todo',
            createdAt: now,
            updatedAt: now,
        });
        return c.json(await repo.reply(id), 201);
    });

    app.patch('/replies/:replyId', async (c) => {
        const id = c.req.param('replyId');
        if (!(await repo.reply(id))) {
            return c.json({ error: 'No such reply.' }, 404);
        }
        const parsed = replyPatch.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return bad(c, parsed.error);
        }
        await repo.updateReply(id, {
            updatedAt: Date.now(),
            ...(parsed.data.status ? { status: parsed.data.status } : {}),
            ...(parsed.data.draft !== undefined ? { draft: parsed.data.draft } : {}),
            ...(parsed.data.why !== undefined ? { why: parsed.data.why } : {}),
            ...(parsed.data.excerpt !== undefined ? { excerpt: parsed.data.excerpt.trim() } : {}),
        });
        return c.json(await repo.reply(id));
    });

    app.put('/voice', async (c) => {
        const parsed = z.object({ notes: z.string().max(8000) }).safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return bad(c, parsed.error);
        }
        await repo.setVoice(parsed.data.notes);
        return c.json(await repo.voice());
    });

    return app;
}

function number(value: string | undefined) {
    if (!value) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
