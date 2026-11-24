import type { DatabaseSync } from 'node:sqlite';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import { httpsUrlSchema } from '@socio/shared/https-url';
import {
    POST_STATUSES,
    REPLY_STATUSES,
    accountHandle,
    parseZonedLocal,
    type PostStatus,
    type ReplyStatus,
} from '@socio/shared/planner';
import type { User } from '@socio/shared/types';

import { SqlitePlanner } from './infra/repository.js';

const NEVER = 'Does not post to X; a person publishes it from X.';

/**
 * Planner tools, registered only when the plugin is installed and enabled,
 * the caller is an admin, and both the install and the connection allow
 * the tool's permission (`social:read` needs the connection's
 * `plugins:read`, `social:write` its `plugins:write`). They never appear
 * on an instance that has not installed the plugin.
 */
export function contributePlanner(
    server: McpServer,
    ctx: {
        person: User;
        origin: string;
        db: DatabaseSync;
        permissions: readonly string[];
    },
) {
    const repo = new SqlitePlanner(sqliteData(ctx.db));
    const allow = (scope: string) => ctx.permissions.includes(scope);
    const tool = (
        name: string,
        scope: string,
        config: {
            description: string;
            inputSchema: Record<string, z.ZodType>;
            annotations: { readOnlyHint: boolean; destructiveHint: boolean };
        },
        work: (args: Record<string, unknown>) => Promise<object>,
    ) => {
        if (!allow(scope)) {
            return;
        }
        server.registerTool(name, config, (async (args: Record<string, unknown>) => {
            try {
                const value = await work(args);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
                    structuredContent: value,
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Could not do that.';
                return {
                    isError: true,
                    content: [{ type: 'text' as const, text: message }],
                };
            }
        }) as never);
    };

    tool(
        'list_planned_posts',
        'social:read',
        {
            description: `List planned posts. from and to are UTC epoch milliseconds; status is optional. ${NEVER}`,
            inputSchema: {
                from: z.number().int().optional(),
                to: z.number().int().optional(),
                status: z.enum(POST_STATUSES).optional(),
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
        },
        async (args) => ({
            posts: await repo.posts({
                from: args.from as number | undefined,
                to: args.to as number | undefined,
                status: args.status as PostStatus | undefined,
            }),
        }),
    );

    tool(
        'create_planned_post',
        'social:write',
        {
            description: `Create a planned post. plannedLocal is America/New_York (YYYY-MM-DDTHH:mm) or send plannedAt as UTC epoch ms. parts is the thread, first part first. ${NEVER}`,
            inputSchema: {
                account: z.string().trim().min(1).max(40),
                plannedLocal: z.string().max(20).optional(),
                plannedAt: z.number().int().positive().optional(),
                status: z.enum(POST_STATUSES).optional(),
                topic: z.string().max(80).optional(),
                notes: z.string().max(4000).optional(),
                parts: z
                    .array(
                        z.object({
                            text: z.string().max(4000),
                            xId: z.string().max(40).optional(),
                        }),
                    )
                    .min(1)
                    .max(25),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args) => {
            const plannedAt =
                (args.plannedAt as number | undefined) ??
                (args.plannedLocal ? parseZonedLocal(String(args.plannedLocal)) : undefined);
            if (plannedAt === undefined) {
                throw new Error('Send a planned time.');
            }
            const now = Date.now();
            const id = crypto.randomUUID();
            const parts = args.parts as { text: string; xId?: string }[];
            await repo.insertPost({
                id,
                status: (args.status as PostStatus | undefined) ?? 'draft',
                account: accountHandle(String(args.account)),
                plannedAt,
                topic: String(args.topic ?? '').trim(),
                notes: String(args.notes ?? ''),
                parts: parts.map((part) => ({
                    text: part.text,
                    ...(part.xId ? { xId: part.xId } : {}),
                })),
                createdAt: now,
                updatedAt: now,
            });
            return { post: await repo.post(id) };
        },
    );

    tool(
        'update_planned_post',
        'social:write',
        {
            description: `Update a planned post by id. Omit a field to leave it. ${NEVER}`,
            inputSchema: {
                id: z.string().uuid(),
                account: z.string().trim().min(1).max(40).optional(),
                plannedLocal: z.string().max(20).optional(),
                plannedAt: z.number().int().positive().optional(),
                status: z.enum(POST_STATUSES).optional(),
                topic: z.string().max(80).optional(),
                notes: z.string().max(4000).optional(),
                parts: z
                    .array(
                        z.object({
                            text: z.string().max(4000),
                            xId: z.string().max(40).optional(),
                        }),
                    )
                    .min(1)
                    .max(25)
                    .optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args) => {
            const id = String(args.id);
            if (!(await repo.post(id))) {
                throw new Error('No such post.');
            }
            const plannedAt =
                (args.plannedAt as number | undefined) ??
                (args.plannedLocal ? parseZonedLocal(String(args.plannedLocal)) : undefined);
            const parts = args.parts as { text: string; xId?: string }[] | undefined;
            await repo.updatePost(id, {
                updatedAt: Date.now(),
                ...(args.status ? { status: args.status as PostStatus } : {}),
                ...(args.account ? { account: accountHandle(String(args.account)) } : {}),
                ...(plannedAt !== undefined ? { plannedAt } : {}),
                ...(args.topic !== undefined ? { topic: String(args.topic).trim() } : {}),
                ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
                ...(parts
                    ? {
                          parts: parts.map((part) => ({
                              text: part.text,
                              ...(part.xId ? { xId: part.xId } : {}),
                          })),
                      }
                    : {}),
            });
            return { post: await repo.post(id) };
        },
    );

    tool(
        'list_reply_queue',
        'social:read',
        {
            description: `List the reply queue. ${NEVER}`,
            inputSchema: { status: z.enum(REPLY_STATUSES).optional() },
            annotations: { readOnlyHint: true, destructiveHint: false },
        },
        async (args) => ({
            replies: await repo.replies(args.status as ReplyStatus | undefined),
        }),
    );

    tool(
        'create_reply_item',
        'social:write',
        {
            description: `Add a reply to draft: the source post’s URL and id, the author, an excerpt, why it is worth a reply, and the draft. ${NEVER}`,
            inputSchema: {
                sourceUrl: httpsUrlSchema,
                sourceId: z.string().trim().min(1).max(40),
                author: z.string().trim().min(1).max(40),
                excerpt: z.string().max(500).optional(),
                why: z.string().max(2000).optional(),
                draft: z.string().max(4000).optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args) => {
            const now = Date.now();
            const id = crypto.randomUUID();
            await repo.insertReply({
                id,
                sourceUrl: String(args.sourceUrl),
                sourceId: String(args.sourceId),
                author: accountHandle(String(args.author)),
                excerpt: String(args.excerpt ?? '').trim(),
                why: String(args.why ?? ''),
                draft: String(args.draft ?? ''),
                status: 'todo',
                createdAt: now,
                updatedAt: now,
            });
            return { reply: await repo.reply(id) };
        },
    );

    tool(
        'update_reply_item',
        'social:write',
        {
            description: `Update a reply’s draft, why, or status (todo, replied, skip). ${NEVER}`,
            inputSchema: {
                id: z.string().uuid(),
                status: z.enum(REPLY_STATUSES).optional(),
                draft: z.string().max(4000).optional(),
                why: z.string().max(2000).optional(),
                excerpt: z.string().max(500).optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
        },
        async (args) => {
            const id = String(args.id);
            if (!(await repo.reply(id))) {
                throw new Error('No such reply.');
            }
            await repo.updateReply(id, {
                updatedAt: Date.now(),
                ...(args.status ? { status: args.status as ReplyStatus } : {}),
                ...(args.draft !== undefined ? { draft: String(args.draft) } : {}),
                ...(args.why !== undefined ? { why: String(args.why) } : {}),
                ...(args.excerpt !== undefined ? { excerpt: String(args.excerpt).trim() } : {}),
            });
            return { reply: await repo.reply(id) };
        },
    );
}
