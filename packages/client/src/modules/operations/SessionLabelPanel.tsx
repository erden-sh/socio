import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import { Trans, useTranslation } from '@socio/i18n/react';
import {
    THEME_OUTCOMES,
    THEME_TOPIC_CHARS,
    THEME_TOPICS,
    type SessionLabelView,
    type ThemeOutcome,
} from '@socio/shared/classify';
import { intentName } from '@socio/shared/operations/operations-themes';

import { api } from '../../lib/api';

import { formatWhen } from './format';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * A session's labels in Themes' review (CB-199): the chat's title and
 * the session's first person messages, scrubbed as the model read them;
 * the model's intent and topics; and an admin's, in force at once and
 * part of each use's golden set. Opening it is on the access log.
 */
export function SessionLabelPanel({ runId, timeZone }: { runId: string; timeZone: string }) {
    const { t } = useTranslation(['operations.themes', 'operations']);
    const [view, setView] = useState<SessionLabelView>();
    const [intent, setIntent] = useState('');
    const [topics, setTopics] = useState<string[]>(['', '', '']);
    const [outcome, setOutcome] = useState<ThemeOutcome>('unclear');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const textId = useId();
    const path = `/classify/sessions/${encodeURIComponent(runId)}`;

    const show = (next: SessionLabelView) => {
        setView(next);
        setIntent(next.intent.label?.value ?? next.intent.suggestion?.value ?? '');
        const theme = next.themes.label ?? next.themes.suggestion;
        setTopics(Array.from({ length: THEME_TOPICS }, (_, i) => theme?.topics[i] ?? ''));
        setOutcome(theme?.outcome ?? 'unclear');
    };
    useEffect(() => {
        const controller = new AbortController();
        api<SessionLabelView>(`${path}?via=themes`, 'GET', undefined, controller.signal)
            .then((next) => !controller.signal.aborted && show(next))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : t('operations.themes:label.load-failed'));
                }
            });
        return () => controller.abort();
    }, [path, t]);

    const save = async (use: 'intent' | 'themes', body: unknown) => {
        setBusy(true);
        setError('');
        try {
            show(await api<SessionLabelView>(`${path}/${use}`, 'PUT', body));
            toast.success(t('operations.themes:label.saved'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.themes:label.save-failed'));
        } finally {
            setBusy(false);
        }
    };

    if (!view) {
        return error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
                {error}
            </p>
        ) : (
            <Skeleton className="h-32 w-full" />
        );
    }
    const given = topics.map((topic) => topic.trim()).filter(Boolean);
    const by = (label: { source: string; by: string | null; at: number }) =>
        label.source !== 'admin'
            ? t('operations.themes:label.by-model', { when: formatWhen(label.at, timeZone) })
            : label.by
              ? t('operations.themes:label.by-admin', { name: label.by, when: formatWhen(label.at, timeZone) })
              : t('operations.themes:label.by-unknown', { when: formatWhen(label.at, timeZone) });
    return (
        <section
            aria-label={t('operations.themes:label.title')}
            data-slot="ops-session-label"
            className="grid gap-3 text-sm"
        >
            <div className="grid gap-1">
                <span id={textId} className="text-xs text-muted-foreground">
                    {t('operations.themes:label.input')}
                </span>
                <div
                    aria-labelledby={textId}
                    className="grid gap-1 rounded-md border bg-background p-2 text-xs break-words whitespace-pre-wrap"
                >
                    <p className="m-0 font-medium">{view.input.title || t('operations.themes:label.untitled')}</p>
                    {view.input.messages.map((message, index) => (
                        <p key={index} className="m-0 font-mono">
                            {message}
                        </p>
                    ))}
                </div>
            </div>

            <div className="grid gap-2" data-slot="ops-session-intent">
                <h4 className="m-0 font-medium">{t('operations.themes:label.intent')}</h4>
                {view.intent.suggestion && (
                    <p className="m-0 text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="operations.themes:label.model-intent"
                            context={view.intent.suggestion.applied ? 'applied' : undefined}
                            values={{
                                intent: intentName(view.intent.suggestion.value),
                                confidence: view.intent.suggestion.confidence,
                            }}
                            components={{ strong: <span className="font-medium text-foreground" /> }}
                        />
                    </p>
                )}
                {view.intent.label && (
                    <p className="m-0 text-muted-foreground">
                        {t('operations.themes:label.in-force', {
                            value: intentName(view.intent.label.value),
                            by: by(view.intent.label),
                        })}
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={intent} onValueChange={setIntent}>
                        <SelectTrigger size="sm" aria-label={t('operations.themes:label.intent')} className="w-48">
                            <SelectValue placeholder={t('operations.themes:label.choose-intent')} />
                        </SelectTrigger>
                        <SelectContent>
                            {view.intentLabels.map((label) => (
                                <SelectItem key={label.value} value={label.value} title={label.hint}>
                                    {intentName(label.value)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        type="button"
                        size="sm"
                        disabled={busy || !intent}
                        onClick={() => void save('intent', { value: intent })}
                    >
                        {t('operations.themes:label.save-intent')}
                    </Button>
                </div>
            </div>

            <div className="grid gap-2" data-slot="ops-session-themes">
                <h4 className="m-0 font-medium">{t('operations.themes:label.topics')}</h4>
                {view.themes.suggestion && (
                    <p className="m-0 text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="operations.themes:label.model-topics"
                            context={view.themes.suggestion.applied ? 'applied' : undefined}
                            values={{
                                topics: view.themes.suggestion.topics.join(', '),
                                outcome: t(`operations.themes:outcome-inline.${view.themes.suggestion.outcome}`),
                                confidence: view.themes.suggestion.confidence,
                            }}
                            components={{ strong: <span className="font-medium text-foreground" /> }}
                        />
                    </p>
                )}
                {view.themes.label && (
                    <p className="m-0 text-muted-foreground">
                        {t('operations.themes:label.in-force', {
                            value: view.themes.label.topics.join(', '),
                            by: by(view.themes.label),
                        })}
                    </p>
                )}
                <div className="grid gap-2 sm:grid-cols-3">
                    {topics.map((topic, index) => (
                        <Input
                            key={index}
                            value={topic}
                            maxLength={THEME_TOPIC_CHARS}
                            aria-label={t('operations.themes:label.topic', { n: index + 1 })}
                            placeholder={
                                index
                                    ? t('operations.themes:label.another-topic')
                                    : t('operations.themes:label.main-topic')
                            }
                            onChange={(event) =>
                                setTopics(topics.map((item, i) => (i === index ? event.target.value : item)))
                            }
                        />
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={outcome} onValueChange={(value) => setOutcome(value as ThemeOutcome)}>
                        <SelectTrigger
                            size="sm"
                            aria-label={t('operations.themes:label.outcome-hint')}
                            className="w-48"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {THEME_OUTCOMES.map((value) => (
                                <SelectItem key={value} value={value}>
                                    {t(`operations.themes:outcome.${value}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        type="button"
                        size="sm"
                        disabled={busy || !given.length}
                        onClick={() => void save('themes', { topics: given, outcome })}
                    >
                        {t('operations.themes:label.save-topics')}
                    </Button>
                    <span className="text-xs text-muted-foreground">{t('operations.themes:label.topics-hint')}</span>
                </div>
            </div>
            {error && (
                <p role="alert" className="m-0 text-destructive">
                    {error}
                </p>
            )}
        </section>
    );
}
