import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';

/**
 * Settings that save as they change (CB-308), instead of a Save button on
 * each card: toggles and selects save at once (`change`), text and number
 * fields when they lose focus (`commit`). The card says "Saving…", then
 * "Saved"; a toast says what changed and offers Undo, which puts back
 * what that save replaced. A value that fails its check shows its error
 * in the card and isn't saved.
 */
export type SaveStatus = 'idle' | 'saving' | 'saved';

/** What a save did, for its toast: a string, or worked out from the values. */
type Message<T> = string | ((next: T, previous: T) => string);

/** Whether a save's toast offers Undo: always, or worked out from the values. */
type Undoable<T> = boolean | ((next: T, previous: T) => boolean);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useAutosave<T extends Record<string, unknown>>(
    /** The saved values, from the server; followed while nothing is unsaved. */
    initial: T,
    /**
     * Saves the whole card. False, or an Error thrown, means it didn't save
     * (the Error's message is shown).
     */
    persist: (value: T) => Promise<boolean | void>,
) {
    const { t } = useTranslation(['settings']);
    const failed = t('settings:save.failed');
    const [draft, setDraft] = useState(initial);
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [error, setError] = useState('');
    // The values as last saved (or being saved), the draft as typed, and the
    // saves still on their way: one card's saves go one after another, in
    // the order they were made.
    const saved = useRef(initial);
    const current = useRef(initial);
    const pending = useRef(0);
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    const persistRef = useRef(persist);
    persistRef.current = persist;

    const show = useCallback((next: T) => {
        current.current = next;
        setDraft(next);
    }, []);

    // Another admin's change, or the server's answer, comes in through the
    // props: taken as is while the card has nothing unsaved. One that comes
    // while a save is on its way (a card whose save hands back the new
    // values) is taken once that save is done.
    const initialKey = JSON.stringify(initial);
    const latest = useRef(initialKey);
    latest.current = initialKey;
    const adopted = useRef(initialKey);
    const adopt = useCallback(() => {
        if (adopted.current === latest.current) {
            return;
        }
        if (pending.current || !same(current.current, saved.current)) {
            return;
        }
        adopted.current = latest.current;
        const next = JSON.parse(latest.current) as T;
        saved.current = next;
        show(next);
    }, [show]);
    useEffect(adopt, [initialKey, adopt]);

    const write = useCallback(
        (next: T, message: Message<T> | undefined, undoable: Undoable<T>) => {
            const previous = saved.current;
            saved.current = next;
            pending.current += 1;
            setStatus('saving');
            setError('');
            const run = async () => {
                let problem = '';
                try {
                    if ((await persistRef.current(next)) === false) {
                        problem = failed;
                    }
                } catch (failure) {
                    problem = failure instanceof Error && failure.message ? failure.message : failed;
                }
                pending.current -= 1;
                if (problem) {
                    // The card shows what is really saved, and why the change isn't.
                    if (same(saved.current, next)) {
                        saved.current = previous;
                        show({ ...current.current, ...changed(previous, next) });
                    }
                    setError(problem);
                    setStatus(pending.current ? 'saving' : 'idle');
                    return;
                }
                setStatus(pending.current ? 'saving' : 'saved');
                adopt();
                if (!message) {
                    return;
                }
                const text = typeof message === 'function' ? message(next, previous) : message;
                // Undo puts back only what this save changed, over what is saved now.
                const back = changed(previous, next);
                const offer = typeof undoable === 'function' ? undoable(next, previous) : undoable;
                toast.success(
                    text,
                    offer && Object.keys(back).length
                        ? {
                              action: {
                                  label: t('settings:save.undo'),
                                  onClick: () => {
                                      const restored = { ...saved.current, ...back };
                                      show({ ...current.current, ...back });
                                      write(restored, t('settings:save.undone'), false);
                                  },
                              },
                          }
                        : undefined,
                );
            };
            const done = queue.current.then(run);
            queue.current = done;
            return done;
        },
        [show, adopt, failed, t],
    );

    const perform = useCallback(
        (task: () => Promise<boolean | void>, message?: string) => {
            pending.current += 1;
            setStatus('saving');
            setError('');
            const run = async () => {
                let problem = '';
                try {
                    if ((await task()) === false) {
                        problem = failed;
                    }
                } catch (failure) {
                    problem = failure instanceof Error && failure.message ? failure.message : failed;
                }
                pending.current -= 1;
                if (problem) {
                    setError(problem);
                    setStatus(pending.current ? 'saving' : 'idle');
                    return;
                }
                setStatus(pending.current ? 'saving' : 'saved');
                adopt();
                if (message) {
                    toast.success(message);
                }
            };
            const done = queue.current.then(run);
            queue.current = done;
            return done;
        },
        [adopt, failed],
    );

    return {
        /** The values as shown: saved, or as typed and not saved yet. */
        value: draft,
        status,
        error,
        setError,
        /** The values as last saved (or being saved). */
        saved: useCallback(() => saved.current, []),
        /**
         * A save that isn't one of the card's values, such as a key, which is
         * write-only, or going back to the server's defaults: the same
         * "Saving…", "Saved" and errors, and a toast without Undo. The values
         * the server then sends come in through the props.
         */
        perform,
        /** A typed change, saved by `commit` (when the field loses focus). */
        edit: useCallback((patch: Partial<T>) => show({ ...current.current, ...patch }), [show]),
        /** A toggle's or a select's change, saved at once. */
        change: useCallback(
            (patch: Partial<T>, message?: Message<T>, undoable: Undoable<T> = true) => {
                show({ ...current.current, ...patch });
                return write({ ...saved.current, ...patch }, message, undoable);
            },
            [show, write],
        ),
        /**
         * Saves the typed values when they differ from the saved ones and pass
         * `check` (which returns the error to show, if any). `undoable` false
         * leaves Undo out of the toast, for a save Undo couldn't take back.
         */
        commit: useCallback(
            (message?: Message<T>, check?: (value: T) => string | undefined, undoable: Undoable<T> = true) => {
                const next = current.current;
                if (same(next, saved.current)) {
                    setError('');
                    return;
                }
                const problem = check?.(next);
                if (problem) {
                    setError(problem);
                    return;
                }
                return write(next, message, undoable);
            },
            [write],
        ),
    };
}

/** The fields of `before` whose values `after` changed. */
function changed<T extends Record<string, unknown>>(before: T, after: T) {
    return Object.fromEntries(
        Object.keys(after)
            .filter((key) => !same(before[key], after[key]))
            .map((key) => [key, before[key]]),
    ) as Partial<T>;
}

/** "Saving…", then "Saved", at the top right of a card. */
export function SaveStatusNote({ status }: { status: SaveStatus }) {
    const { t } = useTranslation(['settings']);
    return (
        <span
            role="status"
            aria-live="polite"
            data-slot="save-status"
            data-status={status}
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
        >
            {status === 'saving' && t('settings:save.saving')}
            {status === 'saved' && (
                <>
                    <Check className="size-3.5" aria-hidden="true" />
                    {t('settings:save.saved')}
                </>
            )}
        </span>
    );
}

/** A card's title and intro, with its save status beside the title. */
export function AutosaveHeader({
    title,
    status,
    children,
}: {
    title: ReactNode;
    status?: SaveStatus;
    children?: ReactNode;
}) {
    return (
        <div className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-medium">{title}</h3>
                {status && <SaveStatusNote status={status} />}
            </div>
            {children && <p className="text-muted-foreground">{children}</p>}
        </div>
    );
}

/** A card's save error, in the card (the value isn't saved). */
export function SaveError({ error }: { error: string }) {
    return error ? (
        <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
            {error}
        </p>
    ) : null;
}
