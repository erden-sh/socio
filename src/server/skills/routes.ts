import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import {
    CHAT_SKILL_MODES,
    CHAT_SKILL_NAME,
    RESERVED_SKILL_NAMES,
    SKILL_DESCRIPTION_MAX,
    SKILL_INSTRUCTIONS_MAX,
    IMPORTED_SKILL_DESCRIPTION_MAX,
    IMPORTED_SKILL_INSTRUCTIONS_MAX,
    type ActiveChatSkill,
    type ChatSkillMode,
    type ChatSkillRevisionView,
    type ChatSkillView,
} from '@socio/shared/chat/chat-skills';
import { isAdmin } from '@socio/shared/roles';

import type { ConversationsShape, PeopleShape } from '../workspace/contract.js';

import type { SkillSessionsRepository, WorkspaceSkillsRepository } from './contract.js';
import { skillImporter, importSourceSchema, importApplySchema, type GitHubSkillImporter } from './github-import.js';
import type { ChatSkills } from './registry.js';

const skillBody = z.object({
    description: z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX),
    instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX),
    mode: z.enum(CHAT_SKILL_MODES as [ChatSkillMode, ...ChatSkillMode[]]).default('turn'),
});

/**
 * `/api/chat-skills` (CB-143):
 * - everyone lists the skills they can invoke (the composer's `/` menu);
 * - in a chat they can read, each person sees the skill they have on,
 *   and ends it (in a shared chat, a skill is its starter's);
 * - admins add, change, roll back and remove the workspace's skills, and
 *   see every skill's lock record and a workspace skill's revisions.
 * Signed-in people only: service keys and data tokens never reach these.
 */
export function chatSkillRoutes({
    registry,
    repository,
    sessions,
    workspace,
    importer = skillImporter(repository),
}: {
    registry: ChatSkills;
    repository: WorkspaceSkillsRepository;
    sessions: SkillSessionsRepository;
    workspace: Pick<PeopleShape, 'users'> & Pick<ConversationsShape, 'readableThread'>;
    importer?: GitHubSkillImporter;
}) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app for chat skills.' }, 403);
        }
        await next();
    };
    app.use('/chat-skills', signedIn);
    app.use('/chat-skills/*', signedIn);
    const missing = { error: 'That skill doesn’t exist.' };

    app.get('/chat-skills', async (c) => {
        const admin = isAdmin(c.get('user'));
        const skills: ChatSkillView[] = (await registry.list()).map(({ instructions, lock, ...skill }) => ({
            ...skill,
            // Only admins edit a workspace skill or read where one came from.
            ...(admin && !skill.builtIn ? { instructions } : {}),
            ...(admin ? { lock } : {}),
        }));
        return c.json({ skills });
    });

    // Preview performs bounded public reads only. Apply uses the exact reviewed
    // commit/content, bound to this admin, and never fetches mutable refs again.
    app.post('/chat-skills/import/preview', requireAdmin, async (c) => {
        const input = importSourceSchema.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json(
                {
                    error: 'Supply a public GitHub repository URL, ref and SKILL.md path.',
                },
                400,
            );
        }
        try {
            return c.json(await importer.preview(c.get('user').id, input.data));
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Could not preview that source.',
                },
                400,
            );
        }
    });
    app.post('/chat-skills/import/apply', requireAdmin, async (c) => {
        const input = importApplySchema.safeParse(await c.req.json().catch(() => null));
        if (!input.success) {
            return c.json({ error: 'Apply a reviewed preview ID and its source SHA-256.' }, 400);
        }
        try {
            return c.json({
                skill: await importer.apply(c.get('user').id, input.data),
            });
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Could not apply that preview.',
                },
                409,
            );
        }
    });

    // The skill on in a chat the person can read (team chats included).
    app.get('/chat-skills/threads/:threadId', async (c) => {
        const thread = await workspace.readableThread(c.get('user').id, c.req.param('threadId'));
        if (!thread) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        // Each person's own: in a shared chat, another's isn't theirs to see.
        const on = await registry.active(thread.id, c.get('user').id);
        const active: ActiveChatSkill | null = on
            ? {
                  name: on.skill.name,
                  description: on.skill.description,
                  startedAt: on.session.startedAt,
              }
            : null;
        return c.json({ active });
    });
    // Ends the person's own, in a chat they can read.
    app.post('/chat-skills/threads/:threadId/end', async (c) => {
        const userId = c.get('user').id;
        if (!(await workspace.readableThread(userId, c.req.param('threadId')))) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        const ended = await sessions.end(c.req.param('threadId'), userId, 'stopped');
        return c.json({ ended: ended ? ended.skill : null });
    });

    app.put('/chat-skills/:name', requireAdmin, async (c) => {
        const name = c.req.param('name');
        if (!CHAT_SKILL_NAME.test(name)) {
            return c.json(
                {
                    error: 'A skill’s name is up to 32 lowercase letters, digits and hyphens.',
                },
                400,
            );
        }
        if (RESERVED_SKILL_NAMES.includes(name)) {
            return c.json({ error: `/${name} is a built-in name.` }, 409);
        }
        const current = await repository.get(name);
        const schema =
            current?.source === 'git'
                ? skillBody.extend({
                      description: z.string().trim().min(1).max(IMPORTED_SKILL_DESCRIPTION_MAX),
                      instructions: z
                          .string()
                          .min(1)
                          .max(IMPORTED_SKILL_INSTRUCTIONS_MAX)
                          .refine((value) => !!value.trim()),
                  })
                : skillBody;
        const body = schema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json(
                {
                    error: `Give the skill a description (up to ${SKILL_DESCRIPTION_MAX} characters), instructions (up to ${SKILL_INSTRUCTIONS_MAX}) and how long it stays on.`,
                },
                400,
            );
        }
        const saved = await repository.save({ name, ...body.data }, c.get('user').id);
        return c.json({ skill: saved });
    });

    // Every revision, newest first, with who made it.
    app.get('/chat-skills/:name/revisions', requireAdmin, async (c) => {
        const revisions = await repository.revisions(c.req.param('name'));
        if (!revisions.length) {
            return c.json(missing, 404);
        }
        const names = new Map(workspace.users().map((user) => [user.id, user]));
        return c.json({
            revisions: revisions.map((revision): ChatSkillRevisionView => ({
                ...revision,
                ...(names.get(revision.createdBy) ? { createdByName: names.get(revision.createdBy)!.name } : {}),
            })),
        });
    });

    // An earlier revision's content, as a new revision.
    app.post('/chat-skills/:name/rollback', requireAdmin, async (c) => {
        const body = z.object({ revision: z.number().int().min(1) }).safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json({ error: 'Say which revision to go back to.' }, 400);
        }
        const skill = await repository.rollback(c.req.param('name'), body.data.revision, c.get('user').id);
        return skill ? c.json({ skill }) : c.json({ error: 'That revision doesn’t exist.' }, 404);
    });

    app.delete('/chat-skills/:name', requireAdmin, async (c) =>
        (await repository.remove(c.req.param('name'), c.get('user').id)) ? c.json({ ok: true }) : c.json(missing, 404),
    );
    return app;
}
