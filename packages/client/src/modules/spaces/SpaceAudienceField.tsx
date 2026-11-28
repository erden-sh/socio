import { useTranslation } from '@socio/i18n/react';

import { DialogFieldset } from '@/components/form-fields';
import { PrivateSpaceIcon } from '@/components/private-space';
import { cn } from '@/lib/utils';

// Its own module, apart from SpaceSettings: the socio and Space dialogs
// (WorkspaceDialog) show it, and importing the settings page would load the
// whole shell (Home) behind them, CopilotKit included (CB-472).

/**
 * Who sees a Space (CB-181), as two choices: the whole workspace, or only
 * its people. It covers everything in the Space, and says so. Opening a
 * Space to the whole workspace is a workspace admin's: anyone else sees
 * it as a choice they can't make.
 */
export function SpaceAudienceField({
    admin,
    value,
    onChange,
    disabled = false,
    legend,
}: {
    admin: boolean;
    /** Private: only its people. */
    value: boolean;
    onChange: (privateSpace: boolean) => void;
    disabled?: boolean;
    /** The fieldset's legend; "Who can see it" (`spaces.audience:legend`) by default. */
    legend?: string;
}) {
    const { t } = useTranslation(['spaces.audience']);
    const option = (checked: boolean) =>
        cn(
            'flex items-start gap-3 rounded-lg border p-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
            checked && 'border-primary/60 bg-accent/60',
            !disabled && 'cursor-pointer',
        );
    return (
        <DialogFieldset legend={legend ?? t('spaces.audience:legend')}>
            <div className="grid gap-2" data-slot="space-audience">
                <label className={cn(option(!value), !admin && 'opacity-60')}>
                    <input
                        type="radio"
                        name="space-audience"
                        className="mt-0.5 size-4 flex-none accent-primary"
                        checked={!value}
                        disabled={disabled || !admin}
                        onChange={() => onChange(false)}
                    />
                    <span className="grid gap-0.5">
                        <strong className="font-medium">{t('spaces.audience:whole.title')}</strong>
                        <small className="text-xs leading-[1.6] text-muted-foreground">
                            {t('spaces.audience:whole.detail', { context: admin ? undefined : 'member' })}
                        </small>
                    </span>
                </label>
                <label className={option(value)}>
                    <input
                        type="radio"
                        name="space-audience"
                        className="mt-0.5 size-4 flex-none accent-primary"
                        checked={value}
                        disabled={disabled}
                        onChange={() => onChange(true)}
                    />
                    <span className="grid gap-0.5">
                        <strong className="inline-flex items-center gap-1.5 font-medium">
                            {t('spaces.audience:private.title')} <PrivateSpaceIcon className="size-3.5" />
                        </strong>
                        <small className="text-xs leading-[1.6] text-muted-foreground">
                            {t('spaces.audience:private.detail')}
                        </small>
                    </span>
                </label>
            </div>
        </DialogFieldset>
    );
}
