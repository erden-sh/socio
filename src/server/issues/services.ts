import type { DatabaseSync } from 'node:sqlite';

import { afterCommitEvents } from '@socio/data/events';
import { sqliteData } from '@socio/data/open';

import type { PeopleSyncShape } from '../workspace/contract.js';

import { AgentActions } from './agent-actions.js';
import { IssueComponents } from './components.js';
import { BOARD_EVENT_FAILURES, type BoardEvents } from './domain/events.js';
import { DotFilings } from './filings.js';
import { sqliteBoardRepositories } from './infra/sqlite/index.js';
import { DotRequests } from './requests.js';
import { IssueStore } from './store.js';
import { IssueSubscriptions } from './subscriptions.js';
import { TriageProposals } from './triage-store.js';
import { IssueVotes } from './votes.js';

/**
 * What the Board's services ask of the workspace (people and Dots): the
 * workspace's `PeopleSync` port, where two reads may be left out.
 */
export interface BoardDependencies {
    userExists: PeopleSyncShape['userExists'];
    canManageDependencies?: PeopleSyncShape['canManageDependencies'];
    deactivated: PeopleSyncShape['deactivated'];
    dot: PeopleSyncShape['dot'];
    /** The person the Dot acts for, for the edit tool's role check (CB-286). */
    user?: PeopleSyncShape['user'];
}

/** The Board's services, as `sqliteBoard` builds them. */
export type SqliteBoard = ReturnType<typeof sqliteBoard>;

/**
 * The Board (CB-110's pilot context) on a migrated connection: its
 * services over the SQLite repositories and the connection's unit of work,
 * with its domain events delivered after commit.
 */
export function sqliteBoard(db: DatabaseSync, deps: BoardDependencies) {
    const data = sqliteData(db);
    const { uow } = data;
    const repos = sqliteBoardRepositories(data);
    const events = afterCommitEvents<BoardEvents>(uow, (type, error) =>
        console.error(BOARD_EVENT_FAILURES[type], error instanceof Error ? error.name : 'unknown'),
    );
    const issues = new IssueStore(uow, repos, events, deps.userExists, deps.deactivated);
    const votes = new IssueVotes(uow, repos.votes);
    const components = new IssueComponents(uow, repos.components, {
        record: (...args) => issues.record(...args),
        touch: (id, now) => repos.issues.touch(id, now),
    });
    return {
        issues,
        watches: new IssueSubscriptions(
            uow,
            repos.watches,
            issues,
            (id) => deps.userExists(id) && !deps.deactivated(id),
        ),
        requests: new DotRequests(uow, repos, issues, events, (id) => deps.dot(id)?.name),
        votes,
        filings: new DotFilings(
            uow,
            repos,
            issues,
            votes,
            deps.dot,
            // A socio acts on the board only for an active person (CB-528).
            (id) => deps.userExists(id) && !deps.deactivated(id),
            deps.canManageDependencies,
            deps.user,
            components,
        ),
        agentActions: new AgentActions(repos.audit, repos.queries),
        triage: new TriageProposals(uow, repos.triage),
        components,
    };
}
