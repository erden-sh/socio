import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdminPerson } from '@socio/foundation/operations/require-admin-person';
import {
    CLASSIFY_USES,
    FAILURE_LABELS,
    THEME_OUTCOMES,
    THEME_TOPIC_CHARS,
    THEME_TOPICS,
    type ClassifyUse,
    type ClassifyUseView,
    type FailureLabelView,
    type SessionLabelRow,
    type SessionLabelView,
} from '@socio/shared/classify';
import { OPS_PAGE_LIMIT, type CursorPage } from '@socio/shared/operations/operations';

import type { AccessAuditShape } from '../operations/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { AuditShape, PeopleShape } from '../workspace/contract.js';

import { EvalRefused } from './eval.js';
import type { ClassifyService } from './service.js';
import { savedClassifySettings, useSettingsInput } from './settings.js';

const RUN_ID = /^[\w-]{1,128}$/;
const themesInput = z
    .object({
        topics: z.array(z.string().trim().min(1).max(THEME_TOPIC_CHARS)).min(1).max(THEME_TOPICS),
        outcome: z.enum(THEME_OUTCOMES),
    })
    .strict();
const intentInput = z.object({ value: z.string().max(64) }).strict();
const labelInput = z
    .object({
        level: z.enum(['turn', 'tool']),
        label: z.enum(FAILURE_LABELS as [string, ...string[]]),
    })
    .strict();

/**
 * What the routes read: the workspace's settings, which hold the uses'
 * settings, and its people and audit (the module reads them from the app's
 * services, `WorkspaceSettings`, `People` and `Audit`).
 */
export interface ClassifyRouteSources {
    readonly store: Pick<WorkspaceSettingsShape, 'settings' | 'updateSettings'>;
    readonly workspace: Pick<PeopleShape, 'users'> & Pick<AuditShape, 'audit'>;
}

/**
 * The seam's admin API (CB-198), on the module's admin-only app:
 * - `GET|PUT /classify/uses/:use`: a use's settings in force, the
 *   server's, and how it is doing (Operations → Settings);
 * - `POST /classify/uses/:use/evaluate`: evaluates its provider version
 *   against the golden set, in the background (202);
 * - `GET /classify/failures/:runId?level=`: a failure's labels and the
 *   scrubbed text the model is given. That is a turn's content, so it
 *   is on the access log (CB-188), as a trace is;
 * - `PUT /classify/failures/:runId/label`: an admin's label, in force at
 *   once and part of the golden set. Only a signed-in admin, never a key.
 * - `GET /classify/sessions?use=intent|themes`: sessions with a label of
 *   that use, newest first, cursor-paged (`unreviewed=1`: none of an
 *   admin yet); their topics come from people's words, so the list is on
 *   the access log (CB-199);
 * - `GET /classify/sessions/:runId`: a session's labels and the scrubbed
 *   title and first messages the model reads, on the access log;
 * - `PUT /classify/sessions/:runId/intent|themes`: an admin's labels, in
 *   force at once and each use's golden set.
 */
export function classifyRoutes(
    { store, workspace }: ClassifyRouteSources,
    service: ClassifyService,
    { audit }: AccessAuditShape,
) {
    const app = new Hono<AppEnv>();
    const useOf = (value: string) =>
        (CLASSIFY_USES as readonly string[]).includes(value) ? (value as ClassifyUse) : undefined;
    const names = (id: string) => workspace.users().find((user) => user.id === id)?.name;
    const noUse = { error: 'There is no such use.' };
    const noFailure = {
        error: 'There is no such failure, or its turn is still running.',
    };

    app.get('/classify/uses/:use', async (c) => {
        const use = useOf(c.req.param('use'));
        if (!use) {
            return c.json(noUse, 404);
        }
        return c.json<ClassifyUseView>(await service.view(use));
    });

    app.put('/classify/uses/:use', async (c) => {
        const use = useOf(c.req.param('use'));
        if (!use) {
            return c.json(noUse, 404);
        }
        const parsed = useSettingsInput.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: 'Send enabled as true or false, provider as workspace, threshold from 0.5 to 0.99, perDay as a whole number from 0 to 10000 and, for intent, labels as 2 to 16 distinct lowercase values with hints; null goes back to the server’s.',
                },
                400,
            );
        }
        if (parsed.data.labels !== undefined && use !== 'intent') {
            return c.json({ error: 'Only intent has a list of labels.' }, 400);
        }
        const before = {
            ...service.settings(use),
            ...(use === 'intent' ? { labels: service.intentLabels() } : {}),
        };
        await store.updateSettings({
            classify: savedClassifySettings(store.settings().classify, use, parsed.data),
        });
        const after = {
            ...service.settings(use),
            ...(use === 'intent' ? { labels: service.intentLabels() } : {}),
        };
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            workspace.audit({
                actor: c.get('user').id,
                action: 'update',
                targetKind: 'operations_settings',
                targetId: `classify:${use}`,
                detail: JSON.stringify({ before, after }),
            });
        }
        return c.json<ClassifyUseView>(await service.view(use));
    });

    app.post('/classify/uses/:use/evaluate', requireAdminPerson, async (c) => {
        const use = useOf(c.req.param('use'));
        if (!use) {
            return c.json(noUse, 404);
        }
        try {
            const started = await service.evaluate(c.get('user').id, use);
            if (!started) {
                return c.json({ error: 'An evaluation is already running.' }, 409);
            }
        } catch (error) {
            if (error instanceof EvalRefused) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
        return c.json<ClassifyUseView>(await service.view(use), 202);
    });

    app.get(
        '/classify/failures/:runId',
        audit({
            surface: 'failure-label',
            subject: (c) => {
                const runId = c.req.param('runId');
                return runId && RUN_ID.test(runId) ? { kind: 'run', id: runId } : undefined;
            },
            content: true,
            once: 'always',
        }),
        (c) => {
            const runId = c.req.param('runId');
            const level = c.req.query('level');
            if (!RUN_ID.test(runId) || (level !== 'turn' && level !== 'tool')) {
                return c.json({ error: 'Send level as turn or tool.' }, 400);
            }
            const subject = service.failures.subject(runId, level);
            if (!subject) {
                return c.json(noFailure, 404);
            }
            return c.json<FailureLabelView>(service.failures.view(subject, names));
        },
    );

    app.put('/classify/failures/:runId/label', requireAdminPerson, async (c) => {
        const runId = c.req.param('runId');
        const parsed = labelInput.safeParse(await c.req.json().catch(() => null));
        if (!RUN_ID.test(runId) || !parsed.success) {
            return c.json(
                {
                    error: `Send level as turn or tool, and label as one of ${FAILURE_LABELS.join(', ')}.`,
                },
                400,
            );
        }
        const subject = service.failures.subject(runId, parsed.data.level);
        if (!subject) {
            return c.json(noFailure, 404);
        }
        if (subject.rulesCategory !== 'unclassified') {
            return c.json(
                {
                    error: 'The rules already sort this failure; labels apply only to Unclassified ones.',
                },
                409,
            );
        }
        await service.failures.relabel(subject, parsed.data.label as (typeof FAILURE_LABELS)[number], c.get('user').id);
        return c.json<FailureLabelView>(service.failures.view(subject, names));
    });

    // Sessions' intent and themes (CB-199).
    const sessionUse = (value: string | undefined) => (value === 'intent' || value === 'themes' ? value : undefined);
    const noSession = {
        error: 'There is no such session, or its turn is still running.',
    };

    app.get(
        '/classify/sessions',
        audit({
            surface: 'session-labels',
            subject: () => ({ kind: 'workspace', id: null }),
            content: true,
            filters: (c) =>
                Object.fromEntries(
                    ['use', 'unreviewed'].flatMap((name) => {
                        const value = c.req.query(name);
                        return value ? [[name, value]] : [];
                    }),
                ),
            once: 'list',
        }),
        (c) => {
            const use = sessionUse(c.req.query('use'));
            const limit = Number(c.req.query('limit') ?? 20);
            const cursor = c.req.query('cursor');
            const before = cursor === undefined ? undefined : Number(cursor);
            if (
                !use ||
                !Number.isInteger(limit) ||
                limit < 1 ||
                limit > OPS_PAGE_LIMIT.max ||
                (before !== undefined && !(Number.isInteger(before) && before > 0))
            ) {
                return c.json(
                    {
                        error: `Send use as intent or themes, limit from 1 to ${OPS_PAGE_LIMIT.max}, and cursor as a list gave it.`,
                    },
                    400,
                );
            }
            const found = service.store.labelledSubjects(use, {
                before,
                limit: limit + 1,
                unreviewed: c.req.query('unreviewed') === '1',
            });
            const page = found.slice(0, limit);
            return c.json<CursorPage<SessionLabelRow>>({
                items: page.flatMap(({ runId }) => service.sessions.row(runId, names) ?? []),
                next: found.length > limit ? String(page.at(-1)!.seq) : null,
            });
        },
    );

    app.get(
        '/classify/sessions/:runId',
        audit({
            surface: 'session-label',
            subject: (c) => {
                const runId = c.req.param('runId');
                return runId && RUN_ID.test(runId) ? { kind: 'run', id: runId } : undefined;
            },
            content: true,
            once: 'always',
        }),
        (c) => {
            const runId = c.req.param('runId');
            if (!RUN_ID.test(runId)) {
                return c.json(noSession, 404);
            }
            const subject = service.sessions.subject(runId);
            const view = subject && service.sessions.view(subject, names);
            if (!view) {
                return c.json(noSession, 404);
            }
            return c.json<SessionLabelView>(view);
        },
    );

    app.put('/classify/sessions/:runId/:use', requireAdminPerson, async (c) => {
        const runId = c.req.param('runId');
        const use = sessionUse(c.req.param('use'));
        if (!RUN_ID.test(runId) || !use) {
            return c.json(noSession, 404);
        }
        const body = await c.req.json().catch(() => null);
        const subject = service.sessions.subject(runId);
        if (!subject) {
            return c.json(noSession, 404);
        }
        if (use === 'intent') {
            const parsed = intentInput.safeParse(body);
            const values = service.intentLabels().map((label) => label.value);
            if (!parsed.success || !values.includes(parsed.data.value)) {
                return c.json({ error: `Send value as one of ${values.join(', ')}.` }, 400);
            }
            await service.sessions.relabelIntent(subject, parsed.data.value, c.get('user').id);
        } else {
            const parsed = themesInput.safeParse(body);
            if (!parsed.success) {
                return c.json(
                    {
                        error: `Send topics as 1 to ${THEME_TOPICS} topics of at most ${THEME_TOPIC_CHARS} characters, and outcome as one of ${THEME_OUTCOMES.join(', ')}.`,
                    },
                    400,
                );
            }
            await service.sessions.relabelThemes(subject, parsed.data, c.get('user').id);
        }
        return c.json<SessionLabelView>(service.sessions.view(subject, names)!);
    });

    return app;
}
