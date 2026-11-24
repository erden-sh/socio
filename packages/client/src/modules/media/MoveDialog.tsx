import { useState, type FormEvent } from 'react';

import { dotFolderId, fieldClass, folderLabel } from './media-api';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

// The data space's path segment rule (FILE_SEGMENT), checked again there.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

/**
 * Where a file or folder goes: a folder from the tree and a name. Moving a
 * file, renaming it, renaming or moving a folder, and naming a new folder
 * are all this dialog; `onSubmit` gets the full new path (a folder's ends
 * in `/`).
 */
export function MoveDialog({
    title,
    description,
    submitLabel = 'Move',
    folders,
    initialFolder,
    initialName,
    folder: isFolder = false,
    exclude,
    dotName,
    onClose,
    onSubmit,
}: {
    title: string;
    description?: string;
    submitLabel?: string;
    folders: readonly string[];
    initialFolder: string;
    initialName: string;
    /** The target is a folder (its path ends in `/`). */
    folder?: boolean;
    /** A folder being moved: it and its subfolders can't be the target. */
    exclude?: string;
    dotName: (id: string) => string | undefined;
    onClose: () => void;
    onSubmit: (path: string) => Promise<void>;
}) {
    const [parent, setParent] = useState(initialFolder);
    const [name, setName] = useState(initialName);
    const [busy, setBusy] = useState(false);
    const choices = ['', ...folders.filter((path) => !exclude || !path.startsWith(exclude))];
    if (!choices.includes(parent)) {
        choices.push(parent);
    }
    const valid = SEGMENT.test(name.trim()) && !/^\.+$/.test(name.trim());
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!valid) {
            return;
        }
        setBusy(true);
        try {
            await onSubmit(`${parent}${name.trim()}${isFolder ? '/' : ''}`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent data-slot="media-move-dialog">
                <form className="grid gap-4" onSubmit={submit}>
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>
                    <label className="grid gap-1 text-sm">
                        <span className="font-medium">Folder</span>
                        <select
                            data-slot="media-move-folder"
                            aria-label="Folder"
                            className={fieldClass}
                            value={parent}
                            onChange={(event) => setParent(event.target.value)}
                        >
                            {choices.map((path) => (
                                <option key={path || '/'} value={path}>
                                    {!path
                                        ? 'All files (top level)'
                                        : dotFolderId(path)
                                          ? `${path} (${folderLabel(path, dotName)})`
                                          : path}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="grid gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input
                            aria-label="Name"
                            value={name}
                            maxLength={128}
                            autoFocus
                            onChange={(event) => setName(event.target.value)}
                        />
                        {name.trim() && !valid && (
                            <small className="text-xs text-destructive">
                                Use letters, digits, spaces, . _ and -, starting with a letter or digit.
                            </small>
                        )}
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !valid}>
                            {submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
