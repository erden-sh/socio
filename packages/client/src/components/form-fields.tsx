import type { ReactNode } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

// Fields shared by the dialogs (a Dot's settings) and the settings pages.

/**
 * A permission: a checkbox, its name and a line on what it does; the whole
 * row is its label. `compact` is the dialogs' smaller type (a Dot's
 * settings); settings pages use the cards' size.
 */
export function PermissionRow({
    title,
    children,
    checked,
    disabled,
    onCheckedChange,
    compact,
}: {
    title: ReactNode;
    children: ReactNode;
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (checked: boolean) => void;
    compact?: boolean;
}) {
    return (
        <label
            data-slot="permission-row"
            className={cn('flex items-start gap-3', compact ? 'my-5.5' : 'text-sm', !disabled && 'cursor-pointer')}
        >
            <Checkbox
                className={compact ? 'mt-px' : 'mt-0.5'}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(value) => onCheckedChange(value === true)}
            />
            <span className="grid gap-1">
                <strong className={compact ? 'text-[11px] font-[550]' : 'font-medium'}>{title}</strong>
                <small className={cn('text-muted-foreground', compact ? 'text-[10px] leading-[1.7]' : 'text-sm')}>
                    {children}
                </small>
            </span>
        </label>
    );
}

/**
 * Native selects (CB-258): one look for every plain `<select>`. Put
 * `data-slot="native-select"` on the element as well, so the legacy element
 * styles (style.css) stop at it. The explicit `py-0` and `leading-normal`
 * keep the chosen value inside the fixed height on every platform; a
 * select with block padding of its own clipped its text. 16 px below md,
 * so iOS doesn't zoom in on focus (CB-96).
 */
const selectBase =
    'min-w-0 max-w-full rounded-md border border-input bg-transparent py-0 text-base leading-normal shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30';

/** A settings page's select (Settings cards). */
export const nativeSelect = cn(selectBase, 'h-9 px-2');

/** A dialog's select (a socio's settings), full width in the smaller type. */
export const dialogSelect = cn(selectBase, 'h-10 w-full rounded-[9px] px-3 md:text-xs');

/** A group of fields in a Dot's settings, with its legend. */
export function DialogFieldset({ legend, children }: { legend: string; children: ReactNode }) {
    return (
        <fieldset className="my-4.5 rounded-[10px] border p-3">
            <legend className="px-1 text-sm font-semibold">{legend}</legend>
            {children}
        </fieldset>
    );
}
