import { DialogFieldset } from '@/components/form-fields';
import { PRIVATE_SPACE_COVERS, PrivateSpaceIcon } from '@/components/private-space';
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
    legend = 'Who can see it',
}: {
    admin: boolean;
    /** Private: only its people. */
    value: boolean;
    onChange: (privateSpace: boolean) => void;
    disabled?: boolean;
    legend?: string;
}) {
    const option = (checked: boolean) =>
        cn(
            'flex items-start gap-3 rounded-lg border p-3 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
            checked && 'border-primary/60 bg-accent/60',
            !disabled && 'cursor-pointer',
        );
    return (
        <DialogFieldset legend={legend}>
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
                        <strong className="font-medium">Whole workspace</strong>
                        <small className="text-xs leading-[1.6] text-muted-foreground">
                            Everyone in the workspace sees it and everything in it.
                            {!admin && ' Only workspace admins make a Space for everyone.'}
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
                            Only its people <PrivateSpaceIcon className="size-3.5" />
                        </strong>
                        <small className="text-xs leading-[1.6] text-muted-foreground">
                            Private: only the people added to it, and workspace admins, see it, {PRIVATE_SPACE_COVERS}.
                            Socios use it only when everyone in the chat may. Anyone else doesn’t see it exists.
                        </small>
                    </span>
                </label>
            </div>
        </DialogFieldset>
    );
}
