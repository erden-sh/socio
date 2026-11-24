import { dotRequestLimits } from '@socio/foundation/issues/settings';

import { Counters } from '../live/contract.js';
import type { ModuleServicesAccess, ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';
import { People, Socios } from '../workspace/contract.js';

import { Deliveries, Goals, IssueRunTraces, IssuesConfig, Leadership, MediaFiles } from './contract.js';
import { FILING_TOOL_NAMES, filingTools } from './filing-tools.js';
import { issuesSchema } from './migrations.js';
import { requestTools, resolvedRequestNews } from './request-tools.js';
import { issueRoutes, type IssueRoutesPlatform } from './routes.js';
import { issueSubscriptionTools, ISSUE_WATCH_TOOL_NAMES } from './subscription-tools.js';
import { AutoTriageInstance, SqliteBoardService } from './tags.js';

/**
 * What the routes read (`IssueRoutesPlatform`), from the app's services at
 * the moment of use: the Board and auto-triage (`tags.ts`), the runner,
 * and the people, socios and change counters.
 */
const routesOf = (services: ModuleServicesAccess): IssueRoutesPlatform => {
    const people = services.get(People);
    const socios = services.get(Socios);
    return {
        autoTriage: services.get(AutoTriageInstance),
        board: services.get(SqliteBoardService),
        runner: services.get(Runner),
        workspace: {
            users: () => people.users(),
            deactivatedUsers: () => people.deactivatedUsers(),
            dot: (id) => socios.dot(id),
            counters: services.get(Counters),
        },
    };
};

/**
 * The issue tracker; attachments are served from their own path, and the
 * notices about Dot requests from `dot-requests`. While the platform runs,
 * each such notice also goes to the user's linked Telegram as a direct
 * message, when the bot is online. Dots an admin allowed get the
 * Improvements board tools (CB-31, CB-83, CB-84).
 */
export const issuesModule: ServerModule = {
    ...issuesSchema,
    paths: ['issues', 'issue-attachments', 'dot-requests'],
    // A run's trace is the runs' `RunsViews`, as `IssueRunTraces`, from the
    // app's services.
    routes: ({ services }) => issueRoutes(routesOf(services), services.get(IssueRunTraces)),
    // The limits are the workspace's settings over `IssuesConfig`, which also
    // has the app's origin, from the app's services; so are the Board,
    // a goal by its task (`Goals`) and the turn's files (`MediaFiles`).
    dotTools: ({ services }, turn) => {
        const config = services.get(IssuesConfig);
        const limits = dotRequestLimits(services.get(WorkspaceSettings).settings(), config.dotRequestLimits);
        const board = services.get(SqliteBoardService);
        const goals = services.get(Goals);
        const media = services.get(MediaFiles);
        return [
            // Every Dot may ask for a capability it lacks.
            ...requestTools(board.requests, turn.dot.id, turn.userId, turn.check, limits),
            ...issueSubscriptionTools(board.watches, turn, (taskId) => goals.byTask(taskId)),
            ...filingTools(board.filings, turn, {
                limits,
                origin: config.appOrigin,
                goalOf: (taskId) => goals.byTask(taskId),
                files: (ids) => media.turnFiles(turn, ids),
            }),
        ];
    },
    dotNews: ({ services }, turn) =>
        resolvedRequestNews(services.get(SqliteBoardService).requests, turn.dot.id, turn.userId),
    capabilities: ({ services }) => [
        {
            id: 'improvements',
            label: 'Improvements board',
            description:
                'The team’s board of issues, feature requests and improvements. Search it (open and closed items, by title and description) and read an item. When the person you act for explicitly asks: file an item (it lands in triage), vote for one as them, add their evidence to one as a comment, with the screenshots and files they shared in this conversation attached, edit the title or description of one of their own triage items, or change one item’s status within what their role allows; each is recorded with you and them. For a capability you lack yourself, use request_capability instead.',
            tools: [...FILING_TOOL_NAMES, ...ISSUE_WATCH_TOOL_NAMES],
            status: async (turn) => {
                if (!turn.dot.issuesAllowed) {
                    return {
                        enabled: false,
                        note: 'An admin can turn on “File to the Improvements board” in this socio’s settings.',
                    };
                }
                const limits = dotRequestLimits(
                    services.get(WorkspaceSettings).settings(),
                    services.get(IssuesConfig).dotRequestLimits,
                );
                const used = (action: 'filing' | 'comment' | 'vote') =>
                    services
                        .get(SqliteBoardService)
                        .filings.usage(turn.dot.id, turn.userId, limits.windowMs, Date.now(), action);
                const filed = await used('filing');
                const commented = await used('comment');
                const voted = await used('vote');
                return {
                    enabled: true,
                    // Each of filing, commenting and voting counts on its own.
                    limits: {
                        perDotDaily: limits.perDot,
                        perPersonDaily: limits.perUser,
                    },
                    usage: {
                        filedByYouToday: filed.byDot,
                        filedForPersonToday: filed.byUser,
                        commentsByYouToday: commented.byDot,
                        commentsForPersonToday: commented.byUser,
                        voteChangesByYouToday: voted.byDot,
                        voteChangesForPersonToday: voted.byUser,
                    },
                };
            },
        },
    ],
    // The leader work: `IssuesBackground.lead` in a leader scope, through the
    // runtime.
    start: ({ services }) => services.get(Leadership).start(),
    // Requests a dead process left waiting for the model end as failed.
    succeed: ({ services }) => services.get(AutoTriageInstance).recover(),
    release: ({ services }) => services.get(AutoTriageInstance).stop(),
    tick: {
        everyMs: 30_000,
        run: ({ services }) => services.get(Leadership).tick(),
    },
    // The scope's cleanup stops what started; auto-triage and app
    // deliveries stop on every stop, as before, so a stop without a start
    // (or after a failed one) still stops them.
    stop: async ({ services }) => {
        const stopped = await services.get(Leadership).stop();
        if (!stopped.autoTriageStopped) {
            services.get(AutoTriageInstance).stop();
        }
        if (!stopped.deliveriesStopped) {
            await services.get(Deliveries).stop();
        }
    },
};
