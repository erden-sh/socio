import { appLogRetention } from '@socio/foundation/apps/log-retention';
import { contextSettings } from '@socio/foundation/context/settings';
import { autoTriageSettings, dotRequestLimits, type DotRequestLimits } from '@socio/foundation/issues/settings';
import { memoryOf } from '@socio/foundation/memory/memory-of';
import { traceSettings } from '@socio/foundation/observability/otel-export';
import { roomsSettings } from '@socio/foundation/rooms/settings';
import { brandingInForce } from '@socio/foundation/settings/branding';
import { voiceCallsView, type VoiceCallsEnv } from '@socio/foundation/voice/speech-provider';
import {
    transcriptionProvider,
    transcriptionView,
    type TranscriptionSources,
} from '@socio/foundation/voice/transcription-provider';
import { configured, type ResearchConfig } from '@socio/foundation/web/research-config';
import type { AppLogRetention } from '@socio/shared/apps/app-log-retention';
import type { ContextSettings } from '@socio/shared/context-settings';
import { appPolicyInForce, type AppPolicy } from '@socio/shared/device-sign-in';
import type { LimitValues } from '@socio/shared/limits';
import type { NotificationDailyLimits } from '@socio/shared/notifications';
import { notificationLimits } from '@socio/shared/notifications/limits';
import type { RoomsSettings } from '@socio/shared/rooms/rooms';
import { limitsInForce } from '@socio/shared/settings/limits';
import type { AutoTriageSettings, BackupSchedule, State } from '@socio/shared/types';
import type { DictationAllowed } from '@socio/shared/voice/dictation';

import type { InAppNoticesShape } from '../../notifications/contract.js';
import type { StateReleases, StateStore } from '../contract.js';

/**
 * The shell's state view (split out of live/views.ts). It is live's
 * own: app.ts serves it (`GET /api/state`) and the web page loaders read it
 * (`StateViewShape`, which the composition hands them). The build's version
 * comes from updates' `Releases`, the research config's
 * `configured` from `@socio/foundation/web/research-config`.
 */

/**
 * `GET /api/state`: settings, and this user's tasks and memories in use
 * (the ones they added or approved, newest first, CB-106).
 */
export async function stateView(
    store: StateStore,
    config: ResearchConfig,
    /** The running build's releases (updates' `Releases`): the version the shell shows. */
    releases: StateReleases,
    userId: string,
    /** The server's Dot filing limits, under an admin's (Settings → General). */
    limits?: DotRequestLimits,
    /** The server's ways to dictate (`DICTATION_METHODS`), under an admin's. */
    dictation: DictationAllowed = 'both',
    /** The server's transcription defaults and keys (VOICE_*), under an admin's. */
    voice?: TranscriptionSources,
    /** Notifications (CB-114): its limits, and the toasts waiting for this user. */
    notifications?: {
        service: InAppNoticesShape;
        limits?: NotificationDailyLimits;
    },
    /** The server's tunable limits (CB-108), under an admin's (Settings → General). */
    limitDefaults?: LimitValues,
    /** The backups' schedule in force (CB-112), when the server runs them. */
    backupSchedule?: BackupSchedule,
    /** The server's automatic triage switch and cap (AUTO_TRIAGE*), under an admin's. */
    triage?: AutoTriageSettings,
    /** Turn traces (CB-128): the content default, under an admin's, and whether export is on. */
    tracing?: { includeContent?: boolean; exporting: boolean },
    /** Long chats' notes (CB-137, CB-134): the environment's, under an admin's. */
    context?: Partial<ContextSettings>,
    /** Mini app log retention (CB-175): the environment's, under an admin's. */
    appLogs?: Partial<AppLogRetention>,
    /** Rooms (CB-207): the environment's switch, under an admin's. */
    rooms?: Partial<RoomsSettings>,
    /** Calls' backend and speech server (CB-265): the environment's, under an admin's. */
    voiceCalls?: VoiceCallsEnv,
    /** Invites open the Socio app (CB-352): the environment's, under an admin's. */
    appInviteLinks = false,
    /** The Socio app's policy (CB-379): the environment's, under an admin's. */
    appPolicy?: AppPolicy,
): Promise<State> {
    // Updates (CB-259) are operators' only: `/api/updates`, never here.
    const settings = store.settings();
    delete settings.updates;
    const { perDot, perUser } = dotRequestLimits(settings, limits);
    return {
        settings: {
            ...settings,
            branding: brandingInForce(settings.branding),
            dotDailyLimits: { perDot, perUser },
            autoTriage: autoTriageSettings(settings, triage),
            notificationDailyLimits: notificationLimits(settings, notifications?.limits),
            dictationMethods: settings.dictationMethods ?? dictation,
            transcription: voice
                ? transcriptionView(transcriptionProvider(voice, settings))
                : (settings.transcription ?? null),
            voiceCalls: voiceCallsView(
                voiceCalls,
                settings,
                voice ? transcriptionProvider(voice, settings) : undefined,
            ),
            ...(limitDefaults && {
                limits: limitsInForce(settings, limitDefaults),
                limitDefaults,
            }),
            ...(backupSchedule ? { backupSchedule } : {}),
            tracing: {
                ...traceSettings(settings, tracing?.includeContent),
                exporting: tracing?.exporting ?? false,
            },
            context: contextSettings(settings, context),
            appLogs: appLogRetention(settings, appLogs),
            modelFallback: settings.modelFallback ?? true,
            appInviteLinks: settings.appInviteLinks ?? appInviteLinks,
            appPolicy: appPolicyInForce(settings.appPolicy, appPolicy),
            rooms: roomsSettings(settings, rooms),
        },
        version: releases.data().version,
        tasks: await store.tasks(userId),
        memories: (await store.memoryItems.active(userId)).map(memoryOf),
        mode: config.mode,
        configured: configured(config),
        notices: (await notifications?.service.inApp(userId)) ?? [],
    };
}
