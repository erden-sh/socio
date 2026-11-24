import { useState } from 'react';
import { toast } from 'sonner';

import type { PageSummary } from '@socio/shared/pages/page-library';
import { isAdmin } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

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

/**
 * Who may delete a page: admins any page, members the
 * pages they created. The server checks again, subpages included.
 */
export const canDeletePage = (user: User | undefined, page: Pick<PageSummary, 'createdBy'>) =>
    isAdmin(user) || (!!user && page.createdBy === user.id);

/** A page as the dialog needs it: a full page or the list's summary. */
type PageNode = Pick<PageSummary, 'id' | 'spaceId' | 'parentId' | 'title' | 'createdBy'>;

/** A page's subpages, at any depth, in tree order. */
export function subpagesOf(page: PageNode, pages: PageNode[]): PageNode[] {
    const tree = [page];
    for (let i = 0; i < tree.length; i++) {
        tree.push(...pages.filter((item) => item.parentId === tree[i].id));
    }
    return tree.slice(1);
}

const titleOf = (page: Pick<PageSummary, 'title'>) => page.title.trim() || 'Untitled page';

/**
 * Confirms deleting a page, naming it and the subpages that go with it.
 * Nothing is deleted until **Delete page**; Escape and Cancel keep it.
 */
export function DeletePageDialog({
    page,
    pages,
    open,
    onOpenChange,
    onDeleted,
}: {
    page: PageNode;
    pages: PageNode[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The ids of the pages deleted (the page and its subpages). */
    onDeleted: (ids: string[]) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const subpages = subpagesOf(page, pages);
    const title = titleOf(page);
    const remove = async () => {
        setBusy(true);
        setError('');
        try {
            const { deleted } = await api<{ deleted: string[] }>(
                `/spaces/${encodeURIComponent(page.spaceId)}/pages/${encodeURIComponent(page.id)}${subpages.length ? '?subpages=true' : ''}`,
                'DELETE',
            );
            onOpenChange(false);
            toast.success(`Deleted “${title}”`);
            onDeleted(deleted);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not delete the page.');
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
                    <AlertDialogTitle>Delete “{title}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {subpages.length
                            ? `Its ${subpages.length === 1 ? 'subpage' : `${subpages.length} subpages`} will be deleted with it. `
                            : ''}
                        It&apos;s removed for everyone in this Space, and links to it say it was deleted. Conversations
                        about it stay in your chats.
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {subpages.length > 0 && (
                    <ul aria-label="Subpages deleted with it" className="max-h-32 list-disc overflow-auto pl-5 text-sm">
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
                    <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
                        {busy ? 'Deleting…' : subpages.length ? 'Delete pages' : 'Delete page'}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
