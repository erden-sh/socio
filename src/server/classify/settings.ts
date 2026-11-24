import { z } from 'zod';

import {
    CLASSIFY_PER_DAY,
    CLASSIFY_PROVIDERS,
    CLASSIFY_THRESHOLD,
    CLASSIFY_USES,
    INTENT_HINT_CHARS,
    INTENT_LABEL_COUNT,
    INTENT_LABELS,
    INTENT_VALUE,
    type ClassifyOption,
    type ClassifySettings,
    type ClassifyUse,
    type ClassifyUseSettings,
    type SavedUseSettings,
} from '@socio/shared/classify';
import type { Settings } from '@socio/shared/types';

/**
 * The seam's settings (CB-198): per use, an admin's choice from
 * Operations → Settings (`settings.classify`) over the server's, which
 * come from the environment. Every use is off unless turned on. The
 * workspace's model gets a strict threshold: a label is applied only when
 * it is 90% sure, and only after it was right 90% of the times it was
 * that sure on the golden set.
 */
export const DEFAULT_USE_SETTINGS: ClassifyUseSettings = {
    enabled: false,
    provider: 'workspace',
    threshold: 0.9,
    perDay: 200,
};

/**
 * Each use's own defaults over those. Themes' answers are free text, so
 * "right" is looser (a topic in common and the same outcome hint) and
 * its threshold starts lower; a session has many more of them than
 * there are failures, so its cap starts higher.
 */
const USE_DEFAULTS: Record<ClassifyUse, Partial<ClassifyUseSettings>> = {
    failures: {},
    intent: { threshold: 0.8, perDay: 300 },
    themes: { threshold: 0.7, perDay: 300 },
    // Learning's triage and checks (CB-200): the strict defaults.
    learning: {},
};

/**
 * Per use, `CLASSIFY_<USE>` (true or false), `CLASSIFY_<USE>_DAILY` and
 * `CLASSIFY_<USE>_THRESHOLD`: `CLASSIFY_FAILURES*` (CB-198),
 * `CLASSIFY_INTENT*` and `CLASSIFY_THEMES*` (CB-199), `CLASSIFY_LEARNING*`
 * (CB-200).
 */
export function classifySettingsFromEnv(env: Record<string, string | undefined>): ClassifySettings {
    const out: ClassifySettings = {};
    for (const use of CLASSIFY_USES) {
        const name = `CLASSIFY_${use.toUpperCase()}`;
        const found: Partial<ClassifyUseSettings> = {};
        const raw = env[name]?.trim().toLowerCase();
        if (raw) {
            if (raw !== 'true' && raw !== 'false') {
                throw new Error(`${name} must be true or false.`);
            }
            found.enabled = raw === 'true';
        }
        const daily = env[`${name}_DAILY`]?.trim();
        if (daily) {
            const value = Number(daily);
            if (!validPerDay(value)) {
                throw new Error(
                    `${name}_DAILY must be a whole number from ${CLASSIFY_PER_DAY.min} to ${CLASSIFY_PER_DAY.max}.`,
                );
            }
            found.perDay = value;
        }
        const threshold = env[`${name}_THRESHOLD`]?.trim();
        if (threshold) {
            const value = Number(threshold);
            if (!validThreshold(value)) {
                throw new Error(
                    `${name}_THRESHOLD must be a number from ${CLASSIFY_THRESHOLD.min} to ${CLASSIFY_THRESHOLD.max}.`,
                );
            }
            found.threshold = value;
        }
        if (Object.keys(found).length) {
            out[use] = found;
        }
    }
    return out;
}

const validPerDay = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLASSIFY_PER_DAY.min &&
    value <= CLASSIFY_PER_DAY.max;
const validThreshold = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= CLASSIFY_THRESHOLD.min &&
    value <= CLASSIFY_THRESHOLD.max;

/** The server's settings for a use: the defaults under the environment's. */
export function serverUseSettings(use: ClassifyUse, env: ClassifySettings = {}): ClassifyUseSettings {
    const { enabled, provider, threshold, perDay } = {
        ...DEFAULT_USE_SETTINGS,
        ...USE_DEFAULTS[use],
        ...env[use],
    };
    return { enabled, provider, threshold, perDay };
}

/** An intent list as saved: valid, distinct values; else none. */
function validLabels(value: unknown): ClassifyOption[] | undefined {
    const parsed = labelsInput.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** Intent's labels in force: an admin's list, else `INTENT_LABELS`. */
export function intentLabels(settings: Pick<Settings, 'classify'>): ClassifyOption[] {
    return validLabels(settings.classify?.intent?.labels) ?? INTENT_LABELS.map((label) => ({ ...label }));
}

/** A use's settings in force: what an admin saved over the server's. */
export function useSettings(
    settings: Pick<Settings, 'classify'>,
    use: ClassifyUse,
    env: ClassifySettings = {},
): ClassifyUseSettings {
    const server = serverUseSettings(use, env);
    const saved = settings.classify?.[use] ?? {};
    return {
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : server.enabled,
        provider: (CLASSIFY_PROVIDERS as readonly string[]).includes(saved.provider ?? '')
            ? saved.provider!
            : server.provider,
        threshold: validThreshold(saved.threshold) ? saved.threshold : server.threshold,
        perDay: validPerDay(saved.perDay) ? saved.perDay : server.perDay,
    };
}

/** Intent's list as an admin sends it: 2 to 16 distinct short values with hints. */
export const labelsInput = z
    .array(
        z
            .object({
                value: z.string().regex(INTENT_VALUE),
                hint: z.string().trim().min(1).max(INTENT_HINT_CHARS),
            })
            .strict(),
    )
    .min(INTENT_LABEL_COUNT.min)
    .max(INTENT_LABEL_COUNT.max)
    .refine((labels) => new Set(labels.map((label) => label.value)).size === labels.length, 'Each value once.');

/** An admin's change: a value sets it, null goes back to the server's. */
export const useSettingsInput = z
    .object({
        enabled: z.boolean().nullable().optional(),
        provider: z.enum(CLASSIFY_PROVIDERS).nullable().optional(),
        threshold: z.number().min(CLASSIFY_THRESHOLD.min).max(CLASSIFY_THRESHOLD.max).nullable().optional(),
        perDay: z.number().int().min(CLASSIFY_PER_DAY.min).max(CLASSIFY_PER_DAY.max).nullable().optional(),
        /** Intent's list only; null goes back to `INTENT_LABELS`. */
        labels: labelsInput.nullable().optional(),
    })
    .strict();

/** The saved settings after a change. */
export function savedClassifySettings(
    saved: ClassifySettings | undefined,
    use: ClassifyUse,
    change: z.infer<typeof useSettingsInput>,
): ClassifySettings {
    const next: SavedUseSettings = { ...saved?.[use] };
    for (const key of ['enabled', 'provider', 'threshold', 'perDay', 'labels'] as const) {
        const value = change[key];
        if (value === null) {
            delete next[key];
        } else if (value !== undefined) {
            (next as Record<string, unknown>)[key] = value;
        }
    }
    const out: ClassifySettings = { ...saved };
    if (Object.keys(next).length) {
        out[use] = next;
    } else {
        delete out[use];
    }
    return out;
}
