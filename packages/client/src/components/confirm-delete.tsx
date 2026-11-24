import { useState, type ReactNode } from 'react';

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

/**
 * Confirms a delete the way ChatGPT does: a title that asks ("Delete
 * job?"), a line saying what goes, and a destructive **Delete**. Nothing
 * happens until it is pressed; Escape and Cancel keep everything.
 */
export function ConfirmDelete({
    title,
    children,
    onClose,
    onConfirm,
    slot = 'confirm-delete',
    action = 'Delete',
    disabled = false,
    variant = 'destructive',
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    /** The dialog's `data-slot`, for tests and smoke scenarios. */
    slot?: string;
    /** The button's label, when the action has its own name (Unregister). */
    action?: string;
    /** Something stops it now; the text says what. */
    disabled?: boolean;
    /** `default` for a confirmation that removes nothing (Restore). */
    variant?: 'destructive' | 'default';
}) {
    const [busy, setBusy] = useState(false);
    return (
        <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
            <AlertDialogContent data-slot={slot}>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{children}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button
                        variant={variant}
                        disabled={busy || disabled}
                        onClick={async () => {
                            setBusy(true);
                            try {
                                await onConfirm();
                            } finally {
                                setBusy(false);
                            }
                        }}
                    >
                        {action}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
