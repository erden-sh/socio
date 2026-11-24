import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import {
    INTENT_HINT_CHARS,
    INTENT_LABEL_COUNT,
    INTENT_VALUE,
    THEME_OUTCOME_LABELS,
    THEMES_MIN_PEOPLE,
    type ClassifyOption,
    type ClassifyUseView,
    type ThemeOutcome,
} from '@socio/shared/classify';
import { intentName } from '@socio/shared/operations/operations-themes';

import { ClassifyUseCard } from './ClassifyUseCard';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const UNSURE = '(unsure)';

/**
 * Operations → Settings → Intent (CB-199): each session's intent, one
 * label from a list admins edit here, through the classification seam.
 */
export function IntentSettings() {
    return (
        <ClassifyUseCard
            use="intent"
            title="Session intent"
            slot="intent-label"
            intro="What people come to socios for: the workspace’s model reads a chat’s title and the first three messages a person wrote in a session, scrubbed of contact details and secrets and cut to 300 characters each, and picks one intent from the list below. Value and Themes show how sessions of each intent end. Its labels count only when it is sure enough and has passed an evaluation against intents admins set in Themes."
            switchTitle="Label each session’s intent"
            switchHelp="Off by default. Each session is asked about once, after its first three messages or when it ends."
            labelName={(label) => (label === UNSURE ? 'Unsure' : intentName(label))}
            extra={({ view, busy, send }) => <IntentLabelsEditor view={view} busy={busy} send={send} />}
        />
    );
}

/**
 * Operations → Settings → Themes (CB-199): one to three topics and an
 * outcome hint per session, clustered into themes.
 */
export function ThemeSettings() {
    return (
        <ClassifyUseCard
            use="themes"
            title="Session themes"
            slot="theme-label"
            intro={`What sessions are about: the workspace’s model reads the same scrubbed title and first messages and names one to three topics in a few words, never people, and whether the person seems to have got what they came for. Operations → Themes groups the topics into themes by week. A theme is named only when at least ${THEMES_MIN_PEOPLE} different people had sessions on it. Its topics count only once it has passed an evaluation against topics admins set in Themes.`}
            switchTitle="Find each session’s themes"
            switchHelp="Off by default. Each session is asked about once, after its first three messages or when it ends."
            labelName={(label) =>
                label === UNSURE ? 'Unsure' : (THEME_OUTCOME_LABELS[label as ThemeOutcome] ?? label)
            }
        />
    );
}

/** Intent's list: values and what each means, as the model is told. */
function IntentLabelsEditor({
    view,
    busy,
    send,
}: {
    view: ClassifyUseView;
    busy: boolean;
    send: (method: string, path: string, body?: unknown) => Promise<boolean>;
}) {
    const [labels, setLabels] = useState<ClassifyOption[]>(view.labels ?? []);
    const headingId = useId();
    useEffect(() => setLabels(view.labels ?? []), [view.labels]);
    const values = labels.map((label) => label.value);
    const problems = labels.map((label, index) =>
        !INTENT_VALUE.test(label.value)
            ? 'A short lowercase word: letters, digits or dashes.'
            : values.indexOf(label.value) !== index
              ? 'Each value once.'
              : !label.hint.trim()
                ? 'Say what it means.'
                : '',
    );
    const valid =
        labels.length >= INTENT_LABEL_COUNT.min &&
        labels.length <= INTENT_LABEL_COUNT.max &&
        problems.every((problem) => !problem);
    const changed = JSON.stringify(labels) !== JSON.stringify(view.labels);
    const isDefault = JSON.stringify(view.labels) === JSON.stringify(view.defaultLabels);
    const set = (index: number, patch: Partial<ClassifyOption>) =>
        setLabels(labels.map((label, i) => (i === index ? { ...label, ...patch } : label)));
    const save = async (next: ClassifyOption[] | null) => {
        if (
            await send('PUT', '/classify/uses/intent', {
                labels: next
                    ? next.map((label) => ({
                          value: label.value,
                          hint: label.hint.trim(),
                      }))
                    : null,
            })
        ) {
            toast.success('Intents saved');
        }
    };
    return (
        <section aria-labelledby={headingId} className="mt-6 grid gap-3 border-t pt-4" data-slot="intent-labels">
            <div className="grid gap-1">
                <h4 id={headingId} className="m-0 font-medium">
                    Intents
                </h4>
                <p className="m-0 text-sm text-muted-foreground">
                    {INTENT_LABEL_COUNT.min} to {INTENT_LABEL_COUNT.max} intents. Changing the list starts a new golden
                    set: the model must pass an evaluation on it again before its labels count. Labels already given
                    keep their value.
                </p>
            </div>
            <ul className="m-0 grid list-none gap-3 p-0">
                {labels.map((label, index) => (
                    <li key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
                        <label className="grid gap-1">
                            <span className="text-xs text-muted-foreground">Value</span>
                            <Input
                                value={label.value}
                                maxLength={24}
                                aria-invalid={!!problems[index]}
                                onChange={(event) => set(index, { value: event.target.value.trim().toLowerCase() })}
                            />
                        </label>
                        <label className="grid gap-1">
                            <span className="text-xs text-muted-foreground">Meaning</span>
                            <Input
                                value={label.hint}
                                maxLength={INTENT_HINT_CHARS}
                                aria-invalid={!!problems[index]}
                                onChange={(event) => set(index, { hint: event.target.value })}
                            />
                            {problems[index] && <small className="text-destructive">{problems[index]}</small>}
                        </label>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="sm:mt-5"
                            aria-label={`Remove ${label.value || 'this intent'}`}
                            disabled={labels.length <= INTENT_LABEL_COUNT.min}
                            onClick={() => setLabels(labels.filter((_, i) => i !== index))}
                        >
                            Remove
                        </Button>
                    </li>
                ))}
            </ul>
            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    variant="outline"
                    disabled={labels.length >= INTENT_LABEL_COUNT.max}
                    onClick={() => setLabels([...labels, { value: '', hint: '' }])}
                >
                    Add an intent
                </Button>
                <Button type="button" disabled={busy || !valid || !changed} onClick={() => void save(labels)}>
                    Save intents
                </Button>
                {!isDefault && (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                        Use the default list
                    </Button>
                )}
            </div>
        </section>
    );
}
