import { useState } from 'react';
import { toast } from 'sonner';

import {
    DEFAULT_CONTEXT_SETTINGS,
    NOTES_SELECTIONS,
    NOTES_SELECTION_LABELS,
    SUMMARY_MODELS,
    SUMMARY_MODEL_LABELS,
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
    const [value, setValue] = useState<ContextSettings>(settings ?? DEFAULT_CONTEXT_SETTINGS);
    const save = async (change: Partial<ContextSettings>) => {
        const previous = value;
        setValue({ ...value, ...change });
        if (await mutate('/settings', 'PATCH', { context: change })) {
            toast.success('Long chats saved');
        } else {
            setValue(previous);
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="context-settings">
                <div className="grid gap-1">
                    <h3 className="font-medium">Long chats</h3>
                    <p className="text-muted-foreground">
                        When a chat outgrows its model, its oldest turns are kept as notes: a summary and pinned facts,
                        such as decisions and ids. Nothing is deleted; socios can read any of it again.
                    </p>
                </div>
                <div className="grid gap-2">
                    <label htmlFor="context-summary-model" className="font-medium">
                        Notes are written by
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
                                {SUMMARY_MODEL_LABELS[model]}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground">
                        The shared model is the workspace’s default backend, without reasoning: notes come in seconds
                        and cost the chat’s model nothing. The chat’s own model can write fuller notes, but with
                        reasoning it may take minutes.
                    </p>
                </div>
                <div className="grid gap-2">
                    <label htmlFor="context-selection" className="font-medium">
                        Each reply sees
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
                                {NOTES_SELECTION_LABELS[selection]}
                            </option>
                        ))}
                    </select>
                    <p className="text-muted-foreground">
                        Which pinned facts go with each message once there are too many to send them all; the others
                        stay stored either way. Matching each request answered the most questions in testing. A short
                        core makes the socio search its notes, which takes more rounds.
                    </p>
                </div>
                {readOnly && <p className="text-muted-foreground">Only an admin can change these settings.</p>}
            </section>
        </SettingsCard>
    );
}
