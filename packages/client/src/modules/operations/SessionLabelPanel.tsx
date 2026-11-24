import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';

import {
    THEME_OUTCOME_LABELS,
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
                    setError(e instanceof Error ? e.message : 'Could not load its labels.');
                }
            });
        return () => controller.abort();
    }, [path]);

    const save = async (use: 'intent' | 'themes', body: unknown) => {
        setBusy(true);
        setError('');
        try {
            show(await api<SessionLabelView>(`${path}/${use}`, 'PUT', body));
            toast.success('Saved. Themes counts it within a minute.');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
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
        `${label.source === 'admin' ? (label.by ?? 'an admin') : 'the model'}, ${formatWhen(label.at, timeZone)}`;
    return (
        <section aria-label="Session labels" data-slot="ops-session-label" className="grid gap-3 text-sm">
            <div className="grid gap-1">
                <span id={textId} className="text-xs text-muted-foreground">
                    What the model reads, scrubbed of contact details and secrets
                </span>
                <div
                    aria-labelledby={textId}
                    className="grid gap-1 rounded-md border bg-background p-2 text-xs break-words whitespace-pre-wrap"
                >
                    <p className="m-0 font-medium">{view.input.title || 'Untitled'}</p>
                    {view.input.messages.map((message, index) => (
                        <p key={index} className="m-0 font-mono">
                            {message}
                        </p>
                    ))}
                </div>
            </div>

            <div className="grid gap-2" data-slot="ops-session-intent">
                <h4 className="m-0 font-medium">Intent</h4>
                {view.intent.suggestion && (
                    <p className="m-0 text-muted-foreground">
                        The model says{' '}
                        <span className="font-medium text-foreground">{intentName(view.intent.suggestion.value)}</span>,{' '}
                        {Math.round(view.intent.suggestion.confidence * 100)}% sure
                        {view.intent.suggestion.applied ? '; it counts.' : '; a suggestion only.'}
                    </p>
                )}
                {view.intent.label && (
                    <p className="m-0 text-muted-foreground">
                        In force: {intentName(view.intent.label.value)}, by {by(view.intent.label)}.
                    </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={intent} onValueChange={setIntent}>
                        <SelectTrigger size="sm" aria-label="Intent" className="w-48">
                            <SelectValue placeholder="Choose an intent" />
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
                        Save intent
                    </Button>
                </div>
            </div>

            <div className="grid gap-2" data-slot="ops-session-themes">
                <h4 className="m-0 font-medium">Topics</h4>
                {view.themes.suggestion && (
                    <p className="m-0 text-muted-foreground">
                        The model says{' '}
                        <span className="font-medium text-foreground">{view.themes.suggestion.topics.join(', ')}</span>{' '}
                        ({THEME_OUTCOME_LABELS[view.themes.suggestion.outcome].toLowerCase()}
                        ), {Math.round(view.themes.suggestion.confidence * 100)}% sure
                        {view.themes.suggestion.applied ? '; it counts.' : '; a suggestion only.'}
                    </p>
                )}
                {view.themes.label && (
                    <p className="m-0 text-muted-foreground">
                        In force: {view.themes.label.topics.join(', ')}, by {by(view.themes.label)}.
                    </p>
                )}
                <div className="grid gap-2 sm:grid-cols-3">
                    {topics.map((topic, index) => (
                        <Input
                            key={index}
                            value={topic}
                            maxLength={THEME_TOPIC_CHARS}
                            aria-label={`Topic ${index + 1}`}
                            placeholder={index ? 'Another topic (optional)' : 'Main topic'}
                            onChange={(event) =>
                                setTopics(topics.map((t, i) => (i === index ? event.target.value : t)))
                            }
                        />
                    ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={outcome} onValueChange={(value) => setOutcome(value as ThemeOutcome)}>
                        <SelectTrigger size="sm" aria-label="Outcome hint" className="w-48">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {THEME_OUTCOMES.map((value) => (
                                <SelectItem key={value} value={value}>
                                    {THEME_OUTCOME_LABELS[value]}
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
                        Save topics
                    </Button>
                    <span className="text-xs text-muted-foreground">
                        A few plain words each; never a person’s name.
                    </span>
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
