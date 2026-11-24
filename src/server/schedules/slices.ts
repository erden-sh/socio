import type { DataContext } from '@socio/data/uow';

import type { ComputerRecordsShape } from '../computers/contract.js';
import type { TelegramThreadInfo } from '../integrations/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { AuditShape, ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

import type { TaskService } from './tasks.js';

/**
 * The part of the core store this folder calls: the workspace settings,
 * and this folder's own `TaskService` (`ownedTask` is `TaskService.owned`).
 * The composition builds it (`schedulesStoreOf`).
 */
export type SchedulesStore = Pick<WorkspaceSettingsShape, 'settings'> &
    Pick<
        TaskService,
        | 'scheduleMinGapMs'
        | 'action'
        | 'activeScheduleCount'
        | 'createSchedule'
        | 'endAfterRun'
        | 'goalScheduleCandidates'
        | 'jobSchedules'
        | 'recentRuns'
        | 'scheduleCounts'
        | 'schedules'
        | 'taskRuns'
    > & {
        ownedTask: TaskService['owned'];
    };

/**
 * The part of `WorkspaceStore` this folder calls, as the workspace
 * contract's slices (`audit` records a job's delete), plus the sub-stores that have no tag yet (its unit of
 * work, Telegram links, computer permissions). `WorkspaceStore` satisfies it.
 */
export type SchedulesWorkspace = Pick<PeopleShape, 'isDeactivated'> &
    Pick<SociosShape, 'dot' | 'canUseDot'> &
    Pick<AuditShape, 'audit'> &
    Pick<ConversationsShape, 'allows' | 'bindTask' | 'bindThread' | 'requireOwnedThread' | 'taskThread' | 'thread'> & {
        readonly data: DataContext;
        /**
         * Telegram's links: the slice of `telegram/`'s `LinksShape` this
         * folder calls, typed here so it doesn't import `telegram/`, which
         * sits above it.
         */
        readonly telegram: {
            readonly threadInfo: (threadId: string) => Promise<TelegramThreadInfo | undefined>;
            readonly reaches: (conversation: TelegramThreadInfo, userId: string) => Promise<boolean>;
        };
        readonly computers: Pick<ComputerRecordsShape, 'permissions'>;
    };
