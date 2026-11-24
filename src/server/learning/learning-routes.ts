import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJson, conditionalJsonAsync } from '@socio/foundation/http/conditional';
import { requireAdmin } from '@socio/foundation/http/guards';
import { scrub } from '@socio/foundation/learning/scrub';
import { requireAdminPerson } from '@socio/foundation/operations/require-admin-person';
import { messageText } from '@socio/foundation/turns/media-parts';
import { LEARNING_LABELS, type LearningLabel } from '@socio/shared/classify';
import {
    PROPOSAL_PAGE,
    PROPOSAL_PAGE_MAX,
    learningContainerIdSchema,
    validateLearningSettings,
    type LearningSocioSettings,
} from '@socio/shared/learning';

import type { FlagsShape } from '../flags/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import type { ConversationsShape, SociosShape } from '../workspace/contract.js';

import { type LearningAnalysis } from './analysis.js';
import { SKILL_NAME, skillMdFile } from './skills.js';
import { triageScore } from './triage.js';
import {
    learningContainersView,
    learningContainerView,
    learningProposalsView,
    parseProposalCursor,
    publishedSkillsView,
    type LearningViewSources,
} from './views.js';

const containerId = z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * What Learning's routes read, from the platform: the analysis (with its
 * evidence and published skills), the runner's stored messages, and the
 * conversations and socios, as the workspace's slices offer them, and the
 * flags (`learning-analyze-now` gates the manual analysis).
 */
export interface LearningRouteSources {
    readonly learning: LearningAnalysis;
    readonly flags: Pick<FlagsShape, 'enabled'>;
    readonly runner: Pick<RunnerShape, 'messages'>;
    readonly workspace: Pick<ConversationsShape, 'thread'> & Pick<SociosShape, 'dots' | 'dot' | 'updateDot'>;
}

/**
 * Learning review. Admins see containers, analysis runs, proposals with their
 * evidence, and the published revisions, and decide what is delivered.
 * Members see only published skills.
 */
export function learningRoutes(platform: LearningRouteSources) {
    const app = new Hono<AppEnv>();
    const { workspace, learning } = platform;
    const { evidence, skills } = learning;
    const views: LearningViewSources = { learning, evidence, skills, socios: workspace };
    const container = (c: Context<AppEnv>) => {
        const parsed = containerId.safeParse(c.req.param('id'));
        return parsed.success ? parsed.data : undefined;
    };

    // Everyone: what their Dots can load.
    app.get('/learning/skills', (c) => c.json(publishedSkillsView(views)));

    app.use('/learning/containers/*', requireAdmin);
    app.use('/learning/containers', requireAdmin);
    app.use('/learning/proposals/*', requireAdmin);
    app.use('/learning/settings', requireAdmin);
    app.use('/learning/settings/*', requireAdmin);
    app.use('/learning/threads/*', requireAdmin);
    const settings = (dot: ReturnType<typeof workspace.dots>[number]): LearningSocioSettings => ({
        id: dot.id,
        name: dot.name,
        learningContainerId: dot.learningContainerId ?? null,
        skillDeliveryEnabled: !!dot.skillDeliveryEnabled,
    });
    app.get('/learning/settings', (c) => c.json(workspace.dots().map(settings)));
    app.patch('/learning/settings/:id', async (c) => {
        const body = z
            .object({
                learningContainerId: learningContainerIdSchema,
                skillDeliveryEnabled: z.boolean(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json(
                {
                    error: 'Choose a scope ID of 1–64 lowercase letters, numbers and single hyphens, or leave it blank.',
                },
                400,
            );
        }
        // Read after the request body: preserve other settings saved while it arrived.
        const dot = workspace.dot(c.req.param('id'));
        if (!dot) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        try {
            validateLearningSettings(body.data.learningContainerId, body.data.skillDeliveryEnabled);
            return c.json(settings(workspace.updateDot(dot.id, { ...dot, ...body.data }, c.get('user').id)));
        } catch (error) {
            return c.json(
                {
                    error: error instanceof Error ? error.message : 'Could not save scope settings.',
                },
                400,
            );
        }
    });
    // Both polled by Learning: 304 when the answer is the same (a body hash).
    app.get('/learning/containers', (c) => conditionalJson(c, () => learningContainersView(views)));
    // `?bodies=false`: proposals without their SKILL.md and rationale.
    app.get('/learning/containers/:id', (c) => {
        const id = container(c);
        if (!id) {
            return c.json({ error: 'Container not found.' }, 404);
        }
        return conditionalJsonAsync(c, () =>
            learningContainerView(views, id, {
                bodies: c.req.query('bodies') !== 'false',
            }),
        );
    });
    // A page of proposals, newest first: `?limit=` (1 to 100), `?cursor=`
    // (the page before's `nextCursor`), `?bodies=false` as above.
    app.get('/learning/containers/:id/proposals', (c) => {
        const id = container(c);
        if (!id) {
            return c.json({ error: 'Container not found.' }, 404);
        }
        const limit = Number(c.req.query('limit') ?? PROPOSAL_PAGE);
        if (!Number.isInteger(limit) || limit < 1 || limit > PROPOSAL_PAGE_MAX) {
            return c.json({ error: `Ask for 1 to ${PROPOSAL_PAGE_MAX} proposals.` }, 400);
        }
        const cursor = c.req.query('cursor');
        const after = cursor ? parseProposalCursor(cursor) : undefined;
        if (cursor && !after) {
            return c.json({ error: 'That page cursor is not valid.' }, 400);
        }
        return c.json(
            learningProposalsView(views, id, {
                limit,
                after,
                bodies: c.req.query('bodies') !== 'false',
            }),
        );
    });
    app.post('/learning/containers/:id/analyze', async (c) => {
        // Analyze now has never worked: behind `learning-analyze-now` (off by
        // default), a 404 for admins it is off for, as `requireFlag` answers,
        // as if the route weren't there. Checked in the handler, so the
        // routes' order (tests/http-order.test.ts) stays as it is.
        if (!platform.flags.enabled('learning-analyze-now', c.get('user').id)) {
            return c.json({ error: 'This feature isn’t available to you.' }, 404);
        }
        const id = container(c);
        if (!id) {
            return c.json({ error: 'Container not found.' }, 404);
        }
        try {
            const { run } = await learning.analyze(id, 'manual', c.get('user').id);
            return c.json(run, 202);
        } catch (error) {
            return c.json({ error: error instanceof Error ? error.message : 'Could not start.' }, 409);
        }
    });
    app.post('/learning/containers/:id/cancel', (c) => {
        const id = container(c);
        return id ? c.json({ cancelled: learning.cancel(id) }) : c.json({ error: 'Container not found.' }, 404);
    });
    app.post('/learning/containers/:id/skills/:name/revoke', (c) => {
        const id = container(c);
        const name = c.req.param('name');
        if (!id || !SKILL_NAME.test(name)) {
            return c.json({ error: 'Skill not found.' }, 404);
        }
        try {
            return c.json(skills.revoke(id, name, c.get('user').id));
        } catch {
            return c.json({ error: 'That skill is not published.' }, 404);
        }
    });
    app.put('/learning/containers/:id/pin', async (c) => {
        const id = container(c);
        const body = z
            .object({ revision: z.number().int().min(1).nullable() })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!id || !body.success) {
            return c.json({ error: 'Choose a revision, or null to unpin.' }, 400);
        }
        try {
            skills.pin(id, body.data.revision);
            return c.json({ pinned: body.data.revision });
        } catch {
            return c.json({ error: 'Container revision not found.' }, 404);
        }
    });

    const proposal = (c: Context<AppEnv>) => learning.proposal(c.req.param('id') ?? '');
    // A proposal with its evidence and the skill it would replace.
    app.get('/learning/proposals/:id', async (c) => {
        const found = proposal(c);
        if (!found) {
            return c.json({ error: 'Proposal not found.' }, 404);
        }
        const triage = learning.seamTriage();
        const evidence = await Promise.all(
            found.evidenceThreadIds.map(async (threadId) => {
                // A deleted conversation keeps its history (CB-64), but it isn't
                // shown: the evidence only says it was deleted.
                const thread = workspace.thread(threadId);
                const messages = thread ? await platform.runner.messages(threadId) : [];
                // Its triage on the classification seam (CB-200), when it had one.
                const verdict = thread ? triage?.verdict(threadId) : undefined;
                return {
                    threadId,
                    title: thread?.title ?? 'Deleted conversation',
                    ownerId: thread?.ownerId ?? null,
                    triage:
                        verdict && (verdict.label || verdict.suggestion)
                            ? {
                                  label: verdict.label?.label ?? null,
                                  source: verdict.label?.source ?? null,
                                  score: triageScore(verdict.suggestion),
                                  intent: triage!.intents([threadId]).get(threadId)?.[0] ?? null,
                              }
                            : null,
                    messages: messages
                        .filter((m) => (m.role === 'user' || m.role === 'assistant') && messageText(m.content).trim())
                        .slice(-12)
                        .map((m) => ({
                            role: m.role,
                            // As the model saw it: contact details and secrets removed;
                            // attachments by name only.
                            content: scrub(messageText(m.content)).slice(0, 2000),
                        })),
                };
            }),
        );
        const current = skills.published(found.containerId).find((skill) => skill.name === found.name);
        return c.json({
            proposal: found,
            evidence,
            current: current
                ? {
                      revision: current.revision,
                      description: current.description,
                      skillMd: current.files.find((file) => file.path === 'SKILL.md')?.content ?? '',
                  }
                : null,
        });
    });
    app.patch('/learning/proposals/:id', async (c) => {
        const found = proposal(c);
        if (!found) {
            return c.json({ error: 'Proposal not found.' }, 404);
        }
        if (found.status !== 'pending') {
            return c.json({ error: 'Only pending proposals can be edited.' }, 409);
        }
        const body = z
            .object({
                name: z.string().regex(SKILL_NAME).optional(),
                description: z.string().trim().min(1).max(500).optional(),
                skillMd: z.string().trim().min(1).max(20_000).optional(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json(
                {
                    error: 'Use a lowercase, hyphenated name, a one-line description, and a SKILL.md body.',
                },
                400,
            );
        }
        return c.json(learning.review(found.id, body.data, c.get('user').id));
    });
    app.post('/learning/proposals/:id/publish', (c) => {
        const found = proposal(c);
        if (!found) {
            return c.json({ error: 'Proposal not found.' }, 404);
        }
        if (found.status !== 'pending') {
            return c.json({ error: 'This proposal was already reviewed.' }, 409);
        }
        const user = c.get('user').id;
        const revision = skills.saveRevision(
            found.containerId,
            found.name,
            found.description,
            [
                {
                    path: 'SKILL.md',
                    content: skillMdFile(found.name, found.description, found.skillMd),
                },
            ],
            user,
        );
        skills.publish(revision.id, user);
        return c.json(learning.review(found.id, { status: 'published', revisionId: revision.id }, user));
    });
    // An admin's triage label of a conversation (CB-200): in force at once,
    // and part of the `learning` use's golden set. Only a signed-in admin.
    app.put('/learning/threads/:threadId/triage', requireAdminPerson, async (c) => {
        const triage = learning.seamTriage();
        const threadId = c.req.param('threadId');
        const body = z
            .object({ label: z.enum(LEARNING_LABELS) })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json({ error: `Send label as one of ${LEARNING_LABELS.join(', ')}.` }, 400);
        }
        const thread = workspace.thread(threadId);
        const container = thread ? evidence.containerOf(threadId) : undefined;
        if (!triage || !thread || !container) {
            return c.json({ error: 'That conversation is not Learning evidence.' }, 404);
        }
        await triage.relabel(threadId, body.data.label as LearningLabel, c.get('user').id);
        const [row] = triage.threads(container, evidence.analyzedThrough(container), { threadId, limit: 1 });
        return c.json(row ?? null);
    });
    app.post('/learning/proposals/:id/reject', (c) => {
        const found = proposal(c);
        if (!found) {
            return c.json({ error: 'Proposal not found.' }, 404);
        }
        if (found.status !== 'pending') {
            return c.json({ error: 'This proposal was already reviewed.' }, 409);
        }
        return c.json(learning.review(found.id, { status: 'rejected' }, c.get('user').id));
    });
    return app;
}
