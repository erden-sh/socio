import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** What goes with a deleted Space, in the dialog's words. */
export const DELETED_WITH_SPACE = [
    'Its pages and their history',
    'Page chats and Ask chats about its pages, for everyone',
    'Its shared memory',
    'Apps, datasets and link cards shared with it (their owners keep them)',
    'Socios’ access to it',
] as const;

/**
 * Who may delete a Space (CB-277): a private one's editors, and admins any
 * Space. The server checks again.
 */
export const canDeleteSpace = (space: Pick<Space, 'private' | 'access'>, admin: boolean) =>
    admin || (space.access === 'editor' && !!space.private);

/**
 * Confirms deleting a Space (CB-277), naming what goes with it, by typing
 * its name. Nothing is deleted until **Delete Space**; Escape and Cancel
 * keep it. Deleted, it is gone for everyone until an admin restores it.
 */
export function DeleteSpaceDialog({
    space,
    open,
    onOpenChange,
    onDeleted,
}: {
    space: Pick<Space, 'id' | 'name'>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void | Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [typed, setTyped] = useState('');
    const field = useId();
    const input = useRef<HTMLInputElement>(null);
    const name = space.name.trim();
    const matches = typed.trim() === name;
    const close = (next: boolean) => {
        if (busy) {
            return;
        }
        setError('');
        setTyped('');
        onOpenChange(next);
    };
    const remove = async () => {
        if (!matches || busy) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            await api(`/spaces/${encodeURIComponent(space.id)}`, 'DELETE');
            toast.success(`Deleted “${name}”`);
            setTyped('');
            onOpenChange(false);
            await onDeleted();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not delete the Space.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <AlertDialog open={open} onOpenChange={close}>
            <AlertDialogContent
                data-slot="delete-space"
                className="max-h-[85svh] overflow-y-auto"
                // The name field first: typing it is the next step, and nothing
                // is deleted until it matches.
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    input.current?.focus();
                }}
            >
                <form
                    className="grid gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void remove();
                    }}
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle className="break-words">Delete “{name}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            It’s removed for everyone at once, and these go with it:
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <ul aria-label="Deleted with it" className="list-disc pl-5 text-sm leading-relaxed">
                        {DELETED_WITH_SPACE.map((item) => (
                            <li key={item}>{item}</li>
                        ))}
                    </ul>
                    <p className="text-sm text-muted-foreground">
                        Nothing is erased: a workspace admin can restore it, with everything in it, from Settings →
                        Deleted Spaces.
                    </p>
                    <div className="grid gap-1.5">
                        <label htmlFor={field} className="text-sm font-medium">
                            Type <strong className="break-words">{name}</strong> to confirm
                        </label>
                        <Input
                            ref={input}
                            id={field}
                            value={typed}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={busy}
                            onChange={(event) => setTyped(event.target.value)}
                        />
                    </div>
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel type="button" disabled={busy}>
                            Cancel
                        </AlertDialogCancel>
                        <Button type="submit" variant="destructive" disabled={busy || !matches}>
                            {busy ? 'Deleting…' : 'Delete Space'}
                        </Button>
                    </AlertDialogFooter>
                </form>
            </AlertDialogContent>
        </AlertDialog>
    );
}
