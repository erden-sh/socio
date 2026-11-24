import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

import { plannerCall } from './api';
import type { PlannerState } from './types';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function VoiceRail({
    notes,
    open,
    onOpenChange,
    onSaved,
    onError,
}: {
    notes: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (state: PlannerState) => void;
    onError: (message: string) => void;
}) {
    return (
        <aside
            id="voice-rail"
            aria-label="Voice guide"
            className={cn('hidden shrink-0 border-l bg-card lg:flex lg:flex-col', open ? 'w-72' : 'w-12')}
        >
            <div className="flex items-center justify-between gap-2 p-2">
                {open && <h2 className="px-1 text-sm font-semibold">Voice</h2>}
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-expanded={open}
                    aria-controls="voice-notes"
                    onClick={() => onOpenChange(!open)}
                >
                    {open ? <PanelRightClose /> : <PanelRightOpen />}
                    <span className="sr-only">{open ? 'Hide voice guide' : 'Show voice guide'}</span>
                </Button>
            </div>
            {open && (
                <VoiceForm id="voice-notes" notes={notes} onSaved={onSaved} onError={onError} className="px-3 pb-3" />
            )}
        </aside>
    );
}

export function VoiceSheet({
    notes,
    open,
    onOpenChange,
    onSaved,
    onError,
}: {
    notes: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: (state: PlannerState) => void;
    onError: (message: string) => void;
}) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full sm:max-w-sm">
                <SheetHeader>
                    <SheetTitle>Voice</SheetTitle>
                    <SheetDescription>Tone notes beside the editor. They stay in Socio.</SheetDescription>
                </SheetHeader>
                <VoiceForm id="voice-notes-sheet" notes={notes} onSaved={onSaved} onError={onError} />
            </SheetContent>
        </Sheet>
    );
}

function VoiceForm({
    id,
    notes,
    onSaved,
    onError,
    className,
}: {
    id: string;
    notes: string;
    onSaved: (state: PlannerState) => void;
    onError: (message: string) => void;
    className?: string;
}) {
    const [text, setText] = useState(notes);
    const [busy, setBusy] = useState(false);
    useEffect(() => setText(notes), [notes]);
    return (
        <div className={cn('flex min-h-0 flex-1 flex-col gap-3', className)}>
            <p className="text-xs text-muted-foreground">Tone notes beside the editor. They stay in Socio.</p>
            <Textarea
                id={id}
                value={text}
                className="min-h-40 flex-1"
                aria-label="Voice notes"
                onChange={(event) => setText(event.target.value)}
            />
            <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                    setBusy(true);
                    plannerCall<PlannerState>('PUT', '/api/voice', { notes: text })
                        .then(onSaved)
                        .catch((reason) =>
                            onError(reason instanceof Error ? reason.message : 'Could not save the voice.'),
                        )
                        .finally(() => setBusy(false));
                }}
            >
                Save voice
            </Button>
        </div>
    );
}
