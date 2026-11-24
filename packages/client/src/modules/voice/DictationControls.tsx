import { Check, LoaderCircle, Mic, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { DICTATION_LABELS, DICTATION_NOTES, type DictationMethod } from '@socio/shared/voice/dictation';

import { ChatIconButton } from '../chat/chat-chrome';

import type { Dictation } from './use-dictation';

import { cn } from '@/lib/utils';

/**
 * The composer's mic (CB-101), the size and look of the link and attach
 * buttons beside it. While dictating it is lit, and stops.
 */
export function DictationButton({
    dictation,
    disabled,
    onStart,
    className,
}: {
    dictation: Dictation;
    disabled?: boolean;
    onStart: () => void;
    className?: string;
}) {
    const active = dictation.status !== 'idle';
    return (
        <ChatIconButton
            className={cn(
                className,
                active &&
                    'bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand dark:text-brand dark:hover:text-brand',
            )}
            aria-label={active ? 'Stop dictation' : 'Dictate'}
            aria-pressed={active}
            title={active ? 'Stop dictation' : 'Dictate a message'}
            disabled={disabled || dictation.status === 'transcribing'}
            onClick={() => (active ? dictation.stop() : onStart())}
        >
            <Mic size={18} />
        </ChatIconButton>
    );
}

/** m:ss since `since`, ticking. */
function Elapsed({ since }: { since: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.floor((now - since) / 1000));
    return (
        <span className="tabular-nums">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </span>
    );
}

const strip =
    'mt-1 mb-0.5 flex items-center gap-2 rounded-[14px] bg-muted py-1 pr-1.5 pl-3 text-xs/[1.5] text-muted-foreground';
const stripButton = 'h-auto rounded-[9px] px-2 py-1 text-xs font-normal text-foreground/80';

/**
 * Above the composer's text box, as the source link's row is: which way
 * to dictate (the first time, when both work), listening or transcribing
 * with Done and Cancel, or what went wrong.
 */
export function DictationPanel({
    dictation,
    choosing,
    methods,
    onChoose,
    onCloseChooser,
}: {
    dictation: Dictation;
    choosing: boolean;
    methods: readonly DictationMethod[];
    onChoose: (method: DictationMethod) => void;
    onCloseChooser: () => void;
}) {
    if (dictation.status === 'listening') {
        return (
            <div data-slot="dictation-listening" className={strip} role="status">
                <span
                    aria-hidden
                    className="size-2 shrink-0 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none"
                />
                {dictation.heard ? (
                    // Unconfirmed until Done (live text, CB-222): up to three lines,
                    // the newest words in view.
                    <span
                        data-slot="dictation-heard"
                        className="flex max-h-[4.5em] min-w-0 flex-1 flex-col justify-end overflow-hidden break-words"
                    >
                        <span>{dictation.heard}</span>
                    </span>
                ) : (
                    <span className="min-w-0 flex-1 truncate">
                        {dictation.method === 'server' ? 'Recording…' : 'Listening…'}
                    </span>
                )}
                {dictation.startedAt && <Elapsed since={dictation.startedAt} />}
                <ChatIconButton className={stripButton} aria-label="Cancel dictation" onClick={dictation.cancel}>
                    <X size={14} /> Cancel
                </ChatIconButton>
                <ChatIconButton
                    className={cn(stripButton, 'bg-background')}
                    aria-label="Done dictating"
                    onClick={dictation.stop}
                >
                    <Check size={14} /> Done
                </ChatIconButton>
            </div>
        );
    }
    if (dictation.status === 'transcribing') {
        return (
            <div data-slot="dictation-transcribing" className={strip} role="status">
                <LoaderCircle size={14} className="shrink-0 animate-spin motion-reduce:animate-none" />
                {dictation.heard ? (
                    // Live text (CB-222): the preview stays, finishing, until the
                    // recording's text replaces it.
                    <>
                        <span
                            data-slot="dictation-heard"
                            className="flex max-h-[4.5em] min-w-0 flex-1 flex-col justify-end overflow-hidden break-words"
                        >
                            <span>{dictation.heard}</span>
                        </span>
                        <span className="shrink-0">Finishing…</span>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate">Transcribing…</span>
                )}
                <ChatIconButton className={stripButton} aria-label="Cancel dictation" onClick={dictation.cancel}>
                    <X size={14} /> Cancel
                </ChatIconButton>
            </div>
        );
    }
    if (dictation.error) {
        return (
            <div data-slot="dictation-error" role="alert" className={cn(strip, 'bg-destructive/10 text-destructive')}>
                <span className="min-w-0 flex-1">{dictation.error}</span>
                <ChatIconButton
                    aria-label="Dismiss"
                    className="text-destructive/80 hover:text-destructive"
                    onClick={dictation.dismissError}
                >
                    <X size={14} />
                </ChatIconButton>
            </div>
        );
    }
    if (choosing) {
        return (
            <div
                data-slot="dictation-chooser"
                role="group"
                aria-label="How to dictate"
                className="mt-1 mb-0.5 grid gap-1.5 rounded-[14px] bg-muted p-2 text-xs/[1.5]"
            >
                <div className="flex items-center justify-between gap-2 pl-1 text-muted-foreground">
                    <span>How should speech become text?</span>
                    <ChatIconButton aria-label="Close" onClick={onCloseChooser}>
                        <X size={14} />
                    </ChatIconButton>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                    {methods.map((method) => (
                        <button
                            key={method}
                            type="button"
                            data-method={method}
                            className="grid gap-0.5 rounded-[10px] border border-input bg-background px-3 py-2 text-left hover:border-ring/60 focus-visible:outline-2 focus-visible:outline-ring"
                            onClick={() => onChoose(method)}
                        >
                            <span className="font-medium text-foreground">{DICTATION_LABELS[method]}</span>
                            <span className="text-muted-foreground">{DICTATION_NOTES[method]}</span>
                        </button>
                    ))}
                </div>
                <p className="m-0 pl-1 text-muted-foreground">You can change this in Settings → Account → Profile.</p>
            </div>
        );
    }
    return null;
}
