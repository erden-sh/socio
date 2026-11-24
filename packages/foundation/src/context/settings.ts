import {
    DEFAULT_CONTEXT_SETTINGS,
    NOTES_SELECTIONS,
    SUMMARY_MODELS,
    type ContextSettings,
} from '@socio/shared/context-settings';
import type { Settings } from '@socio/shared/types';

// Moved from `src/server/context/settings.ts`.

/**
 * Long chats' notes settings (CB-137, CB-134): the environment's starting
 * values under what an admin saved in Settings, read on every turn so a
 * change applies to the next one.
 */

/** `CONTEXT_SUMMARY_MODEL` and `CONTEXT_SELECTION`; only those set. */
export function contextSettingsFromEnv(env: Record<string, string | undefined>): Partial<ContextSettings> {
    const summaryModel = env.CONTEXT_SUMMARY_MODEL?.trim().toLowerCase();
    const selection = env.CONTEXT_SELECTION?.trim().toLowerCase();
    if (summaryModel && !(SUMMARY_MODELS as readonly string[]).includes(summaryModel)) {
        throw new Error(`CONTEXT_SUMMARY_MODEL must be one of: ${SUMMARY_MODELS.join(', ')}.`);
    }
    if (selection && !(NOTES_SELECTIONS as readonly string[]).includes(selection)) {
        throw new Error(`CONTEXT_SELECTION must be one of: ${NOTES_SELECTIONS.join(', ')}.`);
    }
    return {
        ...(summaryModel ? { summaryModel: summaryModel as ContextSettings['summaryModel'] } : {}),
        ...(selection ? { selection: selection as ContextSettings['selection'] } : {}),
    };
}

/** The settings in force: an admin's, over the environment's, over the built-in. */
export const contextSettings = (settings: Settings, env: Partial<ContextSettings> = {}): ContextSettings => ({
    ...DEFAULT_CONTEXT_SETTINGS,
    ...env,
    ...settings.context,
});
