/**
 * What other features may know of live updates: the slice of the change
 * counters they call, as a tag, and the state view's shape. It imports
 * only `effect`, `@socio/*` and other contracts, and holds no logic.
 *
 * The rest of `live/` is functions, so it has no tag:
 *
 * - Conditional polls (`conditionalJson`, `conditionalJsonAsync`,
 *   `parseIfNoneMatch`, `VersionAuditError`) live in
 *   `@socio/foundation/http/conditional`.
 * - Each feature's views live in its own folder behind its `<X>Views` tag,
 *   and the pages read them there. `live/views/state.ts` (`GET /api/state`)
 *   stays live's own; the pages get it from the composition as a
 *   `StateViewShape` (below). The issue routes read the run views through
 *   `RunsViews`.
 * - The state's version (`live/view-versions.ts`) and the counters' schema
 *   and triggers (`live/change-counters.ts`) stay here; `live/layer.ts`
 *   implements `Counters`.
 *
 * Live reads no `PlatformConfig` field, so it has no config tag.
 */
import { Context } from 'effect';

import type { DotRequestLimits } from '@socio/foundation/issues/settings';
import type { VoiceCallsEnv } from '@socio/foundation/voice/speech-provider';
import type { TranscriptionSources } from '@socio/foundation/voice/transcription-provider';
import type { ResearchConfig } from '@socio/foundation/web/research-config';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { ContextSettings } from '@socio/shared/context-settings';
import type { AppPolicy } from '@socio/shared/device-sign-in';
import type { LimitValues } from '@socio/shared/limits';
import type { NotificationDailyLimits } from '@socio/shared/notifications';
import type { RoomsSettings } from '@socio/shared/rooms/rooms';
import type { AutoTriageSettings, BackupSchedule, State } from '@socio/shared/types';
import type { DictationAllowed } from '@socio/shared/voice/dictation';

import type { MemoryRepository } from '../memory/contract.js';
import type { InAppNoticesShape } from '../notifications/contract.js';
import type { TasksShape } from '../schedules/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';

/**
 * Change counters on one database connection (live/change-counters.ts). The
 * core store (`CoreStore`) and `WorkspaceStore` each hold one (`counters`);
 * live's last graph step syncs the workspace's after the modules' migrations,
 * and the polled views' versions (live/view-versions.ts, the views tags) and
 * `memory/routes.ts` read them through `store.counters` or
 * `workspace.counters`. Both count the same table of the same database, so one
 * tag serves both; callers switch to it in their own PRs and stop reaching
 * through the core store and `WorkspaceStore`.
 */
export interface CountersShape {
    /** `key=n` for each key, in the order given; 0 for one never bumped. */
    read(keys: readonly string[]): string;
    /**
     * Installs the triggers for tables made since (a module's migrations ran
     * after the store opened) and repairs any a rebuilt table lost. Returns
     * how many triggers it wrote or dropped.
     */
    sync(): number;
}
export class Counters extends Context.Service<Counters, CountersShape>()('socio/live/Counters') {}

// ── The shell's state (`views/state.ts`) ─────────────────────────────────

/**
 * What the state view reads of the core store (`stateStoreOf` builds it):
 * the settings, the user's tasks, and their memories in use.
 */
export type StateStore = Pick<WorkspaceSettingsShape, 'settings'> & {
    tasks: TasksShape['list'];
    readonly memoryItems: Pick<MemoryRepository, 'active'>;
};

/** What the state view reads of the running build's releases (updates' `Releases`): its version. */
export interface StateReleases {
    data(): { readonly version: string };
}

/**
 * `GET /api/state` (`views/state.ts`'s `stateView`), as the web page
 * loaders call it: the composition hands it to them, so the first page
 * holds what the API returns.
 */
export interface StateViewShape {
    stateView(
        store: StateStore,
        config: ResearchConfig,
        releases: StateReleases,
        userId: string,
        limits?: DotRequestLimits,
        dictation?: DictationAllowed,
        voice?: TranscriptionSources,
        notifications?: { service: InAppNoticesShape; limits?: NotificationDailyLimits },
        limitDefaults?: LimitValues,
        backupSchedule?: BackupSchedule,
        triage?: AutoTriageSettings,
        tracing?: { includeContent?: boolean; exporting: boolean },
        context?: Partial<ContextSettings>,
        appLogs?: Partial<AppLogRetention>,
        rooms?: Partial<RoomsSettings>,
        voiceCalls?: VoiceCallsEnv,
        appInviteLinks?: boolean,
        appPolicy?: AppPolicy,
    ): Promise<State>;
}
