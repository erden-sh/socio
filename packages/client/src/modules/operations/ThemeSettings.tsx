import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    INTENT_HINT_CHARS,
    INTENT_LABEL_COUNT,
    INTENT_VALUE,
    THEME_OUTCOMES,
    THEMES_MIN_PEOPLE,
    type ClassifyOption,
    type ClassifyUseView,
    type ThemeOutcome,
} from '@socio/shared/classify';

import { onDemand } from '../../i18n/on-demand';

import { ClassifyUseCard } from './ClassifyUseCard';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const UNSURE = '(unsure)';
const WORDS = ['operations.labeling'] as const;

/** An intent's value as Operations shows it: capitalized. */
const intentName = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

/**
 * Operations → Settings → Intent (CB-199): each session's intent, one
 * label from a list admins edit here, through the classification seam.
 */
function IntentCard() {
    const { t } = useTranslation(WORDS);
    return (
        <ClassifyUseCard
            use="intent"
            title={t('operations.labeling:intent.title')}
            slot="intent-label"
            intro={t('operations.labeling:intent.intro')}
            switchTitle={t('operations.labeling:intent.switch')}
            switchHelp={t('operations.labeling:intent.switch-help')}
            labelName={(label) => (label === UNSURE ? t('operations.labeling:unsure') : intentName(label))}
            extra={({ view, busy, send }) => <IntentLabelsEditor view={view} busy={busy} send={send} />}
        />
    );
}

/**
 * Operations → Settings → Themes (CB-199): one to three topics and an
 * outcome hint per session, clustered into themes.
 */
function ThemeCard() {
    const { t } = useTranslation(WORDS);
    return (
        <ClassifyUseCard
            use="themes"
            title={t('operations.labeling:themes.title')}
            slot="theme-label"
            intro={t('operations.labeling:themes.intro', { min: THEMES_MIN_PEOPLE })}
            switchTitle={t('operations.labeling:themes.switch')}
            switchHelp={t('operations.labeling:themes.switch-help')}
            labelName={(label) =>
                label === UNSURE
                    ? t('operations.labeling:unsure')
                    : (THEME_OUTCOMES as readonly string[]).includes(label)
                      ? t(`operations.labeling:themes.outcomes.${label as ThemeOutcome}`)
                      : label
            }
        />
    );
}

export const IntentSettings = onDemand(WORDS, IntentCard);
export const ThemeSettings = onDemand(WORDS, ThemeCard);

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
    const { t } = useTranslation(WORDS);
    const [labels, setLabels] = useState<ClassifyOption[]>(view.labels ?? []);
    const headingId = useId();
    useEffect(() => setLabels(view.labels ?? []), [view.labels]);
    const values = labels.map((label) => label.value);
    const problems = labels.map((label, index) =>
        !INTENT_VALUE.test(label.value)
            ? t('operations.labeling:intent.list.bad-value')
            : values.indexOf(label.value) !== index
              ? t('operations.labeling:intent.list.duplicate')
              : !label.hint.trim()
                ? t('operations.labeling:intent.list.no-meaning')
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
            toast.success(t('operations.labeling:intent.list.saved'));
        }
    };
    return (
        <section aria-labelledby={headingId} className="mt-6 grid gap-3 border-t pt-4" data-slot="intent-labels">
            <div className="grid gap-1">
                <h4 id={headingId} className="m-0 font-medium">
                    {t('operations.labeling:intent.list.title')}
                </h4>
                <p className="m-0 text-sm text-muted-foreground">
                    {t('operations.labeling:intent.list.description', {
                        min: INTENT_LABEL_COUNT.min,
                        max: INTENT_LABEL_COUNT.max,
                    })}
                </p>
            </div>
            <ul className="m-0 grid list-none gap-3 p-0">
                {labels.map((label, index) => (
                    <li key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-start">
                        <label className="grid gap-1">
                            <span className="text-xs text-muted-foreground">
                                {t('operations.labeling:intent.list.value')}
                            </span>
                            <Input
                                value={label.value}
                                maxLength={24}
                                aria-invalid={!!problems[index]}
                                onChange={(event) => set(index, { value: event.target.value.trim().toLowerCase() })}
                            />
                        </label>
                        <label className="grid gap-1">
                            <span className="text-xs text-muted-foreground">
                                {t('operations.labeling:intent.list.meaning')}
                            </span>
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
                            aria-label={t('operations.labeling:intent.list.remove-label', {
                                value: label.value,
                                context: label.value ? undefined : 'unnamed',
                            })}
                            disabled={labels.length <= INTENT_LABEL_COUNT.min}
                            onClick={() => setLabels(labels.filter((_, i) => i !== index))}
                        >
                            {t('operations.labeling:intent.list.remove')}
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
                    {t('operations.labeling:intent.list.add')}
                </Button>
                <Button type="button" disabled={busy || !valid || !changed} onClick={() => void save(labels)}>
                    {t('operations.labeling:intent.list.save')}
                </Button>
                {!isDefault && (
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                        {t('operations.labeling:intent.list.reset')}
                    </Button>
                )}
            </div>
        </section>
    );
}
