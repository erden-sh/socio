import { useId, type ReactNode } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** A labeled form row: the label above its control. */
export function Field({
    label,
    children,
    className,
}: {
    label: string;
    children: (id: string) => ReactNode;
    className?: string;
}) {
    const id = useId();
    return (
        <div className={cn('grid gap-1.5', className)}>
            <span id={id} data-slot="field-label" className="text-xs font-medium text-muted-foreground">
                {label}
            </span>
            {children(id)}
        </div>
    );
}

/** `none` stands for null in Radix Select, which has no empty value. */
export const NONE = 'none';

/** One value out of a fixed list, as a labeled select. */
export function ChoiceField<T extends string>({
    label,
    value,
    options,
    labelOf,
    onChange,
    disabled,
    none,
    className,
}: {
    label: string;
    value: T | null;
    options: readonly T[];
    labelOf: (value: T) => string;
    onChange: (value: T | null) => void;
    disabled?: boolean;
    /** Offer "no value" with this text (area, assignee). */
    none?: string;
    className?: string;
}) {
    return (
        <Field label={label} className={className}>
            {(id) => (
                <Select
                    value={value ?? NONE}
                    disabled={disabled}
                    onValueChange={(next) => onChange(next === NONE ? null : (next as T))}
                >
                    <SelectTrigger aria-labelledby={id} size="sm" className="w-full min-w-0">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {none !== undefined && <SelectItem value={NONE}>{none}</SelectItem>}
                        {options.map((option) => (
                            <SelectItem key={option} value={option}>
                                {labelOf(option)}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
        </Field>
    );
}
