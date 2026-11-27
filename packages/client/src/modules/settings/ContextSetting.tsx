import { useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    DEFAULT_CONTEXT_SETTINGS,
    NOTES_SELECTIONS,
    SUMMARY_MODELS,
    type ContextSettings,
} from '@socio/shared/context-settings';

import { SettingsCard, nativeSelect } from './AccountSettings';

/**
 * Long chats (CB-137, CB-134) in Settings → Workspace → General: which
 * model writes a long chat's running notes, and which of their pinned
 * facts each prompt carries, saved over `CONTEXT_SUMMARY_MODEL` and
 * `CONTEXT_SELECTION`. Each choice saves as it is made, for the next turn.
 * Members read it; only admins change it.
 */
export function ContextSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: ContextSettings | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const [value, setValue] = useState<ContextSettings>(settings ?? DEFAULT_CONTEXT_SETTINGS);
    const save = async (change: Partial<ContextSettings>) => {
        const previous = value;
        setValue({ ...value, ...change });
        if (await mutate('/settings', 'PATCH', { context: change })) {
            toast.success(t('settings.workspace:context.saved'));
        } else {
            setValue(previous);
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="context-settings">
                <div className="grid gap-1">
                    <h3 className="font-medium">{t('settings.workspace:context.title')}</h3>
                    <p className="text-muted-foreground">{t('settings.workspace:context.intro')}</p>
                </div>
                <div className="grid gap-2">
                    <label htmlFor="context-summary-model" className="font-medium">
                        {t('settings.workspace:context.summaryModel')}
                    </label>
                    <select
                        id="context-summary-model"
                        className={`${nativeSelect} w-fit`}
                        disabled={readOnly}
                        value={value.summaryModel}
                        onChange={(event) =>
                            save({
                                summaryModel: event.target.value as ContextSettings['summaryModel'],
                            })
                        }
                    >
                        {SUMMARY_MODELS.map((model) => (
                            <option key={model} value={model}>
                                {t(`settings.workspace:context.models.${model}`)}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground">{t('settings.workspace:context.summaryModelHint')}</p>
                </div>
                <div className="grid gap-2">
                    <label htmlFor="context-selection" className="font-medium">
                        {t('settings.workspace:context.selection')}
                    </label>
                    <select
                        id="context-selection"
                        className={`${nativeSelect} w-fit`}
                        disabled={readOnly}
                        value={value.selection}
                        onChange={(event) =>
                            save({
                                selection: event.target.value as ContextSettings['selection'],
                            })
                        }
                    >
                        {NOTES_SELECTIONS.map((selection) => (
                            <option key={selection} value={selection}>
                                {t(`settings.workspace:context.selections.${selection}`)}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground">{t('settings.workspace:context.selectionHint')}</p>
                </div>
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.settings')}</p>}
            </section>
        </SettingsCard>
    );
}
