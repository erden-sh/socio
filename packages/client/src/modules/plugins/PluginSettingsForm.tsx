import { Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Trans, useTranslation } from '@socio/i18n/react';
import { configErrors, configType, type PluginConfigField } from '@socio/shared/plugins/plugin-config';

import { nativeSelect } from '../../components/form-fields';
import { SaveError, SaveStatusNote, type SaveStatus } from '../settings/autosave';

import type { InstalledRow } from './plugin-rows';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type Config = Record<string, string>;

/**
 * What a save answered: for a running service plugin, how long the server
 * waits before its service gets the saved settings (CB-398 follow-up).
 */
export type PluginSaveResult = { applyInMs?: number; egress?: InstalledRow['egress'] } | void;

/** Where the saved settings are on their way to a running service plugin. */
export type ApplyStatus = 'idle' | 'pending' | 'applying' | 'applied' | 'failed';

/** How long typing rests before it saves; switches and lists save at once. */
export const AUTOSAVE_DELAY_MS = 800;

/**
 * Each plugin's saves, one after another, across pages: a page closed with
 * a save still on its way and opened again queues behind it, so an older
 * save never lands after a newer one.
 */
const queues = new Map<string, Promise<unknown>>();

/** Once a plugin's saves still on their way are done: its page loads after them, so it starts from what they saved. */
export const pluginSavesSettled = (id: string) =>
    (queues.get(id) ?? Promise.resolve()).then(
        () => undefined,
        () => undefined,
    );

/** The values as they are stored: trimmed, and an empty one left out (the plugin's default). */
export function storedConfig(values: Config) {
    return Object.fromEntries(
        Object.entries(values)
            .map(([key, value]) => [key, value.trim()] as const)
            .filter(([, value]) => value !== ''),
    );
}

const same = (a: Config, b: Config) => {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
};

/**
 * What a save sends: each setting as typed when it passes its check, else
 * as it is saved now. An invalid value is never sent; the other settings
 * still save.
 */
export function validPart(fields: Record<string, PluginConfigField>, typed: Config, saved: Config): Config {
    const errors = configErrors(fields, typed);
    const next: Config = {};
    for (const key of Object.keys(fields)) {
        const value = errors[key] ? saved[key] : typed[key];
        if (value !== undefined && value !== '') {
            next[key] = value;
        }
    }
    return next;
}

/** Whether a key press is undo (-1), redo (1), or neither (0): Ctrl or ⌘ with Z, Shift for redo, or Ctrl+Y. */
export function historyKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return 0;
    }
    const key = event.key.toLowerCase();
    if (key === 'z') {
        return event.shiftKey ? 1 : -1;
    }
    return key === 'y' && !event.shiftKey ? 1 : 0;
}

/**
 * A plugin's settings (CB-394, CB-395, CB-398), from its manifest's
 * `config`, laid out as the Settings cards are, with an input for each type.
 * They save as they change (the settings are not secrets): a switch or a
 * list at once, typing once it rests or the field is left. Only values that
 * pass their check are sent; a field with an error shows it and keeps its
 * saved value. "Saving…" and "Saved" show at the top, a failed save's
 * reason below. Undo and Redo (also Ctrl+Z or ⌘Z, and Ctrl+Shift+Z, ⌘⇧Z or
 * Ctrl+Y) step through the saves made on this page, saving each step.
 *
 * A running service plugin restarts to take new settings, so they reach it
 * once the saves settle (CB-398 follow-up): the page says they apply in a
 * few seconds, offers **Apply now**, and applies them as it is left.
 */
export function PluginSettingsForm({
    plugin,
    onSave,
    onApply,
    onLeave,
}: {
    plugin: InstalledRow;
    /** Saves the whole config; throws with the reason when it can't. */
    onSave: (config: Config) => Promise<PluginSaveResult>;
    /** Gives the plugin its saved settings now; throws with the reason when it can't. */
    onApply?: () => Promise<void>;
    /** The tab is closing with settings not yet applied: a request that outlives the page. */
    onLeave?: () => void;
}) {
    const { t } = useTranslation(['plugins.settings']);
    const fields = plugin.configFields ?? {};
    const initial = plugin.config ?? {};
    const [values, setValues] = useState<Config>(initial);
    // Fields whose errors show: those left or changed. A saved value that
    // doesn't fit (a setting a newer version typed differently, a required
    // one not set yet) shows its error at once.
    const [touched, setTouched] = useState<Set<string>>(
        () => new Set(Object.keys(configErrors(fields, storedConfig(initial)))),
    );
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState('');
    // This page's saves, oldest first, and where the settings are in them.
    const [history, setHistory] = useState<{ entries: Config[]; index: number }>({ entries: [initial], index: 0 });
    // The history as the queued saves see it (state renders it): a step
    // queued right behind a save reads that save's entry.
    const historyRef = useRef(history);
    const record = useCallback((next: { entries: Config[]; index: number }) => {
        historyRef.current = next;
        setHistory(next);
    }, []);
    const valuesRef = useRef(values);
    const saved = useRef<Config>(initial);
    // Fields are held while an undo or redo is on its way: what it puts back
    // would otherwise replace what was typed meanwhile.
    const [stepping, setStepping] = useState(0);
    const pending = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    // Not a <form>: nothing submits (Enter saves the field instead).
    const form = useRef<HTMLDivElement>(null);
    const fieldsRef = useRef(fields);
    fieldsRef.current = fields;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onApplyRef = useRef(onApply);
    onApplyRef.current = onApply;
    const onLeaveRef = useRef(onLeave);
    onLeaveRef.current = onLeave;
    const [applyStatus, setApplyStatus] = useState<ApplyStatus>('idle');
    // Why the last apply failed, apart from a save's error.
    const [applyError, setApplyError] = useState('');
    // Saved settings the plugin hasn't been given yet, and when they apply.
    const unapplied = useRef(false);
    const applyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    /**
     * Gives the plugin its saved settings, after the saves on their way (they
     * are what it gets). Later saves don't wait for it; the server runs one
     * apply at a time and one more for saves made during it.
     */
    const apply = useCallback(() => {
        clearTimeout(applyTimer.current);
        applyTimer.current = undefined;
        const run = async () => {
            if (!unapplied.current || !onApplyRef.current) {
                return;
            }
            clearTimeout(applyTimer.current);
            applyTimer.current = undefined;
            unapplied.current = false;
            setApplyStatus('applying');
            try {
                await onApplyRef.current();
                setApplyError('');
                // A save since then applies on its own wait.
                setApplyStatus((current) => (unapplied.current ? current : 'applied'));
            } catch (failure) {
                unapplied.current = true;
                setApplyStatus('failed');
                setApplyError(
                    failure instanceof Error && failure.message ? failure.message : t('plugins.settings:apply-failed'),
                );
            }
        };
        return (queues.get(plugin.id) ?? Promise.resolve()).then(run, run);
    }, [plugin.id, t]);

    const show = useCallback((next: Config) => {
        valuesRef.current = next;
        setValues(next);
    }, []);

    /** One save after the ones before it: `pick` decides what, when its turn comes. */
    const enqueue = useCallback(
        (pick: () => { config: Config; done: () => void } | undefined) => {
            pending.current += 1;
            setStatus('saving');
            const run = async () => {
                const step = pick();
                let ok = false;
                try {
                    if (!step) {
                        return;
                    }
                    const result = await onSaveRef.current(step.config);
                    saved.current = step.config;
                    if (result && typeof result.applyInMs === 'number') {
                        // Each save starts the wait again, as the server's does.
                        unapplied.current = true;
                        setApplyStatus('pending');
                        clearTimeout(applyTimer.current);
                        applyTimer.current = setTimeout(() => void apply(), result.applyInMs);
                    }
                    step.done();
                    ok = true;
                    setError('');
                } catch (failure) {
                    setError(
                        failure instanceof Error && failure.message
                            ? failure.message
                            : t('plugins.settings:save-failed'),
                    );
                } finally {
                    pending.current -= 1;
                    if (!pending.current) {
                        // "Saved" after a save that worked; after a failure, or
                        // nothing to save, the status goes quiet (the error says why).
                        setStatus((current) => (ok ? 'saved' : current === 'saving' ? 'idle' : current));
                    }
                }
            };
            const done = (queues.get(plugin.id) ?? Promise.resolve()).then(run, run);
            queues.set(plugin.id, done);
            return done;
        },
        [plugin.id, apply, t],
    );

    /** Saves what is typed now (its valid part), when it differs from what is saved. */
    const flush = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = undefined;
        // The values as they are now: typing after this is its own save.
        const draft = storedConfig(valuesRef.current);
        return enqueue(() => {
            const next = validPart(fieldsRef.current, draft, saved.current);
            if (same(next, saved.current)) {
                return undefined;
            }
            return {
                config: next,
                done: () => {
                    const current = historyRef.current;
                    record({
                        entries: [...current.entries.slice(0, current.index + 1), next],
                        index: current.index + 1,
                    });
                },
            };
        });
    }, [enqueue, record]);

    const step = useCallback(
        (by: -1 | 1) => {
            // What is being typed is saved first, so undo takes it back.
            if (timer.current) {
                void flush();
            }
            setStepping((count) => count + 1);
            const done = enqueue(() => {
                const { entries, index } = historyRef.current;
                const target = entries[index + by];
                if (!target) {
                    return undefined;
                }
                return {
                    config: target,
                    done: () => {
                        record({ entries, index: index + by });
                        show(target);
                        setTouched(new Set());
                    },
                };
            });
            void done.finally(() => setStepping((count) => count - 1));
            return done;
        },
        [enqueue, flush, show, record],
    );

    // Typing saves once it rests; a switch or a list also calls onBlur at
    // once, which saves it then.
    const edit = (key: string, value: string) => {
        show({ ...valuesRef.current, [key]: value });
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    };

    // Undo and redo from the keyboard, anywhere on the page but another
    // field's own typing.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const by = historyKey(event);
            if (!by) {
                return;
            }
            const target = event.target as HTMLElement | null;
            const editable = !!target?.closest('input, textarea, select, [contenteditable="true"]');
            if (editable && !form.current?.contains(target)) {
                return;
            }
            const { entries, index } = historyRef.current;
            if (!entries[index + by] && !timer.current) {
                return;
            }
            event.preventDefault();
            void step(by);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [step]);

    // Leaving the page saves what was still being typed, and gives the
    // plugin what was saved, once those saves land.
    useEffect(
        () => () => {
            if (timer.current) {
                void flush();
            }
            void apply();
            clearTimeout(applyTimer.current);
        },
        [flush, apply],
    );

    // Closing the tab: the server applies them after its wait anyway; this
    // asks for it at once.
    useEffect(() => {
        const onHide = () => {
            if (unapplied.current) {
                onLeaveRef.current?.();
            }
        };
        window.addEventListener('pagehide', onHide);
        return () => window.removeEventListener('pagehide', onHide);
    }, []);

    const errors = configErrors(fields, storedConfig(values));
    const canUndo = history.index > 0;
    const canRedo = history.index < history.entries.length - 1;
    return (
        <div
            ref={form}
            role="group"
            aria-label={t('plugins.settings:label')}
            className="grid gap-5"
            // Enter in a field saves it now, as leaving it does.
            onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') {
                    event.preventDefault();
                    void flush();
                }
            }}
            data-slot="plugin-settings"
        >
            <div className="flex items-center justify-between gap-3" data-slot="plugin-settings-toolbar">
                <div className="flex flex-wrap items-center gap-2">
                    <SaveStatusNote status={status} />
                    <ApplyNote status={applyStatus} onApply={onApply ? () => void apply() : undefined} />
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canUndo}
                        aria-keyshortcuts="Control+Z Meta+Z"
                        onClick={() => void step(-1)}
                    >
                        <Undo2 aria-hidden="true" />
                        {t('plugins.settings:undo')}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canRedo}
                        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
                        onClick={() => void step(1)}
                    >
                        <Redo2 aria-hidden="true" />
                        {t('plugins.settings:redo')}
                    </Button>
                </div>
            </div>
            {Object.entries(fields).map(([key, field]) => (
                <SettingField
                    key={key}
                    name={key}
                    field={field}
                    value={values[key] ?? ''}
                    disabled={stepping > 0}
                    error={touched.has(key) ? errors[key] : undefined}
                    onChange={(value) => edit(key, value)}
                    onBlur={() => {
                        setTouched((current) => new Set(current).add(key));
                        if (timer.current) {
                            void flush();
                        }
                    }}
                />
            ))}
            <SaveError error={error} />
            <SaveError error={applyError} />
            <p className="text-xs text-muted-foreground">{t('plugins.settings:footnote')}</p>
        </div>
    );
}

/** Whether saved settings have reached a running service plugin, with **Apply now** while they wait. */
export function ApplyNote({ status, onApply }: { status: ApplyStatus; onApply?: () => void }) {
    const { t } = useTranslation(['plugins.settings']);
    if (status === 'idle') {
        return null;
    }
    return (
        <span
            role="status"
            aria-live="polite"
            data-slot="apply-status"
            data-status={status}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
            {t(`plugins.settings:apply.${status}`)}
            {(status === 'pending' || status === 'failed') && onApply && (
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onApply}>
                    {t('plugins.settings:apply.now')}
                </Button>
            )}
        </span>
    );
}

/** One setting: its label, the input its type takes, its help and its error. */
export function SettingField({
    name,
    field,
    value,
    error,
    disabled,
    onChange,
    onBlur,
}: {
    name: string;
    field: PluginConfigField;
    value: string;
    error?: string;
    disabled?: boolean;
    onChange: (value: string) => void;
    onBlur?: () => void;
}) {
    const { t } = useTranslation(['plugins.settings']);
    const id = useId();
    const type = configType(field);
    const help = `${id}-help`;
    const errorId = `${id}-error`;
    const described = error ? `${help} ${errorId}` : help;
    const common = {
        id,
        disabled,
        'aria-describedby': described,
        'aria-invalid': error ? true : undefined,
        'aria-required': field.required ? true : undefined,
    } as const;
    let input;
    if (type === 'boolean') {
        const on = (value || field.default || 'false') === 'true';
        input = (
            <Switch
                {...common}
                checked={on}
                onCheckedChange={(checked) => {
                    onChange(checked ? 'true' : 'false');
                    onBlur?.();
                }}
            />
        );
    } else if (type === 'enum') {
        input = (
            <select
                {...common}
                data-slot="native-select"
                className={cn(nativeSelect, 'w-full max-w-md')}
                value={value}
                onChange={(event) => {
                    onChange(event.target.value);
                    onBlur?.();
                }}
                onBlur={onBlur}
            >
                {(!field.required || field.default) && (
                    <option value="">
                        {field.default
                            ? t('plugins.settings:field.default-choice', { value: field.default })
                            : t('plugins.settings:field.not-set')}
                    </option>
                )}
                {field.required && !field.default && !value && (
                    <option value="" disabled>
                        {t('plugins.settings:field.choose')}
                    </option>
                )}
                {value && !(field.options ?? []).includes(value) && (
                    // A saved value that is no longer a choice shows as it is, with its error.
                    <option value={value} disabled>
                        {t('plugins.settings:field.not-a-choice', { value })}
                    </option>
                )}
                {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                        {option}
                    </option>
                ))}
            </select>
        );
    } else {
        const numeric = type === 'number' || type === 'integer';
        input = (
            <Input
                {...common}
                className={cn('max-w-md', type === 'cron' && 'font-mono')}
                // Text, not type=number: a number field reports half-typed input
                // ("1e") as empty, which would save as unset; the check below
                // sees exactly what was typed.
                type={type === 'url' ? 'url' : 'text'}
                inputMode={numeric ? (type === 'integer' ? 'numeric' : 'decimal') : undefined}
                spellCheck={type === 'string' ? undefined : false}
                autoComplete="off"
                value={value}
                placeholder={field.default ?? (type === 'cron' ? '0 9 * * 1-5' : type === 'url' ? 'https://' : '')}
                onChange={(event) => onChange(event.target.value)}
                onBlur={onBlur}
            />
        );
    }
    return (
        <div
            className={cn('grid content-start gap-1.5', type === 'boolean' && 'grid-cols-[1fr_auto] items-center')}
            data-slot="plugin-setting"
            data-key={name}
            data-type={type}
        >
            <label htmlFor={id} className="font-mono text-xs font-medium break-all">
                {name}
                {field.required && (
                    <span className="ml-1 font-sans text-destructive" aria-hidden="true">
                        *
                    </span>
                )}
            </label>
            {input}
            <p id={help} className={cn('text-muted-foreground', type === 'boolean' && 'col-span-2')}>
                {field.description}
                {field.default ? (
                    <>
                        {' '}
                        <Trans
                            t={t}
                            i18nKey="plugins.settings:field.default"
                            values={{ value: field.default }}
                            components={{ code: <code className="text-xs" /> }}
                        />
                    </>
                ) : null}
                {field.required && !field.default ? ` ${t('plugins.settings:field.required')}` : null}
            </p>
            {error && (
                <p
                    id={errorId}
                    className={cn('text-destructive', type === 'boolean' && 'col-span-2')}
                    role="alert"
                    data-slot="plugin-setting-error"
                >
                    {error}
                </p>
            )}
        </div>
    );
}
