/**
 * What coding sessions are made of: the slices of other features' tags they
 * call, by their contracts, and what no tag offers yet (`CodingHostShape`).
 * `layer.ts` gathers them from the tags, with `CodingHost` from the composition
 * (`composition/coding.ts`). Nothing here names a feature's class.
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ActorsShape } from '../actors/contract.js';
import type { ApprovalsShape } from '../approvals/contract.js';
import type { ComputersShape } from '../computers/contract.js';
import type { FlagsShape } from '../flags/contract.js';
import type { InferenceShape } from '../inference/contract.js';
import type { NotifierShape } from '../notifications/contract.js';
import type { RuntimeIdentityShape } from '../runtime/contract.js';
import type { LimitsShape, WorkspaceSettingsShape } from '../settings/contract.js';
import type { ChannelShape, LinksShape } from '../telegram/contract.js';
import type { PlatformTurnOptions, RunnerShape, TurnOutcome } from '../turns/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { CodingConfigShape, CodingGatewayShape } from './contract.js';

/** The workspace as coding reads it: its slices' members it calls, and the Telegram links. */
export type CodingWorkspace = Pick<ConversationsShape, 'thread' | 'allows'> &
    Pick<PeopleShape, 'users' | 'hasUser' | 'isDeactivated'> &
    Pick<SociosShape, 'dot' | 'canUseDot'> & {
        readonly telegram: Pick<LinksShape, 'threadInfo' | 'reaches'>;
    };

/**
 * What coding sessions need that no feature's tag offers yet: the
 * workspace's connection (their rows share it), the drain and the
 * Telegram channel, both read at the moment of use (their ports, set
 * after the graph is built), a Dot's turn (`AppTurns.turnOutcome`), and
 * the operational log.
 */
export interface CodingHostShape {
    /** The workspace's connection, migrated at boot. */
    readonly db: DatabaseSync;
    /** Set on SIGTERM (CB-37), read at the moment of use. */
    draining(): boolean;
    /** The Telegram channel, when configured: set after the graph is built. */
    telegram(): ChannelShape | undefined;
    /** A Dot's turn in a conversation (`AppTurns.turnOutcome`). */
    turnOutcome(
        threadId: string,
        prompt: string,
        signal: AbortSignal,
        options?: PlatformTurnOptions,
    ): Promise<TurnOutcome>;
    /** Operational lines only. */
    log(line: string): void;
}

/** Everything a coding sessions service is made of. */
export interface CodingParts {
    readonly host: CodingHostShape;
    readonly config: CodingConfigShape;
    readonly actors: ActorsShape;
    readonly approvals: ApprovalsShape;
    readonly computers: Pick<ComputersShape, 'disk'>;
    readonly flags: Pick<FlagsShape, 'enabled'>;
    readonly gateway: CodingGatewayShape;
    readonly inference: Pick<InferenceShape, 'options' | 'personalCodingPlanFor'>;
    readonly limits: Pick<LimitsShape, 'turnTimeLimitMs'>;
    readonly notifications: Pick<NotifierShape, 'notify'>;
    readonly runner: Pick<RunnerShape, 'onRunFinished' | 'activeRunId'>;
    readonly runtime: Pick<RuntimeIdentityShape, 'attach'>;
    readonly settings: Pick<WorkspaceSettingsShape, 'settings'>;
    readonly workspace: CodingWorkspace;
}
