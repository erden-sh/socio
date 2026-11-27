/**
 * What `context/`'s services and routes read of other features, by the slices
 * of their contracts. `layer.ts` builds them from the tags;
 * `composition/context.ts` gives them what no tag holds yet; the routes are
 * given them by whoever mounts them (the HTTP composition, from the graph's
 * tags). They replaced `platform-needs.ts`, which is gone.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { AbstractAgent } from '@ag-ui/client';

import type { SetupStatus } from '@socio/shared/types';

import type { CyclesShape } from '../cycles/contract.js';
import type { MediaShape } from '../media/contract.js';
import type { NoticesShape, OrchestratorShape, RoomsShape } from '../rooms/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { RunnerShape } from '../turns/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { ReactionReportsShape, SteeringQueue, WaitingTurnsShape } from './contract.js';

/**
 * Whether a conversation came from Telegram: `telegram/`'s
 * `LinksShape.threadInfo`, by its shape (telegram is above context in the
 * folder order, so this slice is stated here).
 */
export interface TelegramThreads {
    threadInfo(threadId: string): Promise<unknown>;
}

/**
 * A Dot's agent for a steering turn: `dots/`'s `DotAgentsShape`, by its
 * shape (dots is above context in the folder order, so this slice is
 * stated here; `layer.ts` gives it the `DotAgents` tag).
 */
export interface SteeringAgents {
    agent(request: {
        readonly dotId: string;
        readonly channel: boolean;
        readonly actingUserId?: string;
    }): AbstractAgent;
}

/**
 * What the steering turns read (`steering-turns.ts`, CB-151): each read at
 * the moment of use, as they always were.
 */
export interface SteeringTurnSources {
    /** The conversation's steering queue, on the workspace connection. */
    readonly queue: SteeringQueue;
    readonly runner: Pick<RunnerShape, 'onRunFinished' | 'knownMessageIds' | 'activeRunId' | 'run'>;
    readonly conversations: Pick<ConversationsShape, 'thread'>;
    readonly socios: Pick<SociosShape, 'dot'>;
    readonly people: Pick<PeopleShape, 'users'>;
    /**
     * The conversation's Telegram facts, if it came from Telegram
     * (`LinksShape.threadInfo`): a Telegram conversation has no steering.
     */
    readonly links: TelegramThreads;
    readonly settings: Pick<WorkspaceSettingsShape, 'settings'>;
    readonly orchestrator: Pick<OrchestratorShape, 'waiting' | 'route' | 'queueNamed' | 'dropAfter'>;
    readonly cycles: Pick<CyclesShape, 'limitsFor' | 'mayDispatch'>;
    readonly media: Pick<MediaShape, 'bindNew'>;
    /** The agent each turn started here runs (`DotAgentsShape`). */
    readonly agents: SteeringAgents;
    /** Whether the server is draining (CB-37), read when a turn would start. */
    draining(): boolean;
    /** What setup still misses (`AppStatus.setup`). */
    setup(): Promise<SetupStatus>;
    /** Operational lines only. */
    log(line: string): void;
}

/** The workspace as the reactions' and steering routes read it. */
export type RoutesWorkspace = Pick<ConversationsShape, 'thread' | 'access' | 'allows' | 'readableThread'> &
    Pick<PeopleShape, 'users'> & {
        /** The workspace connection, which the context's stores share. */
        readonly db: DatabaseSync;
        readonly telegram: TelegramThreads;
    };

/** What the reactions' routes read (`reaction-routes.ts`, CB-133). */
export interface ReactionRouteSources {
    readonly workspace: Pick<RoutesWorkspace, 'db' | 'readableThread' | 'access'>;
    readonly runner: Pick<RunnerShape, 'rowsMentioning' | 'messages' | 'runTrace' | 'toolActors'>;
    /**
     * The AI reply reports (CB-382): `cloud/`'s `ReplyReports`, by the slice
     * stated in the contract (cloud is above context in the folder order).
     * None: a thumbs-down is never a report.
     */
    readonly reports?: ReactionReportsShape;
    /** The running build's version: a web report's `appVersion`. */
    version?(): string;
}

/** What the steering routes read (`steering-routes.ts`, CB-151). */
export interface SteeringRouteSources {
    readonly workspace: RoutesWorkspace;
    readonly cycles: Pick<CyclesShape, 'limitsFor' | 'mayDispatch' | 'submit'>;
    readonly steering: Pick<WaitingTurnsShape, 'turn' | 'consider'>;
    readonly runner: Pick<RunnerShape, 'activeRunId'>;
    readonly media: Pick<MediaShape, 'attachment' | 'ref'>;
    readonly roomNotices: Pick<NoticesShape, 'record' | 'forget'>;
    readonly rooms: Pick<RoomsShape, 'cancelQueued'>;
}
