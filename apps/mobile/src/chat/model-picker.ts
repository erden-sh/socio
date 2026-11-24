import { type ModelChoice, modelChoiceKey, type ModelOption, type ModelOptions } from '@socio/shared/inference';

// A chat's model picker (the web's ModelPicker in modules/chat/ModelSelect.tsx;
// ChatGPT's model picker at the top of a chat): what the chat runs on, and
// the choices. The choices are the person's
// (`GET /api/me/inference/options`), read online and kept in the scope's view
// state so the picker reads offline too; a pick is the chat's `inference`
// through chat-manage.ts's `setChatModel` (`PATCH /api/conversations/:id`,
// the web's write). No React Native: tests/chat runs it under Node.

/** Where the person's model choices come from. */
export const MODEL_OPTIONS_PATH = '/api/me/inference/options';
/** The view-state key the last choices are kept under. */
export const MODEL_OPTIONS_KEY = 'chat.model-options';
/** The value of the inherited choice (the web's INHERIT_MODEL): a model key always holds a colon. */
export const INHERIT_MODEL = 'inherit';
export const MODEL_PICKER_LABEL = 'Model for this chat';
export const MODEL_SHEET_TITLE = 'Model';
export const NO_LONGER_AVAILABLE = 'No longer available';
export const MODELS_OFFLINE = 'Connect to see every model you can choose.';

/** What a chat with no model of its own runs on (the web's inheritedModelLabel). */
export function inheritedModelLabel(dotDefault: ModelChoice | null | undefined, models: ModelOptions | null): string {
    const automatic = models?.automatic ?? 'no model available';
    if (!dotDefault) {
        return models === null ? 'Automatic' : `Automatic: ${automatic}`;
    }
    const key = modelChoiceKey(dotDefault);
    const option = models?.options.find((entry) => entry.key === key);
    if (!option) {
        return models === null ? 'Socio default' : `Socio default unavailable; automatic: ${automatic}`;
    }
    const label = `${option.group} · ${option.label}`;
    return option.available
        ? `Socio default: ${label}`
        : `Socio default ${label} needs a connection; automatic: ${automatic}`;
}

/** What the picker shows: the chosen model, else what it inherits (the web's modelChoiceLabel). */
export function modelChoiceLabel(value: ModelChoice | null | undefined, models: ModelOptions | null, inherit: string) {
    if (!value) {
        return inherit;
    }
    const key = modelChoiceKey(value);
    const option = models?.options.find((entry) => entry.key === key);
    if (option !== undefined) {
        return option.label;
    }
    // Choices not read yet (offline, first time): the model's own name when the choice says it.
    if (models === null) {
        return value.source === 'byo' ? (value.model ?? value.kind) : 'Chosen model';
    }
    return NO_LONGER_AVAILABLE;
}

export interface ModelRow {
    /** INHERIT_MODEL or the option's key. */
    readonly key: string;
    readonly label: string;
    /** The group it sits under ("ChatGPT", a backend's name); null for the inherited row. */
    readonly group: string | null;
    readonly checked: boolean;
    /** The person can't run on it now (the web's requireAvailable: "not connected"). */
    readonly disabled: boolean;
    readonly accessibilityLabel: string;
    /** What a pick sets: null for the inherited choice. */
    readonly choice: ModelChoice | null;
}

export interface ModelPickerView {
    /** The trigger's words. */
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly rows: readonly ModelRow[];
    /** Shown when the choices aren't known yet. */
    readonly note: string | null;
}

/** The picker over a chat's choice, its socio's default and the person's choices (null: not read yet). */
export function modelPickerView(input: {
    readonly value: ModelChoice | null | undefined;
    readonly dotDefault: ModelChoice | null | undefined;
    readonly models: ModelOptions | null;
}): ModelPickerView {
    const { value, models } = input;
    const inherit = inheritedModelLabel(input.dotDefault, models);
    const label = modelChoiceLabel(value, models, inherit);
    const current = value ? modelChoiceKey(value) : INHERIT_MODEL;
    const options: readonly ModelOption[] = models?.options ?? [];
    const rows: ModelRow[] = [
        {
            key: INHERIT_MODEL,
            label: inherit,
            group: null,
            checked: current === INHERIT_MODEL,
            disabled: false,
            accessibilityLabel: `${inherit}${current === INHERIT_MODEL ? ', chosen' : ''}`,
            choice: null,
        },
    ];
    if (value && !options.some((option) => option.key === current)) {
        rows.push({
            key: current,
            label: modelChoiceLabel(value, models, inherit),
            group: null,
            checked: true,
            disabled: true,
            accessibilityLabel: `${modelChoiceLabel(value, models, inherit)}, chosen`,
            choice: value,
        });
    }
    for (const option of options) {
        const off = !option.available;
        const words = `${option.label}${off ? ' (not connected)' : ''}`;
        rows.push({
            key: option.key,
            label: words,
            group: option.group,
            checked: option.key === current,
            disabled: off,
            accessibilityLabel: `${option.group}, ${words}${option.key === current ? ', chosen' : ''}`,
            choice: option.choice,
        });
    }
    return {
        label,
        accessibilityLabel: `${MODEL_PICKER_LABEL}: ${label}`,
        rows,
        note: models === null ? MODELS_OFFLINE : null,
    };
}

/** Reads kept or fetched choices, or null when they don't parse. */
export function parseModelOptions(value: unknown): ModelOptions | null {
    if (value === null || typeof value !== 'object') {
        return null;
    }
    const { options, automatic } = value as { options?: unknown; automatic?: unknown };
    if (!Array.isArray(options) || (automatic !== null && typeof automatic !== 'string')) {
        return null;
    }
    const valid = options.filter(
        (option): option is ModelOption =>
            option !== null &&
            typeof option === 'object' &&
            typeof (option as ModelOption).key === 'string' &&
            typeof (option as ModelOption).label === 'string' &&
            typeof (option as ModelOption).group === 'string' &&
            typeof (option as ModelOption).available === 'boolean' &&
            (option as ModelOption).choice !== null &&
            typeof (option as ModelOption).choice === 'object',
    );
    return { options: valid, automatic };
}

/** The choices kept in view state (`MODEL_OPTIONS_KEY`), or null when none are kept or they don't parse. */
export function keptModelOptions(text: string | null): ModelOptions | null {
    if (text === null) {
        return null;
    }
    try {
        return parseModelOptions(JSON.parse(text));
    } catch {
        return null;
    }
}

/** The trigger's hint while it can open the sheet. */
export const MODEL_PICKER_HINT = 'Chooses the model this chat runs on';
/** Its hint while a reply is still being written (the web disables the picker then). */
export const MODEL_PICKER_RUNNING_HINT = 'You can change the model once the reply is done';

export interface ModelTrigger {
    /** Can't open the sheet: a new chat not created yet, or a reply still being written. */
    readonly disabled: boolean;
    /** The chevron that says it opens: not on a new chat, which never can. */
    readonly chevron: boolean;
    readonly hint: string | undefined;
}

/**
 * The picker's trigger in the chat's header: a new chat not created yet has no
 * model of its own to set, so it only reads; while a reply runs it is disabled,
 * as the web's ModelPicker is (`disabled={!models || running}`).
 */
export function modelTrigger(input: { readonly local: boolean; readonly running: boolean }): ModelTrigger {
    if (input.local) {
        return { disabled: true, chevron: false, hint: undefined };
    }
    return input.running
        ? { disabled: true, chevron: true, hint: MODEL_PICKER_RUNNING_HINT }
        : { disabled: false, chevron: true, hint: MODEL_PICKER_HINT };
}
