import { useState } from 'react';
import { toast } from 'sonner';

import type { Page, PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

import { api } from '../../lib/api';

import { subpagesOf } from './DeletePageDialog';

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

type PageNode = Pick<PageSummary, 'id' | 'spaceId' | 'parentId' | 'title' | 'createdBy'>;

const titleOf = (page: Pick<PageSummary, 'title'>) => page.title.trim() || 'Untitled page';

/**
 * "Move to…" (CB-142): picks another Space for a page, which goes with its
 * subpages, its link and its history. Anyone may move a page between
 * Spaces they can edit; the server checks again. Unsaved changes are saved
 * first (`beforeMove`), so nothing typed stays behind.
 */
export function MovePageDialog({
    page,
    pages,
    spaces,
    open,
    onOpenChange,
    beforeMove,
    onMoved,
}: {
    page: PageNode;
    pages: PageNode[];
    /** The workspace's Spaces, the page's own included. */
    spaces: Space[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Saves the draft; false when it could not be saved. */
    beforeMove: () => Promise<boolean>;
    /** The page where it is now, and the ids of every page that moved. */
    onMoved: (page: Page, moved: string[]) => void;
}) {
    const targets = spaces.filter((space) => space.id !== page.spaceId);
    const [to, setTo] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const subpages = subpagesOf(page, pages);
    const title = titleOf(page);
    const chosen = targets.find((space) => space.id === to) ?? targets[0];
    const move = async () => {
        if (!chosen) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            if (!(await beforeMove())) {
                setError('Your latest changes could not be saved. Save them, then move the page.');
                return;
            }
            const result = await api<{ page: Page; moved: string[] }>(
                `/spaces/${encodeURIComponent(page.spaceId)}/pages/${encodeURIComponent(page.id)}/move`,
                'POST',
                { spaceId: chosen.id },
            );
            onOpenChange(false);
            toast.success(`Moved “${title}” to ${chosen.name}`);
            onMoved(result.page, result.moved);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not move the page.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (busy) {
                    return;
                }
                setError('');
                onOpenChange(next);
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Move “{title}”</AlertDialogTitle>
                    <AlertDialogDescription>
                        {targets.length
                            ? `It goes to the top of the Space you pick${subpages.length ? `, with its ${subpages.length === 1 ? 'subpage' : `${subpages.length} subpages`}` : ''}. Its history goes with it, and links to it keep working.`
                            : 'There is no other Space to move it to.'}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {targets.length > 0 && (
                    <label className="flex flex-col gap-2 text-xs">
                        Move to
                        <select
                            autoFocus
                            data-slot="native-select"
                            aria-label="Destination Space"
                            className="w-full min-w-0 rounded-[9px] border border-input bg-background p-[9px] text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-xs dark:bg-input/30"
                            value={chosen?.id ?? ''}
                            disabled={busy}
                            onChange={(event) => setTo(event.target.value)}
                        >
                            {targets.map((space) => (
                                <option key={space.id} value={space.id}>
                                    {space.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {subpages.length > 0 && (
                    <ul aria-label="Subpages moved with it" className="max-h-32 list-disc overflow-auto pl-5 text-sm">
                        {subpages.map((item) => (
                            <li key={item.id}>{titleOf(item)}</li>
                        ))}
                    </ul>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button disabled={busy || !chosen} onClick={() => void move()}>
                        {busy ? 'Moving…' : subpages.length ? 'Move pages' : 'Move page'}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
