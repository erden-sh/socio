import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';

import type { ModelChoice, ModelOption, ModelOptions } from '@socio/shared/inference';
import { modelChoiceKey } from '@socio/shared/inference';

import { api } from '../../lib/api';

import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** An explicit pick wins over automatic inference; undefined means still loading. */
export function modelAvailability(
    choice: ModelChoice | null | undefined,
    options: ModelOptions | undefined,
    automatic: boolean | undefined,
): boolean | undefined {
    if (!choice) {
        return automatic;
    }
    if (!options) {
        return undefined;
    }
    return options.options.find((option) => option.key === modelChoiceKey(choice))?.available ?? false;
}

/** The model picker's entries for the signed-in user; undefined while loading. */
export function useModelOptions() {
    const [options, setOptions] = useState<ModelOptions>();
    useEffect(() => {
        const controller = new AbortController();
        api<ModelOptions>('/me/inference/options', 'GET', undefined, controller.signal)
            .then(setOptions)
            .catch(() => {
                if (!controller.signal.aborted) {
                    setOptions({ options: [], automatic: null });
                }
            });
        return () => controller.abort();
    }, []);
    return options;
}

const groups = (options: ModelOption[]) => {
    const byGroup = new Map<string, ModelOption[]>();
    for (const option of options) {
        byGroup.set(option.group, [...(byGroup.get(option.group) ?? []), option]);
    }
    return [...byGroup];
};

/**
 * The value of the inherited choice: Radix Select reserves the empty string
 * (it clears the selection), and model keys always hold a colon
 * (`shared:…`, `byo:…`), so this one can't name a model.
 */
export const INHERIT_MODEL = 'inherit';

type ModelSelectProps = {
    id?: string;
    value: ModelChoice | null;
    onChange: (choice: ModelChoice | null) => void;
    options: ModelOption[];
    inheritLabel: string;
    requireAvailable?: boolean;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
};

/** The shared menu; the trigger's look and its text are the caller's. */
function ModelMenu({
    id,
    value,
    onChange,
    options,
    inheritLabel,
    requireAvailable = false,
    disabled,
    'aria-label': ariaLabel,
    trigger,
    triggerLabel,
    align,
}: Omit<ModelSelectProps, 'className'> & {
    trigger: ComponentProps<typeof SelectTrigger> & {
        'data-slot'?: string;
        'data-size'?: undefined;
    };
    triggerLabel?: ReactNode;
    align: 'start' | 'end';
}) {
    const current = value ? modelChoiceKey(value) : INHERIT_MODEL;
    const known = !value || options.some((option) => option.key === current);
    return (
        <Select
            value={current}
            disabled={disabled}
            onValueChange={(next) => {
                const option = options.find((entry) => entry.key === next);
                onChange(option ? option.choice : null);
            }}
        >
            <SelectTrigger {...trigger} id={id} aria-label={ariaLabel}>
                <SelectValue>{triggerLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" align={align} className="max-w-[calc(100vw-1rem)]">
                <SelectItem value={INHERIT_MODEL}>{inheritLabel}</SelectItem>
                {!known && (
                    <SelectItem value={current} disabled>
                        No longer available
                    </SelectItem>
                )}
                {groups(options).map(([group, entries]) => (
                    <SelectGroup key={group}>
                        <SelectLabel>{group}</SelectLabel>
                        {entries.map((option) => (
                            <SelectItem
                                key={option.key}
                                value={option.key}
                                title={option.detail ?? option.description}
                                disabled={requireAvailable && !option.available}
                            >
                                {option.label}
                                {!option.available && requireAvailable ? ' (not connected)' : ''}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                ))}
            </SelectContent>
        </Select>
    );
}

/**
 * A select of models, grouped by where they run (shadcn Select, CB-257).
 * The inherited choice is `null` (`inheritLabel`, e.g. the socio's
 * default). A saved choice that is gone shows as "No longer available".
 * `requireAvailable`: options this user can't run on now are disabled (a
 * chat's own model); a socio's default may name any, since each person's
 * own connection serves their chats.
 */
export function ModelSelect({ className, ...props }: ModelSelectProps) {
    return (
        <ModelMenu
            {...props}
            align="start"
            // No data-size: its height (h-9) is a data variant, which would
            // outrank the caller's own height (a dialog's h-10).
            trigger={{
                'data-size': undefined,
                className: cn('h-9 w-full min-w-0', className),
            }}
        />
    );
}

/** What a model picker shows: the chosen model, else what it inherits. */
export function modelChoiceLabel(value: ModelChoice | null, options: ModelOption[], inheritLabel: string) {
    if (!value) {
        return inheritLabel;
    }
    const key = modelChoiceKey(value);
    return options.find((option) => option.key === key)?.label ?? 'No longer available';
}

/**
 * A chat's model picker (CB-100): its model as quiet small text with a
 * chevron, as wide as the label up to the room it is given, then cut
 * short, with the full name on hover. It is the Select's own trigger
 * (CB-257), a button, so it keeps its accessible name and the keyboard
 * (Enter, Space or the arrows open it; type to jump; Escape closes), and
 * no 16 px rule is needed: iOS only zooms into text fields (CB-96).
 */
export function ModelPicker({ className, ...props }: ModelSelectProps) {
    const label = modelChoiceLabel(props.value, props.options, props.inheritLabel);
    return (
        <ModelMenu
            {...props}
            align="end"
            triggerLabel={
                <span data-slot="model-picker-label" className="truncate">
                    {label}
                </span>
            }
            trigger={{
                'data-slot': 'model-picker',
                title: label,
                className: cn(
                    'min-w-0 justify-start gap-0.5 rounded-[6px] border-0 bg-transparent px-1.5 py-1 text-[12px]/[normal] text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground data-[size=default]:h-auto dark:bg-transparent *:data-[slot=select-value]:min-w-0 dark:hover:bg-muted [&>svg]:size-3 [&>svg]:opacity-70',
                    className,
                ),
            }}
        />
    );
}

/** What a chat with no model of its own runs on: its Dot's default, else automatic. */
export function inheritedModelLabel(dotDefault: ModelChoice | null | undefined, models: ModelOptions | undefined) {
    const automatic = models?.automatic ?? 'no model available';
    if (!dotDefault) {
        return `Automatic: ${automatic}`;
    }
    const key = modelChoiceKey(dotDefault);
    const option = models?.options.find((entry) => entry.key === key);
    if (!option) {
        return `Socio default unavailable; automatic: ${automatic}`;
    }
    const label = `${option.group} · ${option.label}`;
    return option.available
        ? `Socio default: ${label}`
        : `Socio default ${label} needs a connection; automatic: ${automatic}`;
}
