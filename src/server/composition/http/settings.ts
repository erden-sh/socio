/** Workspace settings at the HTTP edge: an admin's changes, and what follows them. */
import { Context } from 'effect';
import type { Hono } from 'hono';
import { z } from 'zod';

import { appLogRetention } from '@socio/foundation/apps/log-retention';
import { contextSettings } from '@socio/foundation/context/settings';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import { roomsSettings } from '@socio/foundation/rooms/settings';
import { transcriptionProvider } from '@socio/foundation/voice/transcription-provider';
import { APP_LOG_ATTEMPTS_RANGE, APP_LOG_DAYS_RANGE } from '@socio/shared/apps/app-log-retention';
import { NOTES_SELECTIONS, SUMMARY_MODELS } from '@socio/shared/context-settings';
import { appPolicyChangeSchema } from '@socio/shared/device-sign-in';
import { LIMIT_KEYS, validLimit } from '@socio/shared/limits';
import { isAdmin } from '@socio/shared/roles';
import { THEME_IDS } from '@socio/shared/settings/appearance';
import { brandingSchema } from '@socio/shared/settings/branding';
import { savedLimits } from '@socio/shared/settings/limits';
import { SPACE_CREATORS } from '@socio/shared/spaces/create-permission';
import type { Settings } from '@socio/shared/types';
import { DICTATION_ALLOWED } from '@socio/shared/voice/dictation';
import { TRANSCRIPTION_KEY_SETTING } from '@socio/shared/voice/settings-keys';
import {
    TRANSCRIBE_KEY_MAX,
    TRANSCRIBE_KEY_PATTERN,
    TRANSCRIBE_MODEL_MAX,
    TRANSCRIBE_MODEL_PATTERN,
    TRANSCRIBE_URL_MAX,
    TRANSCRIPTION_STREAMING,
    keySafeUrl,
    normalizeTranscribeUrl,
} from '@socio/shared/voice/transcription';
import { SPEECH_VOICE_MAX, SPEECH_VOICE_PATTERN, VOICE_BACKENDS } from '@socio/shared/voice/voice-call';

import { validDrillInterval, validLtxInterval, validPurgeBackupDays } from '../../backup/backup-service.js';
import { BACKUP_INTERVAL_MAX_HOURS } from '../../backup/contract.js';
import type { AppEdge } from '../../main.js';
import type { SecretSettingChanges, WorkspaceSettingsShape } from '../../settings/contract.js';
import { limitDefaults } from '../../settings/limits.js';
import type { Runner } from '../../turns/runner.js';
import { Dictation } from '../../voice/contract.js';
import type { VoiceService } from '../../voice/voice.js';
import { RoomWork } from '../app/room-work.js';
import { LegacyConfig } from '../base.js';
import { LegacySteering } from '../context.js';
import { LegacyData } from '../dataspace.js';
import { LegacyJobs } from '../schedules.js';
import { LegacyTranscriptionKeys } from '../voice.js';

/**
 * A key's URL is not the one in force (CB-204), or none usable is (`inForce`
 * undefined): nothing is saved.
 */
class KeyUrlMismatch extends Error {
    constructor(readonly inForce: string | undefined) {
        super('The key is for another transcription URL.');
    }
}

export function mountSettingsRoutes(
    app: Hono<AppEnv>,
    {
        store,
        runner,
        edge,
        voice,
    }: {
        store: Pick<WorkspaceSettingsShape, 'settings' | 'updateSettings'>;
        runner: Runner;
        edge: AppEdge | undefined;
        voice: VoiceService | undefined;
    },
) {
    // What a change sets off beside the store, none without the app's services.
    const sources = edge && {
        config: Context.get(edge.services, LegacyConfig),
        transcriptionKeys: Context.get(edge.services, LegacyTranscriptionKeys),
        jobs: Context.get(edge.services, LegacyJobs),
        dictation: Context.get(edge.services, Dictation),
        steering: Context.get(edge.services, LegacySteering),
        roomWork: Context.get(edge.services, RoomWork),
        data: Context.get(edge.services, LegacyData),
    };
    // Pause and global permissions affect everyone: admins only.
    app.patch('/api/settings', requireAdmin, async (c) => {
        const parsed = z
            .object({
                branding: brandingSchema.nullable().optional(),
                defaultThemeId: z.enum(THEME_IDS).nullable().optional(),
                name: z.string().trim().min(1).max(40).optional(),
                paused: z.boolean().optional(),
                researchAllowed: z.boolean().optional(),
                memoryAllowed: z.boolean().optional(),
                // 0 turns that kind of filing off.
                dotDailyLimits: z
                    .object({
                        perDot: z.number().int().min(0).max(10_000),
                        perUser: z.number().int().min(0).max(10_000),
                    })
                    .strict()
                    .optional(),
                // Automatic triage of new issues (CB-30): the switch, and the most
                // proposals a day (0 asks the model about none).
                autoTriage: z
                    .object({
                        enabled: z.boolean(),
                        perDay: z.number().int().min(0).max(10_000),
                    })
                    .strict()
                    .optional(),
                // CB-292: content-based name suggestions for rooms and chats.
                chatNameSuggestions: z.boolean().optional(),
                // Who may create Spaces besides admins: everyone, or admins only.
                spaceCreators: z.enum(SPACE_CREATORS).optional(),
                // `notify_user` per day (CB-114); 0 turns Dots' notifications off.
                notificationDailyLimits: z
                    .object({
                        perDot: z.number().int().min(0).max(10_000),
                        perUser: z.number().int().min(0).max(10_000),
                    })
                    .strict()
                    .optional(),
                dictationMethods: z.enum(DICTATION_ALLOWED).optional(),
                // Live text while dictating (CB-222); null: the environment's.
                transcriptionStreaming: z.enum(TRANSCRIPTION_STREAMING).nullable().optional(),
                // Calls' backend (CB-265); null: VOICE_BACKEND.
                voiceBackend: z.enum(VOICE_BACKENDS).nullable().optional(),
                // Self-hosted calls' speech server (CB-265); null: VOICE_SPEECH_*.
                // An empty URL: the device speaks. The key stays in the environment.
                voiceSpeech: z
                    .object({
                        url: z
                            .string()
                            .max(TRANSCRIBE_URL_MAX)
                            .transform((url, ctx) => {
                                if (!url.trim()) {
                                    return '';
                                }
                                const normalized = normalizeTranscribeUrl(url);
                                if (!normalized) {
                                    ctx.addIssue({ code: 'custom' });
                                }
                                return normalized ?? '';
                            }),
                        model: z.string().trim().min(1).max(TRANSCRIBE_MODEL_MAX).regex(TRANSCRIBE_MODEL_PATTERN),
                        voice: z.string().trim().min(1).max(SPEECH_VOICE_MAX).regex(SPEECH_VOICE_PATTERN),
                    })
                    .strict()
                    .nullable()
                    .optional(),
                // Tunable limits (CB-108): a number sets that one, null goes back
                // to the server's; the ones left out stay as they are.
                limits: z
                    .object(
                        Object.fromEntries(
                            LIMIT_KEYS.map((key) => [
                                key,
                                z
                                    .number()
                                    .refine((value) => validLimit(key, value))
                                    .nullable()
                                    .optional(),
                            ]),
                        ),
                    )
                    .strict()
                    .optional(),
                // Server dictation's transcription server (CB-101); null: the
                // environment's. The key stays in the environment.
                transcription: z
                    .object({
                        url: z
                            .string()
                            .max(TRANSCRIBE_URL_MAX)
                            .transform((url, ctx) => {
                                const normalized = normalizeTranscribeUrl(url);
                                if (!normalized) {
                                    ctx.addIssue({ code: 'custom' });
                                }
                                return normalized ?? '';
                            }),
                        model: z.string().trim().min(1).max(TRANSCRIBE_MODEL_MAX).regex(TRANSCRIBE_MODEL_PATTERN),
                    })
                    .strict()
                    .nullable()
                    .optional(),
                // Its key (CB-204), and the URL it is for, which must be the one
                // in force after this change (409 if not); null clears it. Sealed,
                // never in settings, never sent back.
                transcriptionKey: z
                    .object({
                        key: z.string().trim().min(1).max(TRANSCRIBE_KEY_MAX).regex(TRANSCRIBE_KEY_PATTERN),
                        url: z.string().max(TRANSCRIBE_URL_MAX),
                    })
                    .strict()
                    .nullable()
                    .optional(),
                // Over OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT (CB-128).
                tracing: z.object({ includeContent: z.boolean() }).strict().optional(),
                // A busy own model hands over to the shared one (CB-140); on unless off.
                modelFallback: z.boolean().optional(),
                // Invites open the Socio app (CB-352), over AUTH_APP_INVITE_LINKS.
                appInviteLinks: z.boolean().optional(),
                // The Socio app's lease and notification policy (CB-379), each
                // over its AUTH_APP_* variable; the ones left out stay as they are.
                appPolicy: appPolicyChangeSchema.optional(),
                // Rooms (CB-207), over ROOMS_ENABLED; off unless turned on. And
                // whether members see their room's use and limits (CB-218), over
                // ROOMS_BUDGET_VISIBLE. The one left out stays as it is.
                rooms: z
                    .object({
                        enabled: z.boolean().optional(),
                        budgetVisible: z.boolean().optional(),
                    })
                    .strict()
                    .optional(),
                // Long chats' notes (CB-137, CB-134), over CONTEXT_SUMMARY_MODEL and
                // CONTEXT_SELECTION; the one left out stays as it is.
                context: z
                    .object({
                        summaryModel: z.enum(SUMMARY_MODELS).optional(),
                        selection: z.enum(NOTES_SELECTIONS).optional(),
                    })
                    .strict()
                    .optional(),
                // Mini app logs kept (CB-175), over APPS_LOG_DAYS and
                // APPS_LOG_ATTEMPTS; the one left out stays as it is.
                appLogs: z
                    .object({
                        days: z.number().int().min(APP_LOG_DAYS_RANGE.min).max(APP_LOG_DAYS_RANGE.max).optional(),
                        attempts: z
                            .number()
                            .int()
                            .min(APP_LOG_ATTEMPTS_RANGE.min)
                            .max(APP_LOG_ATTEMPTS_RANGE.max)
                            .optional(),
                    })
                    .strict()
                    .optional(),
                // Over BACKUP_INTERVAL_HOURS and BACKUP_LTX_INTERVAL_SECONDS (CB-112),
                // RESTORE_DRILL_INTERVAL_DAYS (CB-111) and PURGE_BACKUP_DAYS (CB-391).
                backupSchedule: z
                    .object({
                        intervalHours: z.number().min(0).max(BACKUP_INTERVAL_MAX_HOURS),
                        ltxIntervalSeconds: z.number().refine(validLtxInterval),
                        drillIntervalDays: z.number().refine(validDrillInterval),
                        purgeBackupDays: z.number().refine(validPurgeBackupDays),
                    })
                    .strict()
                    .optional(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Invalid settings.' }, 400);
        }
        if ('branding' in parsed.data && !isAdmin(c.get('user'))) {
            return c.json({ error: 'Only an admin can change branding.' }, 403);
        }
        const previous = store.settings();
        const { limits, context, appLogs, transcriptionKey, rooms, appPolicy, ...rest } = parsed.data;
        let secrets: SecretSettingChanges | undefined;
        if (transcriptionKey === null) {
            secrets = () => ({ [TRANSCRIPTION_KEY_SETTING]: null });
        } else if (transcriptionKey) {
            if (!sources) {
                return c.json({ error: 'Keys can’t be saved on this server.' }, 400);
            }
            const url = normalizeTranscribeUrl(transcriptionKey.url);
            if (!url) {
                return c.json({ error: 'Invalid settings.' }, 400);
            }
            if (!keySafeUrl(url)) {
                return c.json(
                    {
                        error: 'A key is sent only over https (or to this machine): change the URL to https first.',
                    },
                    400,
                );
            }
            const { config, transcriptionKeys: keys } = sources;
            // Checked in the unit of work, against the settings as saved: the
            // key is for the URL in force once this change is saved, and only
            // when that is the one the admin saw.
            secrets = (next) => {
                const inForce = transcriptionProvider(config, next).url;
                if (inForce !== url) {
                    throw new KeyUrlMismatch(inForce);
                }
                return {
                    [TRANSCRIPTION_KEY_SETTING]: keys.seal(transcriptionKey.key, url),
                };
            };
        }
        // Analytical tables' default retention drops data: audited (CB-387),
        // before and after as this change's unit of work saw them, so
        // concurrent saves each record their own step.
        const retainDefault = sources && limitDefaults(sources.config).dataAnalyticsRetainDays;
        let retained: { before: number; after: number } | undefined;
        let settings: Settings;
        try {
            // Worked out from the settings as saved, in the unit of work, so
            // concurrent partial changes to one card keep each other (CB-379).
            settings = await store.updateSettings(
                (current) => ({
                    ...rest,
                    ...(limits && {
                        limits: (() => {
                            const next = savedLimits(current.limits, limits);
                            if (retainDefault !== undefined) {
                                retained = {
                                    before: current.limits?.dataAnalyticsRetainDays ?? retainDefault,
                                    after: next.dataAnalyticsRetainDays ?? retainDefault,
                                };
                            }
                            return next;
                        })(),
                    }),
                    // Only what an admin chose is saved, each over its env default.
                    ...(rooms && { rooms: { ...current.rooms, ...rooms } }),
                    ...(appPolicy && { appPolicy: { ...current.appPolicy, ...appPolicy } }),
                    ...(context && {
                        context: {
                            ...contextSettings(current, sources?.config.context),
                            ...context,
                        },
                    }),
                    ...(appLogs && {
                        appLogs: {
                            ...appLogRetention(current, sources?.config.appLogs),
                            ...appLogs,
                        },
                    }),
                }),
                secrets,
            );
        } catch (error) {
            if (!(error instanceof KeyUrlMismatch)) {
                throw error;
            }
            return c.json(
                {
                    error: error.inForce
                        ? 'The transcription URL has changed since this page loaded: check it, then set the key again.'
                        : 'No usable transcription URL is in force: save one first, then set the key.',
                },
                409,
            );
        }
        // Jobs waiting for a slot start when the limit allows more.
        if (limits) {
            sources?.jobs.pump();
            if (sources && retained) {
                sources.data.auditRetentionDefault(c.get('user').id, retained.before, retained.after);
            }
        }
        // A new URL, key or choice gets live text tried again (CB-222).
        if (
            'transcription' in parsed.data ||
            'transcriptionKey' in parsed.data ||
            'transcriptionStreaming' in parsed.data
        ) {
            sources?.dictation.forget();
        }
        if (settings.paused || !settings.researchAllowed || previous.memoryAllowed !== settings.memoryAllowed) {
            runner.abortAll();
        }
        if (settings.paused) {
            voice?.abortAll();
        } else {
            void voice?.resumePending();
        }
        // Messages queued while paused go now (CB-170).
        if (previous.paused && !settings.paused) {
            void sources?.steering.resume();
        }
        // Rooms turned off are read-only at once; turned on, they go on (CB-212).
        if (sources) {
            await sources.roomWork.switched(
                roomsSettings(previous, sources.config.rooms).enabled,
                roomsSettings(settings, sources.config.rooms).enabled,
            );
        }
        return c.json(settings);
    });
}

/** Settings' step, as index.ts mounts it: their routes. */
export const settingsRoutes = { routes: mountSettingsRoutes };
