import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJsonAsync } from '@socio/foundation/http/conditional';
import { requireAdmin } from '@socio/foundation/http/guards';
import { createRefusal, patchRefusal } from '@socio/foundation/issues/permissions';
import { issueRef, issueWatchInput, issueWatchPage } from '@socio/shared/issues/board-inputs';
import type { IssueComponentOptions } from '@socio/shared/issues/issue-components';
import {
    ISSUE_AREAS,
    ISSUE_ATTACHMENT_MAX_BYTES,
    ISSUE_CARDS_MAX,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_LINK_RELATIONS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type DotFiledItem,
    type DotRequestNotices,
    type Issue,
    type IssueAssignees,
    type IssueCard,
    type IssueImportResult,
    type IssueList,
    type IssueSearch,
    type IssueTitle,
} from '@socio/shared/issues/issue-types';
import { isAdmin } from '@socio/shared/roles';

import type { CountersShape } from '../live/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import type { PeopleShape, SociosShape } from '../workspace/contract.js';

import type { AutoTriage } from './auto-triage.js';
import { isIssueFailure, type IssueFailure, IssueError, type IssueRunTracesShape } from './contract.js';
import { issuesMarkdown, parseIssuesMarkdown } from './markdown.js';
import type { SqliteBoard } from './services.js';
import { commentInput, issueInput, issuePatch } from './store.js';
import { issueDetailView, issueListVersion, issueListView, issueSearchView, issueTitlesView } from './views.js';

/** Upload requests carry base64, so they get their own body limit. */
export const ATTACHMENT_UPLOAD_PATH = /^\/api\/issues\/[^/]+\/attachments$/;
const ATTACHMENT_BODY_LIMIT = Math.ceil(ISSUE_ATTACHMENT_MAX_BYTES / 3) * 4 + 64 * 1024;
const listFilter = z
    .object({
        status: z.enum(ISSUE_STATUSES).optional(),
        priority: z.enum(ISSUE_PRIORITIES).optional(),
        kind: z.enum(ISSUE_KINDS).optional(),
        area: z.enum(ISSUE_AREAS).optional(),
        label: z.enum(ISSUE_LABELS).optional(),
        assignee: z.string().max(64).optional(),
        q: z.string().max(200).optional(),
        /** A component ref (CB-442): exact match; one the reader can't see is unknown. */
        component: z.string().max(100).optional(),
    })
    .strict();
const upload = z
    .object({
        name: z.string().min(1).max(255),
        mediaType: z.string().max(100).optional(),
        data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
        commentId: z.string().min(1).max(64).optional(),
    })
    .strict();

function invalid(error: ZodError) {
    const issue = error.issues[0];
    if (issue?.code === 'unrecognized_keys') {
        return `Unknown field: ${issue.keys.join(', ')}.`;
    }
    const field = String(issue?.path[0] ?? '');
    if (field === 'title') {
        return 'Enter a title of 3 to 200 characters.';
    }
    if (field === 'body') {
        return 'Descriptions can be at most 20,000 characters; comments 10,000.';
    }
    return field ? `Unknown ${field}.` : 'Invalid request.';
}

/** Each typed failure's status: the edge's table, not the domain's. */
const ISSUE_STATUS = {
    IssueInvalid: 400,
    IssueForbidden: 403,
    IssueNotFound: 404,
    IssueConflict: 409,
    IssueTooLarge: 413,
    IssueUnsupportedType: 415,
} as const satisfies Record<IssueFailure['_tag'], number>;

/**
 * What the routes read of the platform, by contract slices: the Board,
 * auto-triage's apply and ignore, the runner's runs, and the workspace's
 * people, socios and change counters.
 */
export interface IssueRoutesPlatform {
    readonly autoTriage: Pick<AutoTriage, 'apply' | 'ignore'>;
    /** The Board, built once by the composition root (`BoardLive`). */
    readonly board: SqliteBoard;
    readonly runner: RunnerShape;
    readonly workspace: Pick<PeopleShape, 'users' | 'deactivatedUsers'> &
        Pick<SociosShape, 'dot'> & { readonly counters: CountersShape };
}

/**
 * The issue tracker. Everyone signed in reads all issues, comments and
 * attachments; members file into `triage`, comment, vote, and edit the
 * title and body of their own issues while in triage; admins change any
 * field, triage and delete. A filing from a run opens the run as Runs
 * does (`runs`, the runs' `RunsViews`).
 */
export function issueRoutes(platform: IssueRoutesPlatform, runs: IssueRunTracesShape) {
    const app = new Hono<AppEnv>();
    const { workspace, board } = platform;
    const issues = board.issues;
    const requests = board.requests;
    const numberOf = (c: Context<AppEnv>) => {
        const match = /^(?:CB-)?([1-9]\d{0,8})$/i.exec(c.req.param('number') ?? '');
        if (!match) {
            throw new IssueError('Issue not found.', 404);
        }
        return Number(match[1]);
    };
    const body = async (c: Context<AppEnv>) => c.req.json();
    const detail = (c: Context<AppEnv>, found: Issue) => issueDetailView(platform, found, c.get('user').id);
    /**
     * Files an issue with its components (CB-442), checked against the
     * filer's options, in one unit of work.
     */
    const fileWith = (components: readonly string[] | undefined, userId: string, create: () => Promise<Issue>) =>
        issues.transaction(async () => {
            const created = await create();
            if (components?.length) {
                await board.components.set(created.id, components, {
                    actorId: userId,
                    viewerId: userId,
                    initial: true,
                });
            }
            return created;
        }, 'file issue with components');

    const ownSubscriptions = (c: Context<AppEnv>) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            throw new IssueError('Sign in to manage your subscriptions.', 403);
        }
        return c.get('user').id;
    };
    app.get('/issues/subscriptions', async (c) => {
        const parsed = issueWatchPage.parse({
            limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
            offset: c.req.query('offset') === undefined ? undefined : Number(c.req.query('offset')),
        });
        return c.json(await board.watches.list(ownSubscriptions(c), parsed));
    });
    app.post('/issues/subscriptions', async (c) => {
        const userId = ownSubscriptions(c);
        const input = issueWatchInput.parse(await c.req.json());
        return c.json(
            await board.watches.create(userId, input, {
                sourceKind: 'person',
                sourceId: userId,
                threadId: null,
                causeId: null,
            }),
            201,
        );
    });
    app.delete('/issues/subscriptions/:id', async (c) =>
        c.json(await board.watches.cancel(ownSubscriptions(c), c.req.param('id'))),
    );

    app.get('/issues', (c) => {
        const filter = listFilter.safeParse(c.req.query());
        if (!filter.success) {
            return c.json({ error: invalid(filter.error) }, 400);
        }
        const { assignee, ...rest } = filter.data;
        // The board polls it: 304 when no issue changed (conditional.ts).
        return conditionalJsonAsync(
            c,
            (): Promise<IssueList> => issueListView(platform, { ...rest, assigneeId: assignee }, c.get('user').id),
            () => issueListVersion(workspace.counters, c.get('user').id),
        );
    });
    // The board's search box: the list has no descriptions to search (CB-71).
    app.get('/issues/search', async (c) => {
        const filter = z
            .object({ q: z.string().max(200) })
            .strict()
            .safeParse(c.req.query());
        if (!filter.success) {
            return c.json({ error: invalid(filter.error) }, 400);
        }
        return c.json<IssueSearch>(await issueSearchView(board, filter.data.q));
    });
    // The ⌘K palette's issue commands: no bodies.
    app.get('/issues/titles', async (c) => {
        const filter = z
            .object({ open: z.enum(['true', 'false']).optional() })
            .strict()
            .safeParse(c.req.query());
        if (!filter.success) {
            return c.json({ error: invalid(filter.error) }, 400);
        }
        return c.json<IssueTitle[]>(await issueTitlesView(board, { open: filter.data.open === 'true' }));
    });
    // Chat's issue cards (CB-87): a message's linked issues in one call, read
    // with the viewer's own session. Missing and deleted ones are left out.
    app.get('/issues/cards', async (c) => {
        const filter = z
            .object({ numbers: z.string().regex(/^[1-9]\d{0,8}(?:,[1-9]\d{0,8})*$/) })
            .strict()
            .safeParse(c.req.query());
        const numbers = filter.success ? [...new Set(filter.data.numbers.split(',').map(Number))] : [];
        if (!numbers.length || numbers.length > ISSUE_CARDS_MAX) {
            return c.json({ error: `Ask for 1 to ${ISSUE_CARDS_MAX} issue numbers.` }, 400);
        }
        return c.json<IssueCard[]>(await issues.cards(numbers));
    });
    // A Dot's home page (CB-89): what it filed for the person asking. Another
    // person's own Dot is missing, archived ones are listed.
    app.get('/issues/filed', async (c) => {
        const user = c.get('user');
        const dot = workspace.dot(c.req.query('dot') ?? '');
        if (!dot || (dot.ownerId && dot.ownerId !== user.id)) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        return c.json<DotFiledItem[]>(await board.filings.filedFor(dot.id, user.id));
    });
    app.post('/issues', async (c) => {
        // `runId`: filed from a run's "File issue" (CB-194), linked to it.
        const { runId, ...fields } = ((await body(c)) ?? {}) as {
            runId?: unknown;
        };
        const parsed = issueInput.safeParse(fields);
        if (!parsed.success) {
            return c.json({ error: invalid(parsed.error) }, 400);
        }
        const user = c.get('user');
        const refused = createRefusal(user, parsed.data);
        if (refused) {
            return c.json({ error: refused }, 403);
        }
        const { components, ...input } = parsed.data;
        if (runId === undefined || runId === null) {
            return c.json(
                await detail(c, await fileWith(components, user.id, () => issues.create(input, user.id))),
                201,
            );
        }
        // Only a run the person may open in Runs: theirs, or any for an admin.
        const run =
            typeof runId === 'string' && runId.length > 0 && runId.length <= 256
                ? runs.runTraceView({ id: user.id, admin: isAdmin(user) }, runId)
                : null;
        const threadId = run && platform.runner.runTrace(runId as string)?.threadId;
        if (!threadId) {
            return c.json({ error: 'Run not found.' }, 404);
        }
        return c.json(
            await detail(
                c,
                await fileWith(components, user.id, () =>
                    issues.createFromRun(input, user.id, {
                        runId: run.view.runId,
                        threadId,
                    }),
                ),
            ),
            201,
        );
    });
    // An ISSUES.md file in and out. Import keeps the file's numbers and skips
    // any that exist, so re-running it changes nothing.
    app.post('/issues/import', requireAdmin, async (c) => {
        const parsed = z
            .object({ markdown: z.string().min(1).max(900_000) })
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Send the ISSUES.md text as markdown.' }, 400);
        }
        return c.json<IssueImportResult>(await issues.import(parseIssuesMarkdown(parsed.data.markdown)));
    });
    app.get('/issues/export.md', async (c) => {
        c.header('Content-Type', 'text/markdown; charset=utf-8');
        c.header('Content-Disposition', 'attachment; filename="ISSUES.md"');
        return c.body(issuesMarkdown(await issues.list()));
    });
    // Who an admin can assign: everyone signed in at least once, but not
    // deactivated people, listed apart so the picker can mark an issue's
    // current assignee.
    app.get('/issues/assignees', requireAdmin, (c) => {
        const deactivated = workspace.deactivatedUsers();
        const people = workspace.users().map(({ id, name }) => ({ id, name }));
        return c.json<IssueAssignees>({
            users: people.filter((person) => !deactivated.has(person.id)),
            deactivated: people.filter((person) => deactivated.has(person.id)),
        });
    });
    // The component picker's choices (CB-442): what this person may tag.
    app.get('/issues/components', (c) =>
        c.json<IssueComponentOptions>({ options: board.components.options(c.get('user').id) }),
    );
    app.get('/issues/:number', async (c) => c.json(await detail(c, await issues.require(numberOf(c)))));
    // Blocked-by links (CB-29): triage fields, so admins only.
    app.post('/issues/:number/blocked-by', requireAdmin, async (c) => {
        const number = numberOf(c);
        const parsed = z
            .object({
                blocker: z.union([z.number().int().positive(), issueRef]),
            })
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Send the blocking issue as CB-12.' }, 400);
        }
        const { blocker } = parsed.data;
        await issues.addBlocker(
            number,
            typeof blocker === 'number' ? blocker : Number(/(\d+)$/.exec(blocker)![1]),
            c.get('user').id,
        );
        return c.json(await detail(c, await issues.require(number)));
    });
    app.delete('/issues/:number/blocked-by/:blocker', requireAdmin, async (c) => {
        const number = numberOf(c);
        const blocker = /^(?:CB-)?([1-9]\d{0,8})$/i.exec(c.req.param('blocker'));
        if (!blocker) {
            return c.json({ error: 'Issue not found.' }, 404);
        }
        await issues.removeBlocker(number, Number(blocker[1]), c.get('user').id);
        return c.json(await detail(c, await issues.require(number)));
    });
    // The side panel's link editor (CB-274): the link between two issues is
    // related, or one blocks the other; setting it replaces what was there.
    // Anyone signed in relates issues and lifts related links; blocking links
    // are triage fields like blocked-by, so only admins make, change or lift
    // them, or replace one with a related link. A missing or deleted issue is
    // a 404 before any of that, for everyone alike.
    const otherOf = (c: Context<AppEnv>) => {
        const match = /^(?:CB-)?([1-9]\d{0,8})$/i.exec(c.req.param('other') ?? '');
        if (!match) {
            throw new IssueError('Issue not found.', 404);
        }
        return Number(match[1]);
    };
    app.put('/issues/:number/links/:other', async (c) => {
        const number = numberOf(c);
        const other = otherOf(c);
        const parsed = z
            .object({ relation: z.enum(ISSUE_LINK_RELATIONS) })
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Send the relation: related, blocks or blocked_by.' }, 400);
        }
        const user = c.get('user');
        await issues.setLink(number, other, parsed.data.relation, user.id, {
            blocking: isAdmin(user),
        });
        return c.json(await detail(c, await issues.require(number)));
    });
    app.delete('/issues/:number/links/:other', async (c) => {
        const number = numberOf(c);
        const user = c.get('user');
        await issues.unlink(number, otherOf(c), user.id, {
            blocking: isAdmin(user),
        });
        return c.json(await detail(c, await issues.require(number)));
    });
    // Automatic triage (CB-30): an admin accepts or ignores the proposal.
    app.post('/issues/:number/triage/apply', requireAdmin, async (c) => {
        const found = await platform.autoTriage.apply(numberOf(c), c.get('user').id);
        return c.json(await detail(c, found));
    });
    app.post('/issues/:number/triage/ignore', requireAdmin, async (c) => {
        const found = await platform.autoTriage.ignore(numberOf(c), c.get('user').id);
        return c.json(await detail(c, found));
    });
    app.patch('/issues/:number', async (c) => {
        const number = numberOf(c);
        const parsed = issuePatch.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: invalid(parsed.error) }, 400);
        }
        const user = c.get('user');
        const current = await issues.require(number);
        const refused = patchRefusal(user, current, parsed.data);
        if (refused) {
            return c.json({ error: refused }, 403);
        }
        const { components, ...patch } = parsed.data;
        const updated = await issues.transaction(async () => {
            const changed = await issues.update(number, patch, user.id);
            // Replaces only the refs this admin may see; the rest stay (CB-442).
            if (components !== undefined) {
                await board.components.set(current.id, components, { actorId: user.id, viewerId: user.id });
                return issues.require(number);
            }
            return changed;
        }, 'update issue with components');
        return c.json(await detail(c, updated));
    });
    // CB-64: hidden for everyone and kept (comments, files and history too).
    app.delete('/issues/:number', requireAdmin, async (c) => {
        await issues.remove(numberOf(c), c.get('user').id);
        return c.json({ ok: true });
    });

    // Upvotes (CB-83): everyone signed in, one live vote each; voting
    // again or withdrawing a vote you don't have changes nothing.
    app.post('/issues/:number/vote', async (c) => {
        const issue = await issues.require(numberOf(c));
        await board.votes.cast(issue.id, c.get('user').id);
        return c.json(await detail(c, issue));
    });
    app.delete('/issues/:number/vote', async (c) => {
        const issue = await issues.require(numberOf(c));
        await board.votes.withdraw(issue.id, c.get('user').id);
        return c.json(await detail(c, issue));
    });

    app.post('/issues/:number/comments', async (c) => {
        const number = numberOf(c);
        const parsed = commentInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: invalid(parsed.error) }, 400);
        }
        return c.json(await issues.addComment(number, parsed.data.body, c.get('user').id), 201);
    });
    app.patch('/issues/:number/comments/:id', async (c) => {
        const number = numberOf(c);
        const parsed = commentInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: invalid(parsed.error) }, 400);
        }
        const user = c.get('user');
        const comment = await issues.comment(number, c.req.param('id'));
        if (comment.authorKind !== 'user' || comment.authorId !== user.id) {
            return c.json({ error: 'You can edit only your own comments.' }, 403);
        }
        return c.json(await issues.editComment(number, comment.id, parsed.data.body, user.id));
    });
    app.delete('/issues/:number/comments/:id', async (c) => {
        const number = numberOf(c);
        const user = c.get('user');
        const comment = await issues.comment(number, c.req.param('id'));
        // A Dot's comment is also the person's it was for (CB-84).
        const forUser =
            comment.authorKind === 'agent' &&
            (await board.filings.commentAttributions(comment.issueId)).get(comment.id)?.userId === user.id;
        if (!isAdmin(user) && comment.authorId !== user.id && !forUser) {
            return c.json({ error: 'You can delete only your own comments.' }, 403);
        }
        await issues.deleteComment(number, comment.id, user.id);
        return c.json({ ok: true });
    });

    app.post(
        '/issues/:number/attachments',
        bodyLimit({
            maxSize: ATTACHMENT_BODY_LIMIT,
            onError: (c) => c.json({ error: 'Attachments can be at most 5 MB.' }, 413),
        }),
        async (c) => {
            const number = numberOf(c);
            const parsed = upload.safeParse(await body(c));
            if (!parsed.success) {
                return c.json({ error: 'Send the file as base64 with its name.' }, 400);
            }
            const user = c.get('user');
            const { name, mediaType, data, commentId } = parsed.data;
            if (commentId) {
                const comment = await issues.comment(number, commentId);
                if (!isAdmin(user) && comment.authorId !== user.id) {
                    return c.json({ error: 'You can attach files only to your own comments.' }, 403);
                }
            }
            return c.json(
                await issues.addAttachment(
                    number,
                    { name, mediaType, data: Buffer.from(data, 'base64'), commentId },
                    user.id,
                ),
                201,
            );
        },
    );
    // Served with the type detected at upload. Only images display inline;
    // everything else downloads. The sandbox CSP stops any script running.
    app.get('/issue-attachments/:id', async (c) => {
        const file = await issues.attachment(c.req.param('id'));
        if (!file) {
            return c.json({ error: 'Attachment not found.' }, 404);
        }
        const disposition = file.mediaType.startsWith('image/') ? 'inline' : 'attachment';
        const ascii = file.name.replace(/[^\x20-\x7e]/g, '_');
        c.header('Content-Type', file.mediaType);
        c.header('X-Content-Type-Options', 'nosniff');
        c.header(
            'Content-Disposition',
            `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        );
        c.header('Content-Security-Policy', "default-src 'none'; sandbox");
        return c.body(new Uint8Array(file.data));
    });
    app.delete('/issue-attachments/:id', async (c) => {
        const user = c.get('user');
        const file = await issues.attachment(c.req.param('id'));
        if (!file) {
            return c.json({ error: 'Attachment not found.' }, 404);
        }
        if (!isAdmin(user) && file.uploaderId !== user.id) {
            return c.json({ error: 'You can delete only your own attachments.' }, 403);
        }
        await issues.deleteAttachment(file.id, user.id);
        return c.json({ ok: true });
    });

    // The caller's own notices about Dot requests that closed: shown once
    // in the app, then marked seen.
    app.get('/dot-requests/notices', async (c) =>
        c.json<DotRequestNotices>({
            notices: await requests.notices(c.get('user').id),
        }),
    );
    app.post('/dot-requests/notices/seen', async (c) => {
        const parsed = z
            .object({ ids: z.array(z.string().min(1).max(64)).max(50) })
            .strict()
            .safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Send the notice ids as ids.' }, 400);
        }
        return c.json({
            seen: await requests.markSeen(c.get('user').id, parsed.data.ids),
        });
    });

    app.onError((error, c) => {
        // A typed failure from an Effect handler.
        if (isIssueFailure(error)) {
            return c.json({ error: error.message }, ISSUE_STATUS[error._tag]);
        }
        if (error instanceof IssueError) {
            return c.json({ error: error.message }, error.status);
        }
        if (error instanceof ZodError) {
            return c.json({ error: invalid(error) }, 400);
        }
        if (error instanceof SyntaxError) {
            return c.json({ error: 'Invalid JSON request.' }, 400);
        }
        console.error('Issue request failed:', error.name);
        return c.json({ error: 'The issue tracker could not complete this request.' }, 500);
    });
    return app;
}
