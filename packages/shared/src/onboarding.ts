import { z } from 'zod';

/** Stable guide identities; versions change when a guide needs a fresh offer. */
export const GUIDE_IDS = [
    'getting-started',
    'goals-schedules',
    'improvements',
    'administration',
    'operations',
] as const;
export type GuideId = (typeof GUIDE_IDS)[number];
export const GUIDE_VERSION = 1;
export const guideProgressSchema = z
    .object({
        version: z.number().int().min(1).max(10_000),
        status: z.enum(['in_progress', 'dismissed', 'completed']),
        stepId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    })
    .strict();
export type GuideProgress = z.infer<typeof guideProgressSchema>;
export type OnboardingPreferences = Partial<Record<GuideId, GuideProgress>>;
export const onboardingPreferencesSchema = z.partialRecord(z.enum(GUIDE_IDS), guideProgressSchema);

/** A PATCH updates individual guides without discarding another tab's guides. */
export function mergeOnboarding(
    current: OnboardingPreferences | undefined,
    patch: OnboardingPreferences,
): OnboardingPreferences {
    return { ...current, ...patch };
}
