import { boardExcerpt, boardMatches } from '@socio/foundation/issues/board-matches';
import {
    issueSummary,
    type Issue,
    type IssueDetail,
    type IssueList,
    type IssueSearch,
    type IssueTitle,
    type TriageProposal,
} from '@socio/shared/issues/issue-types';

import type { CountersShape } from '../live/contract.js';
import type { PeopleShape, SociosShape } from '../workspace/contract.js';

import { triageReason } from './auto-triage.js';
import { TRIAGE_AUTHOR, type BoardShape, type IssueFilter, type IssuesViewsShape } from './contract.js';

/**
 * The issue views (`IssuesViews`), moved here from `live/views/issues.ts`,
 * with the list's version from `live/view-versions.ts`. The pages read them
 * through the tag; live's copies are gone.
 */

/** What the views read: the Board, and the people and socios they name. */
export interface IssueViewSources {
    readonly board: BoardShape;
    readonly workspace: Pick<PeopleShape, 'users'> & Pick<SociosShape, 'dot'>;
}

/**
 * Names for the ids an issue view mentions. Besides users: `import`, and
 * the authors of agent comments, `dot:<id>`.
 */
function issueNames(sources: Pick<IssueViewSources, 'workspace'>, ids: Array<string | null>) {
    const { workspace } = sources;
    const users = new Map(workspace.users().map((u) => [u.id, u.name]));
    const nameOf = (id: string) =>
        users.get(id) ??
        (id === 'import'
            ? 'Imported'
            : id === TRIAGE_AUTHOR
              ? 'Automatic triage'
              : id.startsWith('dot:')
                ? (workspace.dot(id.slice(4))?.name ?? 'A deleted socio')
                : id);
    return Object.fromEntries([...new Set(ids)].filter((id): id is string => !!id).map((id) => [id, nameOf(id)]));
}

/** Dot requests carry their demand count; other issues don't. */
async function withDemand(board: BoardShape, list: Issue[]) {
    const demand = await board.requests.demand();
    return list.map((issue) => (demand.has(issue.id) ? { ...issue, demand: demand.get(issue.id) } : issue));
}

/**
 * Upvotes (CB-83): the count when there are any, and whether `userId`
 * voted. Counts are team-shared; only the caller's own vote is shown.
 */
async function withVotes(board: BoardShape, list: Issue[], userId?: string) {
    const { votes } = board;
    const counts = await votes.counts();
    const mine = userId ? await votes.mine(userId) : new Set<string>();
    return list.map((issue) => {
        const count = counts.get(issue.id);
        if (!count) {
            return issue;
        }
        return {
            ...issue,
            votes: count,
            ...(mine.has(issue.id) ? { voted: true } : {}),
        };
    });
}

/** Blocked-by links (CB-29): which blockers are still open, when any. */
async function withBlockers(board: BoardShape, list: Issue[]) {
    const open = await board.issues.openBlockerNumbers();
    return list.map((issue) => (open.has(issue.id) ? { ...issue, openBlockers: open.get(issue.id) } : issue));
}

/**
 * `GET /api/issues`: every issue (team-shared) as the board shows it, an
 * excerpt instead of its body (CB-71), and the assignees' names; the vote
 * counts, and which of them the caller voted for.
 */
export async function issueListView(
    sources: IssueViewSources,
    filter: IssueFilter = {},
    userId?: string,
): Promise<IssueList> {
    const { board } = sources;
    const { component, ...rest } = filter;
    // Components (CB-442): only the refs this reader may see; a filter on
    // one they can't see is refused as unknown, so it can't probe.
    if (component) {
        await board.components.checkFilter(userId ?? '', component);
    }
    const tags = await board.components.view(userId ?? '');
    const issues = (await board.issues.list(rest))
        .map((issue) => ({ ...issue, components: tags.byIssue.get(issue.id) ?? [] }))
        .filter((issue) => !component || issue.components.includes(component));
    const list = (await withVotes(board, await withDemand(board, await withBlockers(board, issues)), userId)).map(
        (issue) => issueSummary(issue, boardExcerpt),
    );
    const shown = new Set(list.flatMap((issue) => issue.components));
    return {
        issues: list,
        users: issueNames(
            sources,
            list.map((issue) => issue.assigneeId),
        ),
        components: Object.fromEntries(Object.entries(tags.labels).filter(([ref]) => shown.has(ref))),
    };
}

/**
 * `GET /api/issues/search?q=`: the numbers of the live issues whose key,
 * title or description has every word of `q`, in the list's order. The
 * board's search box, now that the list has no descriptions.
 */
export async function issueSearchView(board: BoardShape, q: string): Promise<IssueSearch> {
    return {
        numbers: boardMatches(await board.issues.list(), q),
    };
}

/**
 * `GET /api/issues/titles`: every live issue's number, title and status,
 * in the list's order; `open` (`?open=true`) leaves closed ones out. The
 * ⌘K palette's issue commands. Issues are team-shared, so
 * this is the same for every signed-in user.
 */
export function issueTitlesView(board: BoardShape, { open = false }: { open?: boolean } = {}): Promise<IssueTitle[]> {
    return board.issues.titles({ open });
}

/**
 * `GET /api/issues/:number`: one live issue with its comments and history,
 * its votes and whether `userId` voted, and who each Dot comment was for.
 */
export async function issueDetailView(sources: IssueViewSources, found: Issue, userId?: string): Promise<IssueDetail> {
    const { board } = sources;
    const { issues, requests, filings, agentActions, triage, components } = board;
    const viewer = userId ?? '';
    const tags = await components.view(viewer, [found.id]);
    const [issue] = (await withVotes(
        board,
        await withDemand(
            board,
            await withBlockers(board, [{ ...found, components: tags.byIssue.get(found.id) ?? [] }]),
        ),
        userId,
    )) as [Issue];
    const dots = await filings.commentAttributions(issue.id);
    // Connected agents (CB-90): the record is the person's, the agent beside it.
    const agents = await agentActions.commentAttributions(issue.id);
    const comments = (await issues.comments(issue.id)).map((comment) => {
        const dot = dots.get(comment.id);
        const agent = agents.get(comment.id);
        return dot ? { ...comment, dot } : agent ? { ...comment, agent } : comment;
    });
    const attachments = await issues.attachments(issue.id);
    // A `components` row keeps only the refs this reader may see (CB-442).
    const shownHistory = await components.visibleEvents(viewer, issue.id, await issues.events(issue.id));
    const history = shownHistory.events;
    const byAgent = await agentActions.eventAttributions(issue.id, history);
    const byDot = await filings.eventAttributions(issue.id);
    const events = history.map((event) => {
        const agent = byAgent.get(event.id);
        const dot = byDot.get(event.id);
        return dot ? { ...event, dot } : agent ? { ...event, agent } : event;
    });
    // Team-shared like the rest of the issue: everyone signed in sees who
    // asked, by Dot and user name, as they see authors.
    const requesters = (await requests.isRequest(issue.id)) ? await requests.requesters(issue.id) : undefined;
    // Filed by a Dot (CB-31): the Dot and the person it acted for.
    const filedBy = await filings.filing(issue.id);
    const filedByAgent = await agentActions.filing(issue.id);
    const stored = await triage.get(issue.id);
    // Suggested components: admins see every one, others only what they may
    // see as tags (CB-442).
    const suggested = stored && components.visibleRefs(viewer, stored.components, await components.rowsOf(issue.id));
    // Its reason too, when the model wrote it knowing every name.
    let proposal: TriageProposal | undefined;
    if (stored) {
        const { reasonAudience: _audience, ...shown } = stored;
        proposal = {
            ...shown,
            components: suggested!.keys,
            reason: triageReason(stored, components.isAdmin(viewer)),
        };
    }
    return {
        issue,
        comments,
        attachments,
        events,
        blockedBy: await issues.blockedBy(issue.id),
        blocks: await issues.blocks(issue.id),
        related: await issues.related(issue.id),
        ...(proposal ? { triage: proposal } : {}),
        ...(requesters ? { requesters } : {}),
        ...(filedBy ? { filedBy } : {}),
        ...(filedByAgent ? { filedByAgent } : {}),
        users: issueNames(sources, [
            ...(filedBy ? [`dot:${filedBy.dotId}`, filedBy.userId] : []),
            ...(requesters ?? []).flatMap((row) => [`dot:${row.dotId}`, row.userId]),
            issue.reporterId,
            issue.assigneeId,
            ...comments.flatMap((comment) => [comment.authorId, comment.dot?.userId ?? null]),
            ...attachments.map((file) => file.uploaderId),
            ...events.flatMap((event) => [event.actorId, event.dot?.userId ?? null]),
            ...(proposal ? [proposal.decidedBy] : []),
        ]),
        components: { ...shownHistory.labels, ...suggested?.labels, ...tags.labels },
    };
}

/**
 * `GET /api/issues`'s version: issues with labels, demand and votes, and
 * the names of the users and Dots they mention; the same for everyone, but
 * for which items the user voted for (votes bump `issues`).
 */
export const issueListVersion = (counters: CountersShape, userId: string) =>
    // Who sees a component tag, and its name, follow the apps, the plugins
    // and Space membership (CB-442).
    `${userId}|${counters.read(['issues', 'users', 'dots', 'apps', 'plugins', 'spaces'])}`;

/** The views over their sources, as the `IssuesViews` tag offers them. */
export function issuesViews(sources: IssueViewSources, counters: CountersShape): IssuesViewsShape {
    return {
        listView: (filter, userId) => issueListView(sources, filter, userId),
        listVersion: (userId) => issueListVersion(counters, userId),
        searchView: (q) => issueSearchView(sources.board, q),
        titlesView: (options) => issueTitlesView(sources.board, options),
        detailView: (found, userId) => issueDetailView(sources, found, userId),
    };
}
